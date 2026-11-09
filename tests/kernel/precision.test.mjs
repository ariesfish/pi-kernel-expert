import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { readPrecisionEvidence } from "../../extensions/pi-kernel-expert/kernel/candidates.ts";
import { normalizeContract } from "../../extensions/pi-kernel-expert/kernel/contract.ts";
import {
  CALIBRATION_JSON_PATH,
  DTYPE_ULP,
  FLOOR_REL,
  K_RATIO,
  PRECISION_TSV_PATH,
  UNKNOWN_DTYPE_ULP,
  comparePrecision,
  dtypeToken,
  dtypeUnit,
  formatPrecisionValue,
  parseCalibrationJson,
  parsePrecisionTsv,
  precisionFloor,
  precisionThreshold,
} from "../../extensions/pi-kernel-expert/kernel/precision.ts";

const GROUPS = [
  { name: "typical", intent: "random normal inputs, the ordinary case" },
  { name: "zero_block", intent: "a fully masked block must not divide by zero" },
  { name: "tail", intent: "a length off the tile boundary must not read past M" },
];

function contract(cells, overrides = {}) {
  const result = normalizeContract({
    objective: "cut latency",
    checkCommand: "bash check.sh",
    benchmarkCommand: "bash bench.sh",
    cells,
    tolerance: { rtol: 1e-2, atol: 1e-3 },
    calibrateCommand: "bash calibrate.sh",
    ...overrides,
  });
  assert.deepEqual(result.errors, []);
  assert.ok(result.contract);
  return result.contract;
}

/** One cell, three groups, on `dtype`; `values` maps group name → max_diff. */
function oneCell(dtype, values, calibrate = "0.001") {
  const built = contract([{ id: "c", dtype, groups: GROUPS }]);
  const rows = GROUPS.map((group) => ({
    cell: "c",
    group: group.name,
    maxDiff: values[group.name] ?? null,
    raw: values[group.name] === null ? "n/a" : String(values[group.name]),
  }));
  const calibration = calibrate === null ? null : [{ dtype, key: dtypeUnit(dtype).key, maxDiff: Number(calibrate) }];
  return comparePrecision({ contract: built, evidence: { rows, calibration, calibrationReason: null } });
}

// --- the math ---------------------------------------------------------------

test("the unit in the last place is 2^-significand_bits for every dtype in the table", () => {
  assert.equal(DTYPE_ULP.fp64, 2 ** -52);
  assert.equal(DTYPE_ULP.fp32, 2 ** -23);
  assert.equal(DTYPE_ULP.tf32, 2 ** -11);
  assert.equal(DTYPE_ULP.fp16, 2 ** -11);
  assert.equal(DTYPE_ULP.bf16, 2 ** -8);
  assert.equal(DTYPE_ULP.fp8_e4m3, 2 ** -4);
  assert.equal(DTYPE_ULP.fp8_e5m2, 2 ** -3);
  // exact dtypes: no rounding, so the absolute floor is the whole floor
  assert.equal(DTYPE_ULP.int8, 0);
  assert.equal(DTYPE_ULP.uint8, 0);
  assert.equal(DTYPE_ULP.int32, 0);
  assert.equal(FLOOR_REL, 2 ** -17);
  assert.equal(K_RATIO, 3);
  assert.equal(UNKNOWN_DTYPE_ULP, 2 ** -23);
});

test("the floor is max(ulp, 2^-17) and the threshold is 3 * e_ref plus that floor", () => {
  assert.equal(precisionFloor("fp64"), 2 ** -17, "fp64's unit is under the absolute floor");
  assert.equal(precisionFloor("fp32"), 2 ** -17);
  assert.equal(precisionFloor("fp16"), 2 ** -11);
  assert.equal(precisionFloor("bf16"), 2 ** -8);
  assert.equal(precisionFloor("fp8_e4m3"), 2 ** -4);
  assert.equal(precisionFloor("int8"), 2 ** -17, "an exact dtype still gets the absolute floor");

  assert.equal(precisionThreshold(0, "fp32"), 2 ** -17);
  assert.equal(precisionThreshold(1e-3, "fp32"), 3e-3 + 2 ** -17);
  assert.equal(precisionThreshold(1e-3, "bf16"), 3e-3 + 2 ** -8);
  assert.equal(precisionThreshold(2, "bf16"), 6 + 2 ** -8);
});

