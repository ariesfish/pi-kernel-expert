import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import kernelExpertExtension from "../../extensions/pi-kernel-expert/index.ts";
import {
  FIVE_TUPLE_KEYS,
  MILESTONE_RELATIVE_PATH,
  TRIGGER_CATEGORIES,
  formatMilestoneProblems,
  formatMilestoneSummary,
  parseMilestone,
  renderMilestone,
  validateMilestone,
} from "../../extensions/pi-kernel-expert/kernel/milestone.ts";
import { fakePi } from "../helpers/fake-host.mjs";

/** A well-formed two-phase milestone: it validates clean, so every refusal below is one edit away. */
const MILESTONE = `# Milestone

## 0. Problem and Target
The fused attention kernel takes 41 us on m1024/typical; the target is 20 us and max_diff stays under 1e-2.

## 1. Contract
kernel.contract.json fixes cells m1024 and m4096, groups typical and tail, rtol 1e-2 and atol 1e-3.

## 2. DAG and Phase Order
M0 lands before M1: a lever measured on a missing architecture measures the old kernel.

## 3. Decisions
### M0 Architecture
#### D0.1 One warp per 64-row tile
- Action: assign one warp to a 64-row tile with 32 KiB of smem per block
- Purpose: keep the accumulator in registers instead of smem
- Trigger: ncu shows smem traffic above 40% of the achieved bytes on m1024/typical
- Cost: one day, one new kernel file
- Depends on: none

#### D0.2 Double-buffer the smem tile
- Action: prefetch tile k+1 while computing tile k
- Purpose: hide the smem load behind the mma issue
- Trigger: waves/SM < 1 on the reference
- Cost: half a day, one extra barrier
- Depends on: ⇐ D0.1, ⊗ D0.1

### M0 Gate
- device_ms halves on m1024/typical with the checks still green [VERIFY: ncu-direct profile:run1]
- every cell/group still matches the reference [VERIFY: correctness cell/group: m1024/typical]
- the inner loop issues two LDG per 128 B [VERIFY: sass-derived][PRICED: -8% issue slots, profile:run2]

### M1 Levers
#### D1.1 Split the K loop across two warps
- Action: split the reduction over two warps and combine through smem
- Purpose: halve the per-warp K length
- Trigger: ncu reports L1 hit rate below 60% on m4096/tail
- Cost: two days, a new reduction
- Depends on: ⇐ D0.2, ⇒ D1.2

#### D1.2 Combine the two warp partials in one pass
- Action: read both partials in one smem pass
- Purpose: remove the second barrier
- Trigger: waves/SM < 0.5 on the reference
- Cost: half a day
- Depends on: ⇐ D1.1

### M1 Gate
- the two-warp reduction lands and max_diff stays under 3x the reference's own [VERIFY: mechanism]

## 4. Dead Ends
- D0.1 | a 256x128 tile spills 190 registers | profile:run2

## 5. Global Gate
Both phase gates hold on every cell and group, and goal.checks.sh is green.

## 6. Rules
A decision is a five-tuple. A gate line carries exactly one VERIFY class and its pointer.
`;

function model(text = MILESTONE) {
  return parseMilestone(text).model;
}

function problems(text = MILESTONE) {
  return validateMilestone(model(text));
}

function find(text, rule) {
  return problems(text).filter((problem) => problem.rule === rule);
}

/** Exactly one refusal of `rule`, returned, so a test can assert on its row and message. */
function only(text, rule) {
  const hits = find(text, rule);
  assert.equal(
    hits.length,
    1,
    `expected exactly one ${rule} refusal, got ${hits.length}: ${JSON.stringify(hits.map((hit) => hit.message))}`,
  );
  return hits[0];
}

/** Replace `from` with `to`, asserting the fixture actually contains it. */
function mutate(from, to, text = MILESTONE) {
  assert.ok(text.includes(from), `fixture does not contain ${JSON.stringify(from)}`);
  return text.replace(from, to);
}

test("a valid two-phase milestone validates clean", () => {
  assert.deepEqual(problems(), []);
});

test("parse then render is byte-identical, in both directions", () => {
  const parsed = parseMilestone(MILESTONE);
  assert.equal(renderMilestone(parsed.model), MILESTONE);
  assert.equal(renderMilestone(parseMilestone(renderMilestone(parsed.model)).model), MILESTONE);
  assert.deepEqual(parsed.problems, []);
});

