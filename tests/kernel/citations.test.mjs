import assert from "node:assert/strict";
import test from "node:test";

import { CONFIDENCE_LABELS, readCorpusIndex } from "../../extensions/pi-kernel-expert/kernel/corpus-index.ts";
import { KERNEL_WIKI_PIN } from "../../extensions/pi-kernel-expert/support/paths.ts";
import { parseMilestone, validateMilestone } from "../../extensions/pi-kernel-expert/kernel/milestone.ts";

const MILESTONE = `# Milestone: fused attention

## 1. Problem and Target
Decode attention on an H200 is memory bound.

## 2. Contract
- basis: device
- cells: m1024, m4096
- groups: typical, tail

## 3. DAG and Phase Order
M0 Contract, then M0 Architecture.

### M0 Contract
- tile: 128x128 fp16 smem
- smem: 64 KiB, 2 stages
- warp roles: 4 warps mma, 4 warps copy
- register budget: 168
- issue order: cp.async, ldmatrix, mma
- accumulator precision: fp32

### M0 Architecture
#### D0.1 Stage the tile through cp.async
- Action: move the tile load to cp.async with two stages
- Purpose: overlap the global load with the mma
- Trigger: ncu reports long scoreboard above 40% on m1024/typical
- Cost: one day, one extra buffer
- Depends on: none

### M0 Gate
- device_ms halves on m1024/typical with the checks still green [VERIFY: ncu-direct profile:run1]
- every cell/group still matches the reference [VERIFY: correctness cell-group: m1024/typical]
- the inner loop issues two LDG per 128 B [VERIFY: sass-derived][PRICED: -8% issue slots, profile:run2]
- the two-stage pipeline hides the load [VERIFY: mechanism]

## 4. Dead Ends
- D0.1 | a 256x128 tile spills 190 registers | profile:run2

## 5. Global Gate
Both phase gates hold on every cell and group.

## 6. Rules
A decision is a five-tuple.
`;

const CONTRACT = {
  schemaVersion: 2,
  cells: [
    { id: "m1024", dtype: "fp16", vars: {}, boundary: false, groups: [
      { name: "typical", intent: "the shape the task reports" },
      { name: "tail", intent: "the ragged tail" },
      { name: "cold", intent: "not in L2" },
    ] },
  ],
};

const CORPUS = {
  pin: KERNEL_WIKI_PIN,
  dir: "/tmp/kernel-wiki",
  pages: [
    { id: "migration-wgmma-to-tcgen05", confidence: "source-reported", path: "wiki/reference/migration-wgmma-to-tcgen05.md" },
    { id: "pattern-memory-bound", confidence: "verified", path: "wiki/patterns/memory-bound.md" },
    { id: "unlabelled-page", confidence: null, path: "wiki/patterns/unlabelled-page.md" },
  ],
};

function model(text = MILESTONE) {
  return parseMilestone(text).model;
}

function problems(text, ctx = {}) {
  return validateMilestone(model(text), {
    contract: CONTRACT,
    profileRunIds: ["run1", "run2"],
    ...ctx,
  });
}

function ofRule(text, rule, ctx) {
  return problems(text, ctx).filter((problem) => problem.rule === rule);
}

function only(text, rule, ctx) {
  const hits = ofRule(text, rule, ctx);
  assert.equal(hits.length, 1, `expected one ${rule}, got ${hits.length}: ${JSON.stringify(hits.map((hit) => hit.message))}`);
  return hits[0];
}

/** The order of gate lines in the fixture: 1 ncu-direct, 2 correctness, 3 sass-derived, 4 mechanism. */
function gateLine(text, index, pointer) {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line === "### M0 Gate");
  let seen = 0;
  for (let position = start + 1; position < lines.length; position += 1) {
    if (lines[position].trim() === "") continue;
    seen += 1;
    if (seen === index) {
      lines[position] = lines[position].replace(/\[VERIFY: [^\]]*\]/, `[VERIFY: ${pointer}]`);
      return lines.join("\n");
    }
  }
  throw new Error(`no gate line ${index}`);
}