test("a dtype string is normalized on its leading token, and an unmatched one is named", () => {
  assert.equal(dtypeToken("bf16"), "bf16");
  assert.equal(dtypeToken("bf16*"), "bf16");
  assert.equal(dtypeToken("  BF16  "), "bf16");
  assert.equal(dtypeToken("torch.bfloat16"), "bfloat16");
  assert.equal(dtypeToken("'fp8_e4m3fn'"), "fp8_e4m3fn");
  assert.equal(dtypeToken("float8_e5m2"), "float8_e5m2");
  assert.equal(dtypeToken("!!! "), "");

  assert.deepEqual(dtypeUnit("bf16*"), { key: "bf16", ulp: 2 ** -8, known: true });
  assert.deepEqual(dtypeUnit("bfloat16"), { key: "bf16", ulp: 2 ** -8, known: true });
  assert.deepEqual(dtypeUnit("torch.bfloat16"), { key: "bf16", ulp: 2 ** -8, known: true });
  assert.deepEqual(dtypeUnit("float16"), { key: "fp16", ulp: 2 ** -11, known: true });
  assert.deepEqual(dtypeUnit("float8_e4m3fn"), { key: "fp8_e4m3", ulp: 2 ** -4, known: true });
  assert.deepEqual(dtypeUnit("FP8_E5M2"), { key: "fp8_e5m2", ulp: 2 ** -3, known: true });
  assert.deepEqual(dtypeUnit("uint8"), { key: "uint8", ulp: 0, known: true });

  const unknown = dtypeUnit("fp4_e2m1");
  assert.equal(unknown.known, false);
  assert.equal(unknown.ulp, 2 ** -23, "an unknown dtype is charged fp32's unit, never a permissive one");
  assert.equal(unknown.key, null);
});

test("values print as three significant digits, and a missing one says so", () => {
  assert.equal(formatPrecisionValue(4e-3), "4.000e-3");
  assert.equal(formatPrecisionValue(2 ** -8), "3.906e-3");
  assert.equal(formatPrecisionValue(2 ** -17), "7.629e-6");
  assert.equal(formatPrecisionValue(0), "0");
  assert.equal(formatPrecisionValue(null), "unmeasured");
});

// --- the files --------------------------------------------------------------

test("precision.tsv parses one row per cell x group, and n/a is not a zero", () => {
  const parsed = parsePrecisionTsv(
    [
      "# cell\tgroup\tmax_diff",
      "m1024\ttail\t0.0009765625",
      "m1024\ttypical\t1e-03",
      "m1024\tzero_block\tn/a",
      "m4096\tdefault\t",
      "",
      "broken row without tabs",
    ].join("\n"),
  );
  assert.deepEqual(
    parsed.rows.map((row) => [row.cell, row.group, row.maxDiff]),
    [
      ["m1024", "tail", 0.0009765625],
      ["m1024", "typical", 0.001],
      ["m1024", "zero_block", null],
      ["m4096", "default", null],
    ],
  );
  assert.equal(parsed.rows[2].raw, "n/a");
  assert.equal(parsed.problems.length, 1, "a malformed line is named, not silently dropped");
  assert.match(parsed.problems[0], /is not a cell<TAB>group<TAB>max_diff row/);
});

