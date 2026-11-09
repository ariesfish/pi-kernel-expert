import assert from "node:assert/strict";
import test from "node:test";

import { normalizeContract } from "../../extensions/pi-kernel-expert/kernel/contract.ts";
import {
  comparePrecision,
  dtypeUnit,
  formatPrecisionValue,
  precisionThreshold,
} from "../../extensions/pi-kernel-expert/kernel/precision.ts";
import {
  FORCEABLE_RULES,
  HOST_CAUSES,
  PAIR_CAP,
  RULE_IDS,
  applyForce,
  basisMissing,
  cellGroupUncovered,
  collectRefusals,
  formatRefusal,
  harnessGlobMatches,
  harnessTouched,
  hostBound,
  isForceable,
  isRefusalForceable,
  metricNotInReading,
  precisionRegression,
  profileStale,
  readingContractMismatch,
} from "../../extensions/pi-kernel-expert/kernel/refusals.ts";

const GROUPS = [
  { name: "typical", intent: "random normal inputs, the ordinary case" },
  { name: "zero_block", intent: "a fully masked block must not divide by zero" },
  { name: "tail", intent: "a length off the tile boundary must not read past M" },
];

function build(cells = [{ id: "a", dtype: "bf16", groups: GROUPS }, { id: "b", dtype: "bf16", boundary: true }]) {
  const result = normalizeContract({
    objective: "cut latency",
    checkCommand: "bash check.sh",
    benchmarkCommand: "bash bench.sh",
    cells,
    tolerance: { rtol: 1e-2, atol: 1e-3 },
    harnessGlobs: ["goal.sh", "bench/**"],
    calibrateCommand: "bash calibrate.sh",
  });
  assert.deepEqual(result.errors, []);
  return result.contract;
}

/** A reading that covers every cell x group of `build()`, with no groups-cell as `default`. */
function reading(overrides = {}) {
  return {
    contractSha: "b".repeat(64),
    basis: "device",
    hostBoundRatio: 0.02,
    hostBoundVerdict: "ok",
    cells: [
      { id: "a", group: "typical", metric: "latency_us_a_typical", median: 10 },
      { id: "a", group: "zero_block", metric: "latency_us_a_zero_block", median: 10 },
      { id: "a", group: "tail", metric: "latency_us_a_tail", median: 10 },
      { id: "b", group: "default", metric: "latency_us_b_default", median: 20 },
    ],
    ...overrides,
  };
}

const METRICS = { geomean_speedup: 1.2, latency_us_a: 10, latency_us_b: 20 };

function context(overrides = {}) {
  return {
    contract: build(),
    reading: reading(),
    changedFiles: ["kernel/attn.cu"],
    metrics: METRICS,
    profile: null,
    ...overrides,
  };
}

// --- rule 1: basis-missing ---------------------------------------------------

test("basis-missing fires alone when the reading has no basis, and with cell-group-uncovered when there is no reading at all", () => {
  const alone = collectRefusals(context({ reading: reading({ basis: undefined }) }));
  assert.deepEqual(alone.map((entry) => entry.rule), ["basis-missing"], "a full cell x group table with no basis fires one rule");

  const refusals = collectRefusals(context({ reading: null, readingReason: "no reading was passed to the recorder" }));
  assert.deepEqual(refusals.map((entry) => entry.rule), ["basis-missing", "cell-group-uncovered"], "no reading also leaves every pair uncovered");
  const [refusal] = refusals;
  assert.equal(refusal.charged, "run");
  assert.match(refusal.message, /^basis-missing \(charged to the run\)/);
  assert.match(refusal.message, /no reading was passed to the recorder/);
  assert.equal(refusal.fix, "re-run goal.sh on a build that emits a reading block");
});

test("basis-missing fires when the reading carries no basis", () => {
  const refusal = basisMissing(context({ reading: reading({ basis: undefined }) }));
  assert.ok(refusal);
  assert.equal(refusal.rule, "basis-missing");
  assert.equal(refusal.charged, "run");
  assert.match(refusal.message, /no basis \(got null\)/);
});

