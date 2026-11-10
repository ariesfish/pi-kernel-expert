import assert from "node:assert/strict";
import test from "node:test";

import {
  DIAGNOSIS_CLASSES,
  formatMilestoneSummary,
  parseMilestone,
  validateMilestone,
} from "../../extensions/pi-kernel-expert/kernel/milestone.ts";

/** A milestone with one decision and one diagnosis block; the gate is otherwise clean. */
const BASE = `# Milestone: probe

## 1. Problem and Target
A probe.

## 2. Contract
- basis: device

## 3. DAG and Phase Order
M0.

### M0 Contract
- tile: 1
- smem: none
- warp roles: none
- register budget: 32
- issue order: load, store
- accumulator precision: fp32

### M0 Architecture
#### D0.1 Map consecutive threads
- Action: index by blockIdx * blockDim + threadIdx
- Purpose: one warp request covers four sectors
- Trigger: sectors per request above 4
- Cost: nothing
- Depends on: none

### M0 Gate
- the probe lands [VERIFY: mechanism]

## 4. Dead Ends
- D0.1 | a bigger tile spills | profile:run2

### Diagnosis plateau-1
- class: wrong-decision
- decision: D0.1
- measurement: profile a 4-warp variant at m1024/typical and compare sectors per request
- abandon: the 128x128 tile; it spills before the mapping matters

## 5. Global Gate
The probe holds.

## 6. Rules
One rule.
`;

function model(text = BASE) {
  return parseMilestone(text).model;
}

function problems(text = BASE) {
  return validateMilestone(model(text), {});
}

function only(text, rule) {
  const hits = problems(text).filter((problem) => problem.rule === rule);
  assert.equal(hits.length, 1, `expected one ${rule}, got ${hits.length}: ${JSON.stringify(hits.map((hit) => hit.message))}`);
  return hits[0];
}

function without(field) {
  return BASE.split("\n")
    .filter((line) => !line.startsWith(`- ${field}:`))
    .join("\n");
}

test("a diagnosis block is parsed as its own kind, not as a phase or a decision", () => {
  const parsed = model();
  assert.equal(parsed.diagnoses.length, 1);
  const [diagnosis] = parsed.diagnoses;
  assert.equal(diagnosis.id, "plateau-1");
  assert.deepEqual(
    diagnosis.rows.map((row) => row.key),
    ["class", "decision", "measurement", "abandon"],
  );
  assert.equal(parsed.decisions.length, 1, "a diagnosis invents no decision");
  assert.deepEqual(DIAGNOSIS_CLASSES, ["missing-decision", "wrong-decision", "measurement-defect", "environment"]);
});

test("a complete diagnosis block validates clean", () => {
  assert.deepEqual(problems(), []);
});

test("each required field is refused by name when it is absent or empty", () => {
  for (const field of ["class", "decision", "measurement", "abandon"]) {
    const problem = only(without(field), "diagnosis-missing-field");
    assert.equal(problem.row, "Diagnosis plateau-1");
    assert.match(problem.what, new RegExp(field));

    const empty = only(BASE.replace(new RegExp(`^- ${field}: .*$`, "m"), `- ${field}:`), "diagnosis-missing-field");
    assert.match(empty.what, new RegExp(field));
  }
});

test("a class outside the four is refused with the four named", () => {
  const problem = only(BASE.replace("- class: wrong-decision", "- class: probably-the-tile"), "diagnosis-class");
  assert.match(problem.what, /probably-the-tile/);
  for (const label of DIAGNOSIS_CLASSES) assert.match(problem.what, new RegExp(label));
});

test("a diagnosis with no decision id, or one the milestone does not have, is refused", () => {
  const absent = only(BASE.replace("- decision: D0.1", "- decision: none"), "diagnosis-decision");
  assert.match(absent.what, /D0\.1/);

  const unknown = only(BASE.replace("- decision: D0.1", "- decision: D4.2"), "diagnosis-decision");
  assert.match(unknown.what, /D4\.2/);
  assert.match(unknown.what, /D0\.1/);
});

test("a self-diagnosis is allowed, and has to say why the reviewer was not asked", () => {
  const declared = `${BASE.replace("### Diagnosis plateau-1", "### Diagnosis plateau-1")}`.replace(
    "- abandon: the 128x128 tile; it spills before the mapping matters",
    "- abandon: the 128x128 tile; it spills before the mapping matters\n- self-diagnosis: the agent tool is absent in this session, so the executor re-read its own diff",
  );
  assert.deepEqual(problems(declared), []);

  const blank = declared.replace("- self-diagnosis: the agent tool is absent in this session, so the executor re-read its own diff", "- self-diagnosis:");
  const problem = only(blank, "diagnosis-missing-field");
  assert.match(problem.what, /self-diagnosis/);
});

test("a diagnosis never gates: it cannot stand in for a gate line", () => {
  const noGate = BASE.replace(
    "### M0 Gate\n- the probe lands [VERIFY: mechanism]\n",
    "",
  );
  const problem = only(noGate, "gate-no-mechanism-line");
  assert.equal(problem.row, "milestone");
  assert.match(problem.what, /no gate line at all/);
});

test("the summary lists the diagnoses it found", () => {
  assert.match(formatMilestoneSummary(model()), /Diagnosis plateau-1/);
});