test("calibration.json reads both the generated entries[] and a hand-written dtypes{} map", () => {
  const generated = parseCalibrationJson(
    JSON.stringify({
      schemaVersion: 1,
      contractSha: "a".repeat(64),
      entries: [
        { dtype: "bf16", maxDiff: 0.0009765625 },
        { dtype: "fp32", maxDiff: null },
      ],
    }),
  );
  assert.equal(generated.ok, true);
  assert.deepEqual(
    generated.entries.map((entry) => [entry.dtype, entry.key, entry.maxDiff]),
    [
      ["bf16", "bf16", 0.0009765625],
      ["fp32", "fp32", null],
    ],
  );

  const handwritten = parseCalibrationJson(JSON.stringify({ dtypes: { bfloat16: 0.001, "fp8_e4m3": "2e-3" } }));
  assert.equal(handwritten.ok, true);
  assert.deepEqual(
    handwritten.entries.map((entry) => [entry.dtype, entry.key, entry.maxDiff]),
    [
      ["bfloat16", "bf16", 0.001],
      ["fp8_e4m3", "fp8_e4m3", 0.002],
    ],
  );

  const broken = parseCalibrationJson("{ not json");
  assert.equal(broken.ok, false);
  assert.match(broken.reason, /not valid JSON/);

  const shapeless = parseCalibrationJson('{"schemaVersion":1}');
  assert.equal(shapeless.ok, false);
  assert.match(shapeless.reason, /neither an entries\[\] array nor a dtypes\{\} map/);
  assert.match(shapeless.reason, /--calibrate/);

  const bad = parseCalibrationJson('{"entries":[{"dtype":"bf16","maxDiff":-1},{"maxDiff":0.1}]}');
  assert.equal(bad.ok, true);
  assert.equal(bad.entries.length, 1, "an entry with no dtype is named and dropped");
  assert.equal(bad.entries[0].maxDiff, null, "a negative error is not a measurement");
  assert.equal(bad.problems.length, 2);
});

// --- the comparison ---------------------------------------------------------

test("e_cand is the worst group's max_diff for that dtype, and e_ref comes from the calibration", () => {
  const outcome = oneCell("fp32", { typical: 1e-4, zero_block: 5e-4, tail: 2e-3 });
  const entry = outcome.dtypes[0];
  assert.equal(entry.groups, 3);
  assert.equal(entry.eCand, 2e-3);
  assert.deepEqual(entry.worst, ["c/tail"]);
  assert.equal(entry.eRef, 0.001);
  assert.equal(entry.floor, 2 ** -17);
  assert.equal(entry.threshold, 3e-3 + 2 ** -17);
  assert.equal(entry.ratio, 2);
  assert.equal(entry.regressed, false, "2x the reference is inside 3x + the floor");
  assert.deepEqual(outcome.regressions, []);
  assert.deepEqual(outcome.unmeasured, []);
  assert.equal(outcome.armed, true);
});

test("4x the reference's error is a regression; 2x is not; exactly at the threshold is not", () => {
  assert.equal(oneCell("fp32", { typical: 2e-3 }).regressions.length, 0, "2e-3 = 2x e_ref");

  const regressed = oneCell("fp32", { typical: 4e-3 });
  assert.equal(regressed.regressions.length, 1);
  assert.equal(regressed.dtypes[0].eCand, 4e-3);
  assert.equal(regressed.dtypes[0].threshold, 3e-3 + 2 ** -17);

  // > and not >=: the threshold is 3 * e_ref + floor, which is "as good as the
  // reference plus its floor", not a regression.
  const threshold = precisionThreshold(1e-3, "fp32");
  assert.equal(oneCell("fp32", { typical: threshold }).regressions.length, 0);
  assert.equal(oneCell("fp32", { typical: threshold + 1e-12 }).regressions.length, 1);
});

test("the dtype floor binds where the reference is exact: fp16 refuses, bf16 does not", () => {
  // Same e_ref 0, same 1e-3 error, two verdicts: 1e-3 is above fp16's 2^-11 and
  // far below bf16's 2^-8. (A 1e-5 error is under both floors and passes on
  // both — the floor decides only between them.)
  const fp16 = oneCell("fp16", { typical: 1e-3 }, "0");
  assert.equal(fp16.dtypes[0].floor, 2 ** -11);
  assert.equal(fp16.regressions.length, 1);
  assert.equal(fp16.dtypes[0].ratio, null, "e_ref 0 has no ratio to print");
  assert.deepEqual(fp16.unmeasured, []);

  const bf16 = oneCell("bf16", { typical: 1e-3 }, "0");
  assert.equal(bf16.dtypes[0].floor, 2 ** -8);
  assert.equal(bf16.regressions.length, 0);

  for (const dtype of ["fp16", "bf16"]) assert.ok(1e-5 < precisionFloor(dtype));
});