test("the model addresses every section, phase, decision and gate line", () => {
  const parsed = model();
  assert.deepEqual(
    parsed.sections.map((section) => `${section.number}. ${section.title}`),
    [
      "0. Problem and Target",
      "1. Contract",
      "2. DAG and Phase Order",
      "3. Decisions",
      "4. Dead Ends",
      "5. Global Gate",
      "6. Rules",
    ],
  );
  assert.deepEqual(
    parsed.phases.map((phase) => `${phase.id} ${phase.name} (${phase.kind})`),
    ["M0 Architecture (block)", "M0 Gate (gate)", "M1 Levers (block)", "M1 Gate (gate)"],
  );
  assert.deepEqual(
    parsed.decisions.map((decision) => `${decision.id}@${decision.phase}`),
    ["D0.1@M0", "D0.2@M0", "D1.1@M1", "D1.2@M1"],
  );
  for (const decision of parsed.decisions) {
    assert.deepEqual(
      decision.rows.map((row) => row.key),
      [...FIVE_TUPLE_KEYS],
      `${decision.id} must carry exactly the five keys, in order`,
    );
  }
  assert.deepEqual(
    parsed.decisions[1].deps.map((dep) => `${dep.arrow}${dep.id}`),
    ["⇐D0.1", "⊗D0.1"],
  );
  assert.deepEqual(parsed.decisions[0].deps, []);
  assert.deepEqual(
    parsed.gates[0].lines.map((line) => [line.row, line.verify, line.pointer]),
    [
      ["M0 Gate:1", "ncu-direct", "profile:run1"],
      ["M0 Gate:2", "correctness", "cell/group: m1024/typical"],
      ["M0 Gate:3", "sass-derived", null],
    ],
  );
  assert.deepEqual(parsed.gates[0].lines[2].priced, {
    delta: "-8% issue slots",
    source: "profile:run2",
    raw: "[PRICED: -8% issue slots, profile:run2]",
  });
  assert.deepEqual(parsed.deadEnds, ["D0.1 | a 256x128 tile spills 190 registers | profile:run2"]);
});

// ---- one test per refusal -------------------------------------------------

test("route-missing-key names the decision and the keys that are absent", () => {
  const text = mutate("- Cost: one day, one new kernel file\n", "");
  const refusal = only(text, "route-missing-key");
  assert.equal(refusal.row, "D0.1");
  assert.match(refusal.message, /route-missing-key/);
  assert.match(refusal.message, /D0\.1/);
  assert.match(refusal.message, /Cost absent/);
  assert.match(refusal.message, /Fix:/);
});

test("route-missing-key also refuses an empty value and an unknown key", () => {
  const empty = mutate("- Purpose: keep the accumulator in registers instead of smem", "- Purpose:");
  assert.match(only(empty, "route-missing-key").message, /Purpose empty/);

  const unknown = mutate("- Cost: two days, a new reduction", "- Costs: two days, a new reduction");
  const refusal = only(unknown, "route-missing-key");
  assert.equal(refusal.row, "D1.1");
  assert.match(refusal.message, /"Costs" is not one of the five/);
});

test("route-dangling-dep names the decision and the id nothing defines", () => {
  const text = mutate("- Depends on: ⇐ D1.1", "- Depends on: ⇐ D1.9");
  const refusal = only(text, "route-dangling-dep");
  assert.equal(refusal.row, "D1.2");
  assert.match(refusal.message, /route-dangling-dep/);
  assert.match(refusal.message, /D1\.2/);
  assert.match(refusal.message, /D1\.9/);
  assert.match(refusal.message, /no decision defines/);
});

test("route-dangling-dep refuses a self-reference", () => {
  const text = mutate("- Depends on: ⇐ D0.1, ⊗ D0.1", "- Depends on: ⇐ D0.2");
  const refusal = only(text, "route-dangling-dep");
  assert.equal(refusal.row, "D0.2");
  assert.match(refusal.message, /the decision itself/);
});

test('route-id-is-gate refuses a decision heading that says "gate"', () => {
  const text = mutate("#### D1.2 Combine the two warp partials in one pass", "#### D1.2 Gate the partial combination");
  const refusal = only(text, "route-id-is-gate");
  assert.equal(refusal.row, "D1.2");
  assert.match(refusal.message, /route-id-is-gate/);
  assert.match(refusal.message, /D1\.2/);
  assert.match(refusal.message, /full eval/);
});