test("a reading with a basis and full coverage raises no basis refusal", () => {
  assert.equal(basisMissing(context()), null);
});

// --- rule 2: host-bound ------------------------------------------------------

test("host-bound is charged to the candidate and teaches the four causes", () => {
  const refusal = hostBound(context({ reading: reading({ hostBoundRatio: 4.25, hostBoundVerdict: "host_bound" }) }));
  assert.ok(refusal);
  assert.equal(refusal.rule, "host-bound");
  assert.equal(refusal.charged, "candidate");
  assert.match(refusal.message, /^host-bound \(charged to the candidate\)/);
  assert.match(refusal.message, /hostBoundRatio 4\.25/, "the message carries the ratio");
  for (const cause of HOST_CAUSES.split(", ")) {
    assert.match(refusal.message, new RegExp(cause.replace(/[/\\]/g, ".")), `the message names "${cause}"`);
  }
  assert.doesNotMatch(refusal.message, /\n/, "the message is one line");
});

test("an unmeasured reading is refused, charged to the run, never accepted", () => {
  const ctx = context({
    reading: reading({ hostBoundRatio: null, hostBoundVerdict: "unmeasured", hostBoundReason: "the task reported device_ms but no host_enqueue_ms" }),
  });
  const refusals = collectRefusals(ctx);
  assert.deepEqual(refusals.map((entry) => entry.rule), ["host-bound"]);
  assert.equal(refusals[0].charged, "run");
  assert.match(refusals[0].message, /"unmeasured"/);
  assert.match(refusals[0].message, /is not a pass/);
  assert.match(refusals[0].fix, /METRIC device_ms=/);
});

test("a measured reading on a plain basis raises no host-bound refusal", () => {
  assert.equal(hostBound(context()), null);
});

// --- rule 3: harness-touched -------------------------------------------------

test("harness-touched names the matched path and is charged to the candidate", () => {
  const refusal = harnessTouched(context({ changedFiles: ["kernel/attn.cu", "goal.sh"] }));
  assert.ok(refusal);
  assert.equal(refusal.rule, "harness-touched");
  assert.equal(refusal.charged, "candidate");
  assert.match(refusal.message, /^harness-touched \(charged to the candidate\)/);
  assert.match(refusal.message, /goal\.sh/);
  assert.doesNotMatch(refusal.message, /kernel\/attn\.cu/, "a kernel file is the point of a candidate");
});

test("harness-touched honours a glob, and names every matched path", () => {
  const refusal = harnessTouched(context({ changedFiles: ["bench/harness.py", "bench/prep.py", "kernel/attn.cu"] }));
  assert.ok(refusal);
  assert.match(refusal.message, /bench\/harness\.py, bench\/prep\.py/);
});

test("an untouched harness raises no refusal", () => {
  assert.equal(harnessTouched(context({ changedFiles: ["kernel/attn.cu", "notes/idea.md"] })), null);
});

test("the harness glob matches paths the way the contract's matcher does", () => {
  assert.equal(harnessGlobMatches("goal.sh", "goal.sh"), true);
  assert.equal(harnessGlobMatches("goal.sh", "./goal.sh"), true);
  assert.equal(harnessGlobMatches("bench/**", "bench/a/b.py"), true);
  assert.equal(harnessGlobMatches("bench/*.py", "bench/a/b.py"), false);
  assert.equal(harnessGlobMatches("eval/*", "eval/bench.py"), true);
  assert.equal(harnessGlobMatches("eval/*", "evalX/bench.py"), false);
});

// --- rule 4: cell-group-uncovered -------------------------------------------

test("a cell with three groups missing two reports those two pairs, not the cell", () => {
  const refusal = cellGroupUncovered(
    context({
      reading: reading({
        cells: [
          { id: "a", group: "typical", metric: "latency_us_a_typical", median: 10 },
          { id: "b", group: "default", metric: "latency_us_b_default", median: 20 },
        ],
      }),
    }),
  );
  assert.ok(refusal);
  assert.equal(refusal.rule, "cell-group-uncovered");
  assert.equal(refusal.charged, "run");
  assert.match(refusal.message, /a\/zero_block, a\/tail/);
  assert.equal(refusal.message.split("a/zero_block").length - 1, 1, "each missing pair is named once");
  assert.doesNotMatch(refusal.message, /a\/typical/);
  assert.doesNotMatch(refusal.message, /no aggregate/, "the aggregates are present, so the cell is not reported");
  assert.match(refusal.message, /2 cell\/group pair\(s\)/);
});