test("a missing calibration is unmeasured for that dtype, never defaulted to e_ref 0", () => {
  const outcome = oneCell("fp32", { typical: 4e-3 }, null);
  assert.equal(outcome.armed, true, "the contract named a calibrateCommand");
  assert.equal(outcome.dtypes[0].eRef, null);
  assert.equal(outcome.dtypes[0].threshold, null);
  assert.equal(outcome.dtypes[0].regressed, false, "no ruler, no verdict");
  assert.deepEqual(outcome.unmeasured.map((entry) => entry.dtype), ["fp32"]);
  assert.match(outcome.unmeasured[0].reason, /calibration\.json does not exist/);
  assert.match(outcome.unmeasured[0].reason, /--calibrate/);

  // A calibration that holds the dtype but no number is unmeasured too.
  const nullEntry = oneCell("fp32", { typical: 4e-3 }, "0");
  assert.equal(nullEntry.dtypes[0].eRef, 0);
  const noEntry = comparePrecision({
    contract: contract([{ id: "c", dtype: "fp32", groups: GROUPS }]),
    evidence: {
      rows: [{ cell: "c", group: "typical", maxDiff: 1e-3, raw: "0.001" }],
      calibration: [{ dtype: "bf16", key: "bf16", maxDiff: 0.01 }],
    },
  });
  assert.deepEqual(noEntry.unmeasured.map((entry) => entry.dtype), ["fp32"]);
  assert.match(noEntry.unmeasured[0].reason, /no entry for dtype "fp32"/);
  assert.match(noEntry.unmeasured[0].reason, /it holds bf16/);
});

test("a calibration keyed by an alias (bfloat16) still measures a bf16 cell", () => {
  const outcome = comparePrecision({
    contract: contract([{ id: "c", dtype: "bf16", groups: GROUPS }]),
    evidence: {
      rows: [{ cell: "c", group: "typical", maxDiff: 1e-2, raw: "0.01" }],
      calibration: [{ dtype: "bfloat16", key: "bf16", maxDiff: 1e-4 }],
    },
  });
  assert.equal(outcome.dtypes[0].eRef, 1e-4);
  assert.equal(outcome.regressions.length, 1, "1e-2 against a 1e-4 ruler, past 3e-4 + bf16's 2^-8 floor");
});

test("a row recorded n/a is skipped with a warning, and never read as zero", () => {
  const outcome = oneCell("fp32", { typical: 1e-4, zero_block: 2e-4, tail: null });
  const entry = outcome.dtypes[0];
  assert.equal(entry.groups, 2, "the two numeric rows");
  assert.equal(entry.skipped, 1);
  assert.deepEqual(outcome.skippedPairs, ["c/tail"]);
  assert.deepEqual(outcome.regressions, [], "1e-4 and 2e-4 are far under the threshold");
  assert.equal(entry.eCand, 2e-4, "the max over the rows that exist, not 0 for the missing one");
  assert.ok(
    outcome.warnings.some((warning) => /1 cell\/group row\(s\) recorded n\/a \(c\/tail\).*not evidence of precision/.test(warning)),
    `the warning must name the row: ${JSON.stringify(outcome.warnings)}`,
  );

  const silent = oneCell("fp32", { typical: null, zero_block: null, tail: null });
  assert.equal(silent.dtypes[0].eCand, null);
  assert.deepEqual(silent.unmeasured.map((row) => row.dtype), ["fp32"]);
  assert.match(silent.unmeasured[0].reason, /holds no number for this dtype/);
});