test("route-placeholder refuses a row still holding <...>", () => {
  const text = mutate("- Cost: half a day, one extra barrier", "- Cost: <one line>");
  const refusal = only(text, "route-placeholder");
  assert.equal(refusal.row, "D0.2");
  assert.match(refusal.message, /route-placeholder/);
  assert.match(refusal.message, /D0\.2/);
  assert.match(refusal.message, /<one line>/);
});

test("route-placeholder refuses the template's own sentence", () => {
  const text = mutate("- Purpose: hide the smem load behind the mma issue", "- Purpose: One line: why this decision exists");
  const refusal = only(text, "route-placeholder");
  assert.equal(refusal.row, "D0.2");
  assert.match(refusal.message, /why this decision exists/);
});

test("route-placeholder refuses a placeholder on a gate line and in a section body", () => {
  const gate = mutate(
    "- the two-warp reduction lands and max_diff stays under 3x the reference's own [VERIFY: mechanism]",
    "- <a gate line>[VERIFY: mechanism]",
  );
  const refusal = only(gate, "route-placeholder");
  assert.equal(refusal.row, "M1 Gate:1");

  const body = mutate("Both phase gates hold on every cell and group, and goal.checks.sh is green.", "<what the global gate is>");
  assert.equal(only(body, "route-placeholder").row, "5. Global Gate");
});

test("gate-verify-none refuses [VERIFY: none]", () => {
  const text = mutate("[VERIFY: correctness cell/group: m1024/typical]", "[VERIFY: none]");
  const refusal = only(text, "gate-verify-none");
  assert.equal(refusal.row, "M0 Gate:2");
  assert.match(refusal.message, /gate-verify-none/);
  assert.match(refusal.message, /M0 Gate:2/);
  assert.match(refusal.message, /"none" means nothing proves this/);
});

test("gate-verify-none refuses a gate line with no [VERIFY: ...] at all", () => {
  const text = mutate(
    "- the two-warp reduction lands and max_diff stays under 3x the reference's own [VERIFY: mechanism]",
    "- the two-warp reduction lands",
  );
  const refusal = only(text, "gate-verify-none");
  assert.equal(refusal.row, "M1 Gate:1");
  assert.match(refusal.message, /no \[VERIFY: …\] at all/);
});