test("a clean milestone with resolvable measurement pointers has no citation problems", () => {
  const rules = problems().map((problem) => problem.rule);
  assert.deepEqual(rules, []);
  assert.equal(CONFIDENCE_LABELS.length, 4);
});

test("a profile pointer that names no run is refused, with the lookup path", () => {
  const problem = only(gateLine(MILESTONE, 1, "ncu-direct profile:run9"), "gate-citation-unresolved");
  assert.equal(problem.row, "M0 Gate:1");
  assert.match(problem.what, /profile:run9/);
  assert.match(problem.what, /profile\/run9/);
  assert.equal(problem.severity, "refusal");
});

test("a cell-group pointer resolves against the contract's cells and groups, or is refused", () => {
  const unknownGroup = only(gateLine(MILESTONE, 2, "correctness cell-group: m1024/nope"), "gate-citation-unresolved");
  assert.match(unknownGroup.what, /m1024\/nope/);
  assert.match(unknownGroup.what, /typical, tail, cold/);

  const unknownCell = only(gateLine(MILESTONE, 2, "correctness cell-group: m9999/typical"), "gate-citation-unresolved");
  assert.match(unknownCell.what, /m9999/);
  assert.match(unknownCell.fix, /contract/);

  // The T-010 spelling is the same namespace, not a different one.
  assert.deepEqual(ofRule(gateLine(MILESTONE, 2, "correctness cell/group: m1024/tail"), "gate-citation-unresolved"), []);
});

test("a pointer in no known namespace is refused by what it is, not silently ignored", () => {
  const problem = only(gateLine(MILESTONE, 1, "ncu-direct run1"), "gate-citation-unresolved");
  assert.match(problem.what, /namespace/);
  assert.match(problem.what, /profile:/);
});

test("a PRICED source that is a pointer must resolve too", () => {
  const text = MILESTONE.replace("[PRICED: -8% issue slots, profile:run2]", "[PRICED: -8% issue slots, profile:run7]");
  const problem = only(text, "gate-citation-unresolved");
  assert.equal(problem.row, "M0 Gate:3");
  assert.match(problem.what, /profile:run7/);

  // A prose source is not resolvable and not a lie: it is left to the reader.
  const prose = MILESTONE.replace("[PRICED: -8% issue slots, profile:run2]", "[PRICED: -8% issue slots, measured on the sm90 box]");
  assert.deepEqual(ofRule(prose, "gate-citation-unresolved"), []);
});

test("a wiki pointer on a gate line is refused: knowledge never measures", () => {
  const problem = only(gateLine(MILESTONE, 4, "mechanism wiki:pattern-memory-bound#source-reported"), "gate-cites-knowledge");
  assert.equal(problem.row, "M0 Gate:4");
  assert.match(problem.what, /decision row/);
});

test("a wiki pointer on a decision row is accepted with each confidence label", () => {
  for (const label of CONFIDENCE_LABELS) {
    const text = MILESTONE.replace(
      "- Purpose: overlap the global load with the mma",
      `- Purpose: overlap the global load with the mma, as in wiki:pattern-memory-bound#${label}`,
    );
    assert.deepEqual(
      problems(text, { corpus: CORPUS }).filter((problem) => problem.rule.startsWith("wiki-") || problem.rule === "knowledge-source-absent"),
      [],
      `label ${label}`,
    );
  }
});

test("each wiki dangling pointer has its own name", () => {
  const row = (citation) => MILESTONE.replace("- Action: move the tile load to cp.async with two stages", `- Action: move the tile load to cp.async with two stages (${citation})`);

  const confidence = only(row("wiki:pattern-memory-bound#probably"), "wiki-citation-unknown");
  assert.match(confidence.what, /probably/);
  assert.match(confidence.what, /verified, source-reported, inferred, experimental/);

  const shape = only(row("wiki:Pattern_Memory_Bound#verified"), "wiki-citation-unknown");
  assert.match(shape.what, /kebab-case/);

  const missing = only(row("wiki:no-such-page#verified"), "wiki-citation-unresolved", { corpus: CORPUS });
  assert.match(missing.what, /no-such-page/);

  // A label the corpus does not carry is not an error: the citer's label is the claim.
  assert.deepEqual(
    problems(row("wiki:unlabelled-page#inferred"), { corpus: CORPUS }).filter((problem) => problem.severity === "refusal"),
    [],
  );
});

