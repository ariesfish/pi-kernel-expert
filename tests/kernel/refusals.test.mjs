import assert from "node:assert/strict";
import test from "node:test";

import { normalizeContract } from "../../extensions/pi-kernel-expert/kernel/contract.ts";
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
  metricNotInReading,
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