test("a cell with no groups expects the group default", () => {
  const withoutDefault = cellGroupUncovered(
    context({ reading: reading({ cells: reading().cells.filter((cell) => cell.group !== "default") }) }),
  );
  assert.ok(withoutDefault);
  assert.match(withoutDefault.message, /b\/default/);
  assert.doesNotMatch(withoutDefault.message, /a\//, "only the boundary cell is uncovered");

  assert.equal(cellGroupUncovered(context()), null, "a reading that carries b/default covers the boundary cell");
});

test("a cell with no aggregate METRIC is refused even when every group is present", () => {
  const refusal = cellGroupUncovered(context({ metrics: { geomean_speedup: 1.2, latency_us_a: 10 } }));
  assert.ok(refusal);
  assert.match(refusal.message, /1 cell\(s\) carry no aggregate/);
  assert.match(refusal.message, /b \(METRIC latency_us_b\)/);
  assert.doesNotMatch(refusal.message, /a\/.*no reading entry/);
});

test("the pair list is capped with an 'and N more' tail", () => {
  const many = Array.from({ length: 12 }, (_, index) => ({ name: `g${index}`, intent: `data set ${index}` }));
  const contract = build([{ id: "a", dtype: "bf16", groups: many }]);
  const refusal = cellGroupUncovered({
    contract,
    reading: reading({ cells: [{ id: "a", group: "g0", metric: "latency_us_a_g0", median: 1 }] }),
    changedFiles: [],
    metrics: { geomean_speedup: 1.2, latency_us_a: 1 },
    profile: null,
  });
  assert.ok(refusal);
  assert.match(refusal.message, /11 cell\/group pair\(s\)/);
  assert.match(refusal.message, new RegExp(`and ${11 - PAIR_CAP} more`));
  const listed = refusal.message.split("no reading entry: ")[1].split(" and ")[0].split(", ");
  assert.equal(listed.length, PAIR_CAP);
});

// --- rule 5: profile-stale ---------------------------------------------------

test("profile-stale is charged to the candidate and names both diffs", () => {
  const refusal = profileStale(
    context({
      profile: { runId: "run1", problem: "diff", measuredDiff: "a".repeat(64), currentDiff: "b".repeat(64) },
    }),
  );
  assert.ok(refusal);
  assert.equal(refusal.rule, "profile-stale");
  assert.equal(refusal.charged, "candidate");
  assert.match(refusal.message, /^profile-stale \(charged to the candidate\)/);
  assert.match(refusal.message, /is stale/);
  assert.match(refusal.message, /aaaaaaaaaaaa/);
  assert.match(refusal.message, /bbbbbbbbbbbb/);
  assert.match(refusal.fix, /re-profile/);
});

test("profile-stale covers a profile taken under an older contract", () => {
  const refusal = profileStale(
    context({
      profile: { runId: "run1", problem: "contract", measuredContract: "c".repeat(64), currentContract: "d".repeat(64) },
    }),
  );
  assert.ok(refusal);
  assert.match(refusal.message, /was taken under contract cccccccccccc/);
});

// --- the whole set, and the force rule --------------------------------------

test("every refusal is collected and printed in one block", () => {
  const refusals = collectRefusals({
    contract: build(),
    contractSha: "a".repeat(64),
    reading: reading({
      basis: undefined,
      hostBoundRatio: 3,
      hostBoundVerdict: "host_bound",
      // cell a keeps its groups so the aggregate can be re-derived and disagree;
      // cell b is dropped so the uncovered rule fires too.
      cells: [{ id: "a", group: "typical", median: 4 }],
    }),
    changedFiles: ["goal.sh"],
    metrics: { latency_us_a: 10 },
    precision: unmeasuredPrecision(),
    profile: { runId: "run1", problem: "diff", measuredDiff: "a".repeat(64), currentDiff: "b".repeat(64) },
  });
  assert.deepEqual(refusals.map((entry) => entry.rule), [...RULE_IDS]);
  const printed = refusals.map(formatRefusal).join("\n");
  for (const rule of RULE_IDS) assert.match(printed, new RegExp(`^${rule} \\(charged to the (run|candidate)\\)`, "m"));
  assert.equal(printed.split("\n").length, RULE_IDS.length, "one line per refusal, in one block");
  for (const line of printed.split("\n")) assert.match(line, / Fix: /);
});

test("a reading taken under another contract is refused as run-level", () => {
  const ctx = context({ contractSha: "c".repeat(64) });
  const entry = readingContractMismatch(ctx);
  assert.ok(entry, "must fire");
  assert.equal(entry.rule, "reading-contract-mismatch");
  assert.equal(entry.charged, "run");
  assert.match(entry.message, /taken under contract bbbbbbbbbbbb, this task is cccccccccccc/);
  assert.equal(isForceable("reading-contract-mismatch"), false, "another contract's numbers cannot be forced in");
  assert.equal(readingContractMismatch(context({ contractSha: "b".repeat(64) })), null);
});

test("a claimed cell value that the reading's own groups do not produce is refused", () => {
  // The reading says every group of cell a measured 10; the caller claims 12.
  const ctx = context({ metrics: { geomean_speedup: 1.2, latency_us_a: 12, latency_us_b: 20 } });
  const entry = metricNotInReading(ctx);
  assert.ok(entry, "must fire");
  assert.equal(entry.rule, "metric-not-in-reading");
  assert.equal(entry.charged, "candidate");
  assert.match(entry.message, /a: claimed 12, the reading's 3 group\(s\) give 10/);
  assert.equal(metricNotInReading(context()), null, "the honest fixture passes");
  // A cell the reading never measured is rule 4's business, not this rule's.
  assert.equal(
    metricNotInReading(context({ reading: reading({ cells: [] }), metrics: { latency_us_a: 12 } })),
    null,
  );
});

test("force bypasses the run-level rules only, and lists what it bypassed", () => {
  assert.deepEqual([...FORCEABLE_RULES], ["basis-missing", "host-bound", "cell-group-uncovered"]);
  for (const rule of RULE_IDS) {
    assert.equal(isForceable(rule), FORCEABLE_RULES.includes(rule));
  }
  assert.equal(isForceable("harness-touched"), false);
  assert.equal(isForceable("profile-stale"), false);

  const all = collectRefusals({
    contract: build(),
    reading: null,
    changedFiles: ["goal.sh"],
    metrics: {},
    profile: { runId: "run1", problem: "diff", measuredDiff: "a".repeat(64), currentDiff: "b".repeat(64) },
  });
  const applied = applyForce(all, "the card was contended, I checked the number by hand");
  assert.deepEqual(applied.blocking.map((entry) => entry.rule), ["harness-touched", "profile-stale"]);
  assert.deepEqual(applied.forcedRules, ["basis-missing", "cell-group-uncovered"]);

  const nothingForced = applyForce(all, undefined);
  assert.equal(nothingForced.blocking.length, all.length);
  assert.deepEqual(nothingForced.forcedRules, []);
});

// --- rule 7: precision-regression -------------------------------------------

/**
 * The precision files as `kernel_candidate` reads them: one `max_diff` per
 * group of `build()`'s two cells (cell a has three groups, cell b is a boundary
 * cell measured once as `default`).
 */
function precisionRows(perDtype, { na = [], contract = build() } = {}) {
  const rows = [];
  for (const cell of contract.cells) {
    const names = cell.groups.length > 0 ? cell.groups.map((group) => group.name) : ["default"];
    for (const name of names) {
      const label = `${cell.id}/${name}`;
      if (na.includes(label)) {
        rows.push({ cell: cell.id, group: name, maxDiff: null, raw: "n/a" });
        continue;
      }
      rows.push({ cell: cell.id, group: name, maxDiff: perDtype[cell.dtype], raw: String(perDtype[cell.dtype]) });
    }
  }
  return rows;
}

/** `build()` is two bf16 cells; `values` is applied to that one dtype. */
function calib(dtype, maxDiff) {
  return [{ dtype, key: null, maxDiff }];
}

function comparison({ rows, calibration, dtype = "bf16", contract = build() } = {}) {
  return comparePrecision({
    contract,
    evidence: {
      rows: rows ?? precisionRows({ [dtype]: 1e-3 }, { contract }),
      calibration: calibration === undefined ? calib(dtype, 1e-3) : calibration,
      calibrationReason: null,
    },
  });
}

/** No calibration and no rows: the shape the "all rules" fixture needs. */
function unmeasuredPrecision() {
  return comparePrecision({
    contract: build(),
    evidence: { rows: [], calibration: null, calibrationReason: "no calibration" },
  });
}

// fp32, because its floor (2^-17) is far below the reference error: with bf16's
// 2^-8 floor a 4x error is still under 3 * e_ref + floor, and the floor — not
// the ratio — would decide. That case has its own test below.
const FP32_CELLS = [
  { id: "a", dtype: "fp32", groups: GROUPS },
  { id: "b", dtype: "fp32", boundary: true },
];

test("2x the reference's error passes and 4x is refused, with both errors in the message", () => {
  const contract = build(FP32_CELLS);
  const pass = comparison({ rows: precisionRows({ fp32: 2e-3 }, { contract }), calibration: calib("fp32", 1e-3), contract });
  assert.deepEqual(pass.regressions, [], "2e-3 is under 3 * 1e-3 + the floor");
  assert.equal(precisionRegression(context({ contract, precision: pass })), null);

  const fail = comparison({ rows: precisionRows({ fp32: 4e-3 }, { contract }), calibration: calib("fp32", 1e-3), contract });
  const refusal = precisionRegression(context({ contract, precision: fail }));
  assert.ok(refusal, "4x the reference's own error must be refused");
  assert.equal(refusal.rule, "precision-regression");
  assert.equal(refusal.charged, "candidate");
  assert.equal(refusal.forceable, false, "a measured precision regression is not forceable");
  // The numbers, not just the rule id: e_cand, e_ref, the floor and the threshold.
  assert.match(
    refusal.message,
    /dtype fp32: e_cand 4\.000e-3 > threshold 3\.008e-3 = 3 \* e_ref 1\.000e-3 \+ floor 7\.629e-6 \(max\(ulp\(fp32\), 2\^-17\)\)/,
  );
  assert.match(refusal.message, /4\.00x the reference's own error/);
  assert.match(refusal.message, /worst group\(s\) a\/typical, a\/zero_block, a\/tail, b\/default/);
  assert.match(refusal.message, /^precision-regression \(charged to the candidate\)/);
  assert.match(refusal.fix, /3x the reference's/);
  assert.equal(refusal.forceable, false);
});

test("exactly at the threshold passes: the comparison is >, not >=", () => {
  const eRef = 1e-3;
  const threshold = precisionThreshold(eRef, "bf16");
  assert.equal(threshold, 3 * eRef + 2 ** -8);
  const at = comparison({ rows: precisionRows({ bf16: threshold }), calibration: calib("bf16", eRef) });
  assert.deepEqual(at.regressions, []);
  assert.equal(at.dtypes[0].eCand, at.dtypes[0].threshold);
  assert.equal(precisionRegression(context({ precision: at })), null);

  const past = comparison({ rows: precisionRows({ bf16: threshold * 1.0001 }), calibration: calib("bf16", eRef) });
  assert.equal(past.regressions.length, 1, "one step past the threshold is a regression");
});

test("the dtype floor binds when the reference is exact: fp16 refuses what bf16's bigger floor passes", () => {
  // 1e-3 is above fp16's 2^-11 floor and far below bf16's 2^-8: same error,
  // two verdicts. (A smaller error, e.g. 1e-5, is under both floors and passes
  // on both — the floor only decides at the scale between them.)
  const oneCell = [{ id: "a", dtype: "fp16", boundary: true }];
  const fp16Contract = build(oneCell);
  const fp16 = comparePrecision({
    contract: fp16Contract,
    evidence: {
      rows: [{ cell: "a", group: "default", maxDiff: 1e-3, raw: "0.001" }],
      calibration: calib("fp16", 0),
    },
  });
  const refused = precisionRegression(context({ contract: fp16Contract, precision: fp16 }));
  assert.ok(refused, "e_ref 0 leaves the floor as the only ruler");
  assert.match(refused.message, /e_cand 1\.000e-3 > threshold 4\.883e-4 = 3 \* e_ref 0 \+ floor 4\.883e-4 \(max\(ulp\(fp16\), 2\^-17\)\)/);
  assert.equal(refused.forceable, false, "the floor is the ruler here; the ruler exists");

  const bf16 = comparison({ rows: precisionRows({ bf16: 1e-3 }), calibration: calib("bf16", 0) });
  assert.deepEqual(bf16.regressions, [], "bf16's 2^-8 floor is bigger than the error");
  assert.equal(bf16.dtypes[0].floor, 2 ** -8);
  assert.equal(bf16.dtypes[0].threshold, 2 ** -8);
  assert.equal(precisionRegression(context({ precision: bf16 })), null);

  // 1e-5 is under even the smaller floor, and unreachable by either verdict.
  for (const dtype of ["fp16", "bf16"]) {
    assert.ok(1e-5 < precisionThreshold(0, dtype), `${dtype}'s floor is above 1e-5`);
  }
});

test("a missing calibration is unmeasured and forceable, and the forced record lists the rule", () => {
  const noCalibration = comparison({ rows: precisionRows({ bf16: 4e-3 }), calibration: null });
  assert.deepEqual(noCalibration.regressions, [], "no ruler, no verdict");
  const refusal = precisionRegression(context({ precision: noCalibration }));
  assert.ok(refusal);
  assert.equal(refusal.rule, "precision-regression");
  assert.match(refusal.message, /e_ref is unmeasured/);
  assert.match(refusal.message, /calibration\.json does not exist/);
  assert.equal(refusal.forceable, true, "the missing ruler is a run-side defect");
  assert.match(refusal.fix, /--calibrate/);
  assert.match(refusal.fix, /force_with_reason/);

  const all = collectRefusals(context({ precision: noCalibration }));
  assert.deepEqual(all.map((entry) => entry.rule), ["precision-regression"]);
  const applied = applyForce(all, "the reference cannot be calibrated on this card yet");
  assert.deepEqual(applied.blocking, []);
  assert.deepEqual(applied.forcedRules, ["precision-regression"]);

  // A measured regression never joins the forced set.
  const fp32 = build(FP32_CELLS);
  const measured = comparison({ rows: precisionRows({ fp32: 4e-3 }, { contract: fp32 }), calibration: calib("fp32", 1e-3), contract: fp32 });
  const forcedAnyway = applyForce(collectRefusals(context({ contract: fp32, precision: measured })), "please");
  assert.deepEqual(forcedAnyway.blocking.map((entry) => entry.rule), ["precision-regression"]);
  assert.deepEqual(forcedAnyway.forcedRules, []);
  assert.equal(isRefusalForceable(precisionRegression(context({ contract: fp32, precision: measured }))), false);
});

test("a group whose check printed no max_diff is recorded n/a and skipped, never read as 0", () => {
  const contract = build(FP32_CELLS);
  const skipped = comparison({
    rows: precisionRows({ fp32: 4e-3 }, { na: ["a/tail"], contract }),
    calibration: calib("fp32", 1e-3),
    contract,
  });
  const entry = skipped.dtypes[0];
  assert.equal(entry.groups, 3, "cell a's two numeric rows plus cell b's default");
  assert.equal(entry.skipped, 1);
  assert.deepEqual(skipped.skippedPairs, ["a/tail"]);
  assert.ok(
    skipped.warnings.some((warning) => /recorded n\/a .*not evidence of precision/.test(warning)),
    `n/a must be explained: ${JSON.stringify(skipped.warnings)}`,
  );
  const refusal = precisionRegression(context({ contract, precision: skipped }));
  assert.ok(refusal, "the numeric rows still judge the dtype");
  assert.match(refusal.message, /1 cell\/group row\(s\) recorded n\/a and were not compared \(a\/tail\)/);

  // Every row n/a: nothing to compare, so the gate says unmeasured rather than 0.
  const silent = comparison({
    rows: precisionRows({ fp32: 1e-3 }, { na: ["a/typical", "a/zero_block", "a/tail", "b/default"], contract }),
    calibration: calib("fp32", 1e-3),
    contract,
  });
  assert.equal(silent.dtypes[0].eCand, null);
  assert.deepEqual(silent.regressions, []);
  const unmeasured = precisionRegression(context({ contract, precision: silent }));
  assert.match(unmeasured.message, /holds no number for this dtype/);
  assert.equal(unmeasured.forceable, true);
});

test("an unknown dtype falls back to fp32's floor and names the dtype in a warning", () => {
  const contract = build([{ id: "a", dtype: "bogus128", boundary: true }]);
  const outcome = comparePrecision({
    contract,
    evidence: {
      rows: [{ cell: "a", group: "default", maxDiff: 1e-3, raw: "0.001" }],
      calibration: [{ dtype: "bogus128", key: null, maxDiff: 0 }],
    },
  });
  const entry = outcome.dtypes[0];
  assert.equal(entry.known, false);
  // The dtype's unit falls back to fp32's 2^-23; the floor is still
  // max(ulp, 2^-17), so 2^-17 is what the threshold actually carries — the
  // fallback is the strict choice, never a permissive one.
  assert.equal(dtypeUnit("bogus128").ulp, 2 ** -23);
  assert.equal(entry.floor, 2 ** -17);
  assert.deepEqual(outcome.unknownDtypes, ["bogus128"]);
  assert.ok(
    outcome.warnings.some((warning) => /dtype "bogus128" names no unit in the last place/.test(warning)),
    `the fallback must name the dtype: ${JSON.stringify(outcome.warnings)}`,
  );
  const refusal = precisionRegression(context({ contract, precision: outcome }));
  assert.ok(refusal);
  assert.match(refusal.message, /fp32's 2\^-23, the dtype is unknown/);
  assert.match(refusal.message, /dtype\(s\) bogus128 name no unit in the last place/);
  assert.match(refusal.message, /floor 7\.629e-6/);
  assert.equal(formatPrecisionValue(2 ** -23), "1.192e-7");
});

test("a task that never wired precision is not a refusal: the gate is unarmed", () => {
  const unarmed = comparePrecision({
    contract: normalizeContract({
      objective: "cut latency",
      checkCommand: "bash check.sh",
      benchmarkCommand: "bash bench.sh",
      cells: [{ id: "a", dtype: "bf16", boundary: true }],
      tolerance: { rtol: 1e-2, atol: 1e-3 },
    }).contract,
    evidence: { rows: null, calibration: null },
  });
  assert.equal(unarmed.armed, false);
  assert.deepEqual(unarmed.unmeasured, [], "an unarmed gate judges nothing");
  assert.equal(precisionRegression(context({ precision: unarmed })), null);

  // Evidence on disk arms it even when the contract names no calibrateCommand.
  const armedByFile = comparison({ rows: precisionRows({ bf16: 4e-3 }), calibration: calib("bf16", 1e-3) });
  assert.equal(armedByFile.armed, true);
});

test("a missing (cell, group) row is not this rule's refusal, and is not read as zero either", () => {
  const rows = precisionRows({ bf16: 1e-3 }).filter((row) => !(row.cell === "a" && row.group === "tail"));
  const outcome = comparison({ rows, calibration: calib("bf16", 1e-3) });
  assert.deepEqual(outcome.missingPairs, ["a/tail"]);
  assert.equal(outcome.dtypes[0].groups, 3, "the other rows still count");
  assert.equal(precisionRegression(context({ precision: outcome })), null, "cell-group-uncovered owns a missing pair");
});