test("an unlabelled page is a warning that names the page, never a refusal", () => {
  const text = MILESTONE.replace("- Purpose: overlap the global load with the mma", "- Purpose: overlap the global load with the mma (wiki:unlabelled-page)");
  const problem = only(text, "wiki-citation-unlabelled", { corpus: CORPUS });
  assert.equal(problem.severity, "warning");
  assert.match(problem.what, /unlabelled-page/);
  assert.deepEqual(
    problems(text, { corpus: CORPUS }).filter((entry) => entry.severity === "refusal"),
    [],
  );
});

test("a citation outside Action, Purpose or Trigger is refused rather than ignored", () => {
  const text = MILESTONE.replace("- Cost: one day, one extra buffer", "- Cost: one day, one extra buffer (wiki:pattern-memory-bound#verified)");
  const problem = only(text, "wiki-citation-misplaced", { corpus: CORPUS });
  assert.equal(problem.row, "D0.1 Cost");
  assert.match(problem.what, /Action, Purpose or Trigger/);
});

test("an absent corpus is a visible warning naming kernel_bootstrap, not a refusal", () => {
  const text = MILESTONE.replace("- Purpose: overlap the global load with the mma", "- Purpose: overlap the global load with the mma (wiki:pattern-memory-bound#verified)");
  const absent = only(text, "knowledge-source-absent", { corpus: null });
  assert.equal(absent.severity, "warning");
  assert.equal(absent.row, "milestone");
  assert.match(absent.fix, /kernel_bootstrap/);
  assert.deepEqual(
    problems(text, { corpus: null }).filter((entry) => entry.severity === "refusal"),
    [],
  );
  // Not looked up is not the same as looked up and absent: no warning when the
  // caller never asked the corpus (a unit test's ctx, not the tool's).
  assert.deepEqual(ofRule(text, "knowledge-source-absent"), []);
});

test("readCorpusIndex reads ids and confidence labels, and reports absence as null", () => {
  assert.equal(readCorpusIndex("/nonexistent/corpus"), null);
  const index = readCorpusIndex(".dev/feature-kernel-expert-v2/runs/plan-0/corpus-fixture");
  assert.ok(index, "the fixture corpus is readable");
  assert.deepEqual(
    index.pages.map((page) => `${page.id}#${page.confidence ?? "-"}`),
    ["migration-wgmma-to-tcgen05#source-reported", "unlabelled-page#-"],
  );
});

test("through the tool: a gate line pointing at a run nobody profiled is refused, and says where it looked", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const kernelExpertExtension = (await import("../../extensions/pi-kernel-expert/index.ts")).default;
  const { fakeCommandContext, fakePi } = await import("../helpers/fake-host.mjs");

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kernel-expert-citations-"));
  fs.mkdirSync(path.join(root, "docs"));
  fs.mkdirSync(path.join(root, "profile", "run1"), { recursive: true });
  fs.writeFileSync(path.join(root, "profile", "run1", "summary.json"), "{}");
  fs.writeFileSync(path.join(root, "kernel.contract.json"), JSON.stringify({
    schemaVersion: 2,
    cells: [{ id: "m1024", dtype: "fp16", groups: [{ name: "typical", intent: "the reported shape" }] }],
  }));
  fs.writeFileSync(path.join(root, "docs", "milestone.md"), MILESTONE);

  const pi = fakePi();
  kernelExpertExtension(pi);
  const { ctx } = fakeCommandContext({ cwd: root });
  const result = await pi.tools.get("kernel_milestone").execute("call", {}, undefined, undefined, ctx);
  const text = result.content[0].text;
  assert.equal(result.details.ok, false);
  // run1 exists; run2 is cited by the PRICED bracket and does not.
  assert.match(text, /gate-citation-unresolved M0 Gate:3/);
  assert.match(text, /profile\/run2\/summary\.json/);
  assert.match(text, /the runs under profile\/ are run1/);
  assert.doesNotMatch(text, /profile:run1` names no run/);
});
