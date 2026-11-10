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
- measurement: \`ncu --set full -k probe -c 1 ./goal.sh a typical\` => the epilogue holds its share means missing-decision, ldmatrix dominates means wrong-decision
- abandon: the 128x128 tile; it spills before the mapping matters
- citations: candidates.jsonl#C3, profile/run1/summary.json:1, loop-log.txt:12

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
    ["class", "decision", "measurement", "abandon", "citations"],
  );
  assert.equal(parsed.decisions.length, 1, "a diagnosis invents no decision");
  assert.deepEqual(DIAGNOSIS_CLASSES, ["missing-decision", "wrong-decision", "measurement-defect", "environment"]);
});

test("a complete diagnosis block validates clean", () => {
  assert.deepEqual(problems(), []);
});

test("each required field is refused by name when it is absent or empty", () => {
  for (const field of ["class", "decision", "measurement", "abandon", "citations"]) {
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

test("a measurement with no runnable command is refused: it is a hypothesis wearing a measurement's clothes", () => {
  const prose = BASE.replace(
    "- measurement: `ncu --set full -k probe -c 1 ./goal.sh a typical` => the epilogue holds its share means missing-decision, ldmatrix dominates means wrong-decision",
    "- measurement: profile a 4-warp variant and compare sectors per request",
  );
  const problem = only(prose, "diagnosis-measurement");
  assert.match(problem.what, /command/);
  assert.match(problem.what, /backtick/);
});

test("a measurement has to say which classes its outcomes separate", () => {
  const noOutcome = BASE.replace(
    " => the epilogue holds its share means missing-decision, ldmatrix dominates means wrong-decision",
    "",
  );
  const problem = only(noOutcome, "diagnosis-measurement");
  assert.match(problem.what, /outcome|means/i);
});

test("three citations are the floor, and each one has to be a reference a reader can open", () => {
  const two = only(BASE.replace("- citations: candidates.jsonl#C3, profile/run1/summary.json:1, loop-log.txt:12", "- citations: candidates.jsonl#C3, loop-log.txt:12"), "diagnosis-citation");
  assert.match(two.what, /three|3/);

  const shape = only(BASE.replace("- citations: candidates.jsonl#C3, profile/run1/summary.json:1, loop-log.txt:12", "- citations: candidates.jsonl#C3, profile/run1/summary.json:1, the loop log somewhere"), "diagnosis-citation");
  assert.match(shape.what, /the loop log somewhere/);
});

test("a citation the resolver cannot open is refused with the resolver's reason", () => {
  const resolved = (ref) => (ref.path === "loop-log.txt" ? "loop-log.txt has 12 lines; line 40 is past the end" : null);
  const hits = validateMilestone(model(), { citationResolver: resolved }).filter((problem) => problem.rule === "diagnosis-citation");
  assert.equal(hits.length, 1);
  assert.match(hits[0].what, /past the end/);
  assert.equal(hits[0].row, "Diagnosis plateau-1");
});

test("missing-decision names a decision that does not exist yet, and that is the whole point", () => {
  const add = BASE.replace("- class: wrong-decision", "- class: missing-decision").replace("- decision: D0.1", "- decision: D0.3 repartition the accumulator so the fusion fits the register budget");
  assert.deepEqual(problems(add), [], "a new id is what missing-decision means");

  // The same class naming a decision the plan already has is a contradiction.
  const existing = BASE.replace("- class: wrong-decision", "- class: missing-decision");
  const problem = only(existing, "diagnosis-decision");
  assert.match(problem.what, /already/i);
  assert.match(problem.what, /D0\.1/);
});

test("a diagnosis names one decision, not a list", () => {
  const two = BASE.replace("- decision: D0.1", "- decision: D0.1+D0.2");
  const problem = only(two, "diagnosis-decision");
  assert.match(problem.what, /one decision/);
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

test("through the tool: a citation that names a line past the end is refused, and so is a missing file", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const kernelExpertExtension = (await import("../../extensions/pi-kernel-expert/index.ts")).default;
  const { fakeCommandContext, fakePi } = await import("../helpers/fake-host.mjs");

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kernel-expert-diagnosis-"));
  fs.mkdirSync(path.join(root, "docs"));
  fs.mkdirSync(path.join(root, "profile", "run1"), { recursive: true });
  fs.writeFileSync(path.join(root, "profile", "run1", "summary.json"), "{}\n");
  fs.writeFileSync(path.join(root, "candidates.jsonl"), '{"id":"C3"}\n');
  fs.writeFileSync(path.join(root, "loop-log.txt"), "one\ntwo\n");
  fs.writeFileSync(path.join(root, "docs", "milestone.md"), BASE);

  const pi = fakePi();
  kernelExpertExtension(pi);
  const { ctx } = fakeCommandContext({ cwd: root });
  const run = async (text) => {
    fs.writeFileSync(path.join(root, "docs", "milestone.md"), text);
    return pi.tools.get("kernel_milestone").execute("call", {}, undefined, undefined, ctx);
  };

  const ok = await run(BASE.replace("loop-log.txt:12", "loop-log.txt:2"));
  assert.equal(ok.details.ok, true, ok.content[0].text);

  const pastEnd = await run(BASE);
  assert.equal(pastEnd.details.ok, false);
  assert.match(pastEnd.content[0].text, /loop-log\.txt has 2 line\(s\); line 12 is past the end/);

  const missing = await run(BASE.replace("loop-log.txt:12", "no-such-log.txt:1"));
  assert.match(missing.content[0].text, /there is no no-such-log\.txt in this workspace/);

  const anchor = await run(BASE.replace("candidates.jsonl#C3", "candidates.jsonl#C9"));
  assert.match(anchor.content[0].text, /contains no "C9"/);
});

test("a diagnosis block is not a dead end: its rows ban no combination", () => {
  const parsed = model();
  assert.deepEqual(
    parsed.deadEnds.map((row) => row.split("|")[0].trim()),
    ["D0.1"],
    "the diagnosis under Dead Ends does not count as a banned bundle",
  );
});