test("an unknown dtype falls back to fp32's unit and is named in the warnings", () => {
  const outcome = oneCell("bogus128", { typical: 1e-3 }, "0");
  const entry = outcome.dtypes[0];
  assert.equal(entry.known, false);
  assert.equal(entry.floor, 2 ** -17, "max(2^-23, 2^-17): the absolute floor still applies");
  assert.deepEqual(outcome.unknownDtypes, ["bogus128"]);
  assert.ok(outcome.warnings.some((warning) => /"bogus128" names no unit in the last place/.test(warning)));
  assert.ok(outcome.warnings.some((warning) => /fp32's 2\^-23 = 1\.192e-7/.test(warning)));

  // Two dtypes, one known: the warning names the unmatched one only.
  const mixed = comparePrecision({
    contract: contract([
      { id: "a", dtype: "bf16", groups: GROUPS },
      { id: "b", dtype: "fp4_e2m1", boundary: true },
    ]),
    evidence: {
      rows: [
        { cell: "a", group: "typical", maxDiff: 1e-4, raw: "1e-4" },
        { cell: "b", group: "default", maxDiff: 1e-4, raw: "1e-4" },
      ],
      calibration: [
        { dtype: "bf16", key: "bf16", maxDiff: 1e-4 },
        { dtype: "fp4_e2m1", key: null, maxDiff: 1e-4 },
      ],
    },
  });
  assert.deepEqual(mixed.unknownDtypes, ["fp4_e2m1"]);
  assert.deepEqual(mixed.unmeasured, [], "both dtypes are calibrated");
});

test("a missing (cell, group) row is listed but never turned into a precision refusal", () => {
  const outcome = comparePrecision({
    contract: contract([{ id: "c", dtype: "fp32", groups: GROUPS }]),
    evidence: {
      rows: [
        { cell: "c", group: "typical", maxDiff: 1e-4, raw: "1e-4" },
        { cell: "c", group: "zero_block", maxDiff: 1e-4, raw: "1e-4" },
      ],
      calibration: [{ dtype: "fp32", key: "fp32", maxDiff: 1e-3 }],
    },
  });
  assert.deepEqual(outcome.missingPairs, ["c/tail"]);
  assert.deepEqual(outcome.regressions, [], "the pairs that were measured are precise");
  assert.deepEqual(outcome.unmeasured, [], "one dtype still has numbers, so it is judged");
});

test("a task with no calibrateCommand and no precision files is unarmed, not refused", () => {
  const unarmed = comparePrecision({
    contract: contract([{ id: "c", dtype: "bf16", groups: GROUPS }], { calibrateCommand: undefined }),
    evidence: { rows: null, calibration: null },
  });
  assert.equal(unarmed.armed, false);
  assert.deepEqual(unarmed.unmeasured, [], "nothing to judge: the check printed no max_diff");
  assert.deepEqual(unarmed.dtypes.map((entry) => entry.eCand), [null]);

  // A v2 contract written before calibrateCommand existed has no such key at
  // all; that is still unarmed, not "armed with an absent ruler".
  const preTicket = { ...contract([{ id: "c", dtype: "bf16", groups: GROUPS }]) };
  delete preTicket.calibrateCommand;
  const legacy = comparePrecision({ contract: preTicket, evidence: { rows: null, calibration: null } });
  assert.equal(legacy.armed, false, "a contract file without the key is unarmed");
  assert.deepEqual(legacy.unmeasured, []);

  const armedByRows = comparePrecision({
    contract: contract([{ id: "c", dtype: "bf16", groups: GROUPS }], { calibrateCommand: undefined }),
    evidence: { rows: [{ cell: "c", group: "typical", maxDiff: 1e-4, raw: "1e-4" }], calibration: null },
  });
  assert.equal(armedByRows.armed, true, "evidence on disk arms the gate even without a calibrateCommand");
});

// --- the reader -------------------------------------------------------------

function workspaceWith(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kernel-expert-precision-"));
  fs.mkdirSync(path.join(root, ".kernel"), { recursive: true });
  for (const [relative, body] of Object.entries(files)) {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
  }
  return root;
}

test("readPrecisionEvidence reads both files and reports each absence by name", () => {
  const full = workspaceWith({
    [PRECISION_TSV_PATH]: "# cell\tgroup\tmax_diff\nc\ttail\t0.004\nc\ttypical\tn/a\n",
    [CALIBRATION_JSON_PATH]: JSON.stringify({ schemaVersion: 1, entries: [{ dtype: "fp32", maxDiff: 0.001 }] }),
  });
  const evidence = readPrecisionEvidence(full);
  assert.equal(evidence.rows?.length, 2);
  assert.deepEqual(evidence.rows?.map((row) => [row.group, row.maxDiff]), [["tail", 0.004], ["typical", null]]);
  assert.equal(evidence.calibration?.[0].maxDiff, 0.001);
  assert.equal(evidence.calibrationReason, null);

  const empty = readPrecisionEvidence(workspaceWith({}));
  assert.equal(empty.rows, null, "an absent file is null, never an empty table");
  assert.equal(empty.calibration, null);
  assert.match(empty.calibrationReason, /does not exist/);

  const broken = readPrecisionEvidence(workspaceWith({ [CALIBRATION_JSON_PATH]: "{ nope" }));
  assert.equal(broken.calibration, null);
  assert.match(broken.calibrationReason, /not valid JSON/);
});