test("gate-sass-unpriced refuses sass-derived without a [PRICED:] on the line", () => {
  const text = mutate("[VERIFY: sass-derived][PRICED: -8% issue slots, profile:run2]", "[VERIFY: sass-derived]");
  const refusal = only(text, "gate-sass-unpriced");
  assert.equal(refusal.row, "M0 Gate:3");
  assert.match(refusal.message, /gate-sass-unpriced/);
  assert.match(refusal.message, /M0 Gate:3/);
  assert.match(refusal.message, /\[PRICED:/);
});

test("gate-sass-unpriced refuses a price with no source", () => {
  const text = mutate("[PRICED: -8% issue slots, profile:run2]", "[PRICED: -8% issue slots]");
  const refusal = only(text, "gate-sass-unpriced");
  assert.equal(refusal.row, "M0 Gate:3");
  assert.match(refusal.message, /no source/);
});

test("gate-no-mechanism-line refuses a milestone whose only gate lines are empty [VERIFY: mechanism]", () => {
  let text = MILESTONE;
  for (const line of [
    "- device_ms halves on m1024/typical with the checks still green [VERIFY: ncu-direct profile:run1]",
    "- every cell/group still matches the reference [VERIFY: correctness cell/group: m1024/typical]",
    "- the inner loop issues two LDG per 128 B [VERIFY: sass-derived][PRICED: -8% issue slots, profile:run2]",
    "- the two-warp reduction lands and max_diff stays under 3x the reference's own [VERIFY: mechanism]",
  ]) {
    text = mutate(line, "- [VERIFY: mechanism]", text);
  }
  assert.deepEqual(find(text, "gate-verify-none"), []);
  const refusal = only(text, "gate-no-mechanism-line");
  assert.equal(refusal.row, "milestone");
  assert.match(refusal.message, /gate-no-mechanism-line/);
  assert.match(refusal.message, /milestone/);
});

test("gate-no-mechanism-line refuses a bare number as the only proof", () => {
  let text = MILESTONE;
  for (const line of [
    "- device_ms halves on m1024/typical with the checks still green [VERIFY: ncu-direct profile:run1]",
    "- every cell/group still matches the reference [VERIFY: correctness cell/group: m1024/typical]",
    "- the inner loop issues two LDG per 128 B [VERIFY: sass-derived][PRICED: -8% issue slots, profile:run2]",
  ]) {
    text = mutate(line, "- 2.1x [VERIFY: mechanism]", text);
  }
  text = mutate(
    "- the two-warp reduction lands and max_diff stays under 3x the reference's own [VERIFY: mechanism]",
    "- ≤ 5 us [VERIFY: mechanism]",
    text,
  );
  assert.equal(only(text, "gate-no-mechanism-line").row, "milestone");
});

test("gate-no-mechanism-line refuses a milestone with no gate block at all", () => {
  const text = MILESTONE.replace(/### M[01] Gate\n(- .*\n)+\n/g, "");
  assert.ok(!text.includes("### M0 Gate"));
  assert.deepEqual(find(text, "gate-verify-none"), []);
  assert.equal(only(text, "gate-no-mechanism-line").row, "milestone");
});

test("a gate line with [VERIFY: mechanism] plus text passes the mechanism rule", () => {
  let text = MILESTONE;
  for (const line of [
    "- device_ms halves on m1024/typical with the checks still green [VERIFY: ncu-direct profile:run1]",
    "- every cell/group still matches the reference [VERIFY: correctness cell/group: m1024/typical]",
    "- the inner loop issues two LDG per 128 B [VERIFY: sass-derived][PRICED: -8% issue slots, profile:run2]",
  ]) {
    text = mutate(line, "- the tile double-buffers and ncu reports no partial waves [VERIFY: mechanism]", text);
  }
  assert.deepEqual(problems(text), []);
});

test("trigger-is-category fires on every phrase in the list, by name", () => {
  for (const phrase of TRIGGER_CATEGORIES) {
    const text = mutate("- Trigger: waves/SM < 1 on the reference", `- Trigger: ${phrase} the tile`);
    const refusal = only(text, "trigger-is-category");
    assert.equal(refusal.row, "D0.2");
    assert.match(refusal.message, /trigger-is-category/);
    assert.match(refusal.message, /D0\.2/);
    assert.ok(refusal.message.includes(`"${phrase}"`), `${refusal.message} must quote ${phrase}`);
  }
});

test("a trigger naming an observable passes", () => {
  assert.deepEqual(find(MILESTONE, "trigger-is-category"), []);
  const stronger = mutate("- Trigger: waves/SM < 1 on the reference", "- Trigger: waves/SM < 1 on the reference card");
  assert.deepEqual(find(stronger, "trigger-is-category"), []);
});

test("phase-order refuses a later phase block before an earlier one", () => {
  const m1 = MILESTONE.slice(MILESTONE.indexOf("### M1 Levers"), MILESTONE.indexOf("## 4. Dead Ends"));
  const m0 = MILESTONE.slice(MILESTONE.indexOf("### M0 Architecture"), MILESTONE.indexOf("### M1 Levers"));
  const swapped =
    MILESTONE.slice(0, MILESTONE.indexOf("### M0 Architecture")) + m1 + m0 + MILESTONE.slice(MILESTONE.indexOf("## 4. Dead Ends"));
  const refusal = only(swapped, "phase-order");
  assert.equal(refusal.row, "M0");
  assert.match(refusal.message, /phase-order/);
  assert.match(refusal.message, /### M0 Architecture/);
});

test("two refusals in one file are both reported, never just the first", () => {
  let text = mutate("- Depends on: ⇐ D1.1", "- Depends on: ⇐ D1.9");
  text = mutate("- Trigger: ncu reports L1 hit rate below 60% on m4096/tail", "- Trigger: improve the reduction", text);
  const found = problems(text);
  assert.equal(found.length, 2);
  assert.deepEqual(found.map((problem) => problem.rule), ["route-dangling-dep", "trigger-is-category"]);
  assert.match(formatMilestoneProblems(found), /^1\. route-dangling-dep D1\.2:/);
  assert.match(formatMilestoneProblems(found), /2\. trigger-is-category D1\.1:/);
});

test("the summary names the phases, the decision ids and every gate line with its class", () => {
  const summary = formatMilestoneSummary(model());
  assert.match(summary, /4 decision\(s\)/);
  assert.match(summary, /M0 Architecture — 2 decision\(s\)/);
  assert.match(summary, /D0\.2 Double-buffer the smem tile \(M0\) — depends on ⇐ D0\.1, ⊗ D0\.1/);
  assert.match(summary, /M0 Gate:1 \[VERIFY: ncu-direct\] profile:run1/);
  assert.match(summary, /M0 Gate:2 \[VERIFY: correctness\] cell\/group: m1024\/typical/);
  assert.match(summary, /M0 Gate:3 \[VERIFY: sass-derived\] \[PRICED: -8% issue slots, profile:run2\]/);
});

// ---- the tool -------------------------------------------------------------

function toolHost(root) {
  const pi = fakePi();
  kernelExpertExtension(pi);
  const tool = pi.tools.get("kernel_milestone");
  assert.ok(tool, "kernel_milestone must be registered");
  const ctx = { cwd: root, ui: { notify() {} }, hasUI: false };
  return { tool, ctx };
}

/**
 * A workspace whose gate-line pointers resolve: the fixture cites `profile:run1`,
 * `profile:run2` and `m1024/typical`, and the tool now asks the profile directory
 * and the contract whether those exist. A milestone that cites a run nobody
 * profiled is refused, which is the point.
 */
function workspaceWith(text) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kernel-milestone-"));
  fs.mkdirSync(path.join(root, "docs"), { recursive: true });
  fs.writeFileSync(path.join(root, MILESTONE_RELATIVE_PATH), text);
  for (const run of ["run1", "run2"]) {
    fs.mkdirSync(path.join(root, "profile", run), { recursive: true });
    fs.writeFileSync(path.join(root, "profile", run, "summary.json"), JSON.stringify({ runId: run }));
  }
  fs.writeFileSync(
    path.join(root, "kernel.contract.json"),
    JSON.stringify({
      schemaVersion: 2,
      cells: [
        { id: "m1024", dtype: "fp16", groups: [{ name: "typical", intent: "the reported shape" }] },
        { id: "m4096", dtype: "fp16", groups: [{ name: "tail", intent: "the ragged tail" }] },
      ],
    }),
  );
  return root;
}

test("kernel_milestone validates docs/milestone.md and returns the summary", async () => {
  const root = workspaceWith(MILESTONE);
  const { tool, ctx } = toolHost(root);

  const result = await tool.execute("call", {}, undefined, undefined, ctx);
  const text = result.content[0].text;
  assert.match(text, /docs\/milestone\.md — clean\./);
  assert.match(text, /D0\.1 One warp per 64-row tile \(M0\)/);
  assert.match(text, /M1 Gate:1 \[VERIFY: mechanism\]/);
  assert.equal(result.details.ok, true);
  assert.deepEqual(result.details.refusals, []);
  assert.deepEqual(
    result.details.decisions.map((decision) => decision.id),
    ["D0.1", "D0.2", "D1.1", "D1.2"],
  );
  // Never writes.
  assert.equal(fs.readFileSync(path.join(root, MILESTONE_RELATIVE_PATH), "utf8"), MILESTONE);
});

test("kernel_milestone reports every refusal with its rule and row, and never writes", async () => {
  let text = mutate("- Depends on: ⇐ D1.1", "- Depends on: ⇐ D1.9");
  text = mutate("- Cost: half a day, one extra barrier", "- Cost: <one line>", text);
  const root = workspaceWith(text);
  const { tool, ctx } = toolHost(root);

  const result = await tool.execute("call", {}, undefined, undefined, ctx);
  const out = result.content[0].text;
  assert.match(out, /refused: 2 problem\(s\)/);
  assert.match(out, /route-dangling-dep D1\.2/);
  assert.match(out, /route-placeholder D0\.2/);
  assert.equal(result.details.ok, false);
  assert.equal(fs.readFileSync(path.join(root, MILESTONE_RELATIVE_PATH), "utf8"), text);
});

test("kernel_milestone names the file when there is no milestone", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kernel-milestone-empty-"));
  const { tool, ctx } = toolHost(root);
  const result = await tool.execute("call", {}, undefined, undefined, ctx);
  assert.match(result.content[0].text, /No milestone at docs\/milestone\.md/);
});
