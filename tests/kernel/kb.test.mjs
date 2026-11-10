import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { cite, parseStatus, readKbTree, validateIndexes } from "../../extensions/pi-kernel-expert/kernel/kb.ts";
import { lintKb, readReferenceTokens } from "../../extensions/pi-kernel-expert/kernel/kb-lint.ts";

const ENTRY = `---
id: wgmma-a-operand-descriptor
---

**Certification source:** probe 7 on h200-7, 2026-11-10, \`./bench --n 16777216 --mode coalesced\`
**Certification covers:** the A operand path on sm90 for a 4-warp mma layout
**Uncertified:** anything about sm100, or about a kernel that keeps the accumulator in registers

- Status: MEASURED NVIDIA H200 2026-11-10

## Purpose
Keep the A operand out of the register file when the budget is the constraint.

## When needed (trigger)
\`a_reg\` is 0 and \`a_desc\` is not, while the register budget is what the schedule needs.

## Mechanism
The accumulator rides in registers; the operand comes from smem through a descriptor.

## Measured footprint and cost
Worth 8% issue slots under a 4-warp layout at 128x128, not a universal percentage.

\`\`\`
ncu --metrics launch__registers_per_thread ./goal.sh a typical
registers_per_thread 168
\`\`\`

## Gotchas
The descriptor form costs a long scoreboard stall if the smem is not ready.

## Certification boundary
Never run on sm120. The 8% is one structure on one card on one day.
`;

const INDEX = `# sm90 index

Look up by symptom first: this section is the entry point, not a table of contents.

| Symptom | Entry | Status |
|---|---|---|
| \`a_reg\` is 0 while the budget is the constraint | wgmma-a-operand-descriptor | MEASURED NVIDIA H200 2026-11-10 |
`;

function workspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kernel-expert-kb-"));
  fs.mkdirSync(path.join(root, "kb", "sm90"), { recursive: true });
  fs.mkdirSync(path.join(root, "docs"), { recursive: true });
  fs.writeFileSync(path.join(root, "kb", "sm90", "index.md"), INDEX);
  fs.writeFileSync(path.join(root, "kb", "sm90", "wgmma-a-operand-descriptor.md"), ENTRY);
  return root;
}

test("a status line is one of three, and each has an invariant", () => {
  assert.deepEqual(parseStatus("MEASURED NVIDIA H200 2026-11-10"), {
    kind: "measured",
    gpu: "NVIDIA H200",
    date: "2026-11-10",
    rest: "",
  });
  assert.deepEqual(parseStatus("UNVERIFIED — no sm120 run"), { kind: "unverified", missing: "no sm120 run" });
  assert.deepEqual(parseStatus("TODO"), { kind: "todo", rest: "" });
  assert.equal(parseStatus("probably works"), null);
  assert.equal(parseStatus("MEASURED without a date"), null);
});

test("a complete entry can be cited, and the token is the entry's own id", () => {
  const tree = readKbTree(workspace());
  assert.ok(tree);
  const result = cite(tree, "wgmma-a-operand-descriptor");
  assert.equal(result.ok, true, result.ok ? "" : result.reason);
  assert.equal(result.token, "KB:wgmma-a-operand-descriptor");
});

test("each way an entry cannot back a price is refused by name", () => {
  const root = workspace();
  const file = path.join(root, "kb", "sm90", "wgmma-a-operand-descriptor.md");
  const complete = fs.readFileSync(file, "utf8");

  const cases = [
    ["no certification mark", complete.replace(/\*\*Certification source:\*\*.*\n/, ""), /no `Certification source:` line/],
    ["no status", complete.replace(/- Status: .*\n/, ""), /no status line/],
    ["no boundary", complete.replace(/## Certification boundary[\s\S]*/, ""), /no `## Certification boundary` section/],
    ["no command", complete.replace(/```[\s\S]*?```/, ""), /no fenced command/],
    ["unverified", complete.replace("- Status: MEASURED NVIDIA H200 2026-11-10", "- Status: UNVERIFIED — no sm90 probe yet"), /UNVERIFIED|no status line/],
  ];
  for (const [name, text, expected] of cases) {
    fs.writeFileSync(file, text);
    const tree = readKbTree(root);
    const result = cite(tree, "wgmma-a-operand-descriptor");
    assert.equal(result.ok, false, name);
    assert.match(result.reason ?? "", expected, name);
  }

  fs.writeFileSync(file, complete);
  const unknown = cite(readKbTree(root), "no-such-entry");
  assert.equal(unknown.ok, false);
  assert.match(unknown.reason, /no entry no-such-entry/);

  assert.equal(cite(null, "anything").ok, false);
  assert.match(cite(null, "anything").reason, /no kb\/ tree/);
});

test("the index is validated, never generated", () => {
  const root = workspace();
  const tree = readKbTree(root);
  assert.deepEqual(validateIndexes(tree), []);

  const indexPath = path.join(root, "kb", "sm90", "index.md");
  const index = fs.readFileSync(indexPath, "utf8");
  fs.writeFileSync(indexPath, `${index}| another symptom | wgmma-a-operand-descriptor | MEASURED NVIDIA H200 2026-11-10 |\n`);
  const duplicated = validateIndexes(readKbTree(root));
  assert.equal(duplicated.length, 1);
  assert.match(duplicated[0].what, /2 rows/);

  fs.writeFileSync(indexPath, `${index}| a row nobody can follow | not-an-entry | TODO |\n`);
  const dangling = validateIndexes(readKbTree(root));
  assert.ok(dangling.some((problem) => /not-an-entry/.test(problem.what)));

  fs.writeFileSync(indexPath, index.replace("MEASURED NVIDIA H200 2026-11-10", "TODO"));
  const drift = validateIndexes(readKbTree(root));
  assert.ok(drift.some((problem) => /says "TODO"/.test(problem.what)));

  fs.writeFileSync(indexPath, "");
  const missingRow = validateIndexes(readKbTree(root));
  assert.ok(missingRow.some((problem) => /no row in/.test(problem.what)));
});

test("lint fails closed on a missing tree, and a clean tree is clean", () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kernel-expert-kb-empty-"));
  const closed = lintKb(empty, readKbTree(empty));
  assert.equal(closed.findings.length, 1);
  assert.match(closed.findings[0].why, /nothing was scanned/);

  const root = workspace();
  const report = lintKb(root, readKbTree(root));
  assert.deepEqual(report.findings, []);
  assert.equal(report.scanned.length, 2, "the index and the entry");
});

test("each lint rule fires on its own defect", () => {
  const root = workspace();
  const file = path.join(root, "kb", "sm90", "wgmma-a-operand-descriptor.md");
  const complete = fs.readFileSync(file, "utf8");
  fs.writeFileSync(path.join(root, "docs", "reference-tokens.txt"), "# the upstream symbols we do not name\nflash_attn_dsl\n");

  const run = (text) => {
    fs.writeFileSync(file, text);
    return lintKb(root, readKbTree(root), { referenceTokens: readReferenceTokens(root) }).findings;
  };

  assert.ok(run(complete.replace("## Mechanism", "## Mechanism\n\nSame trick as flash_attn_dsl, see `kernel.py:412`.")).some((finding) => finding.rule === "kb-reference-token"));
  assert.ok(run(complete.replace("## Gotchas", "## Gotchas\n\nFrom PR 2026-10-14 run 3.\n")).some((finding) => finding.rule === "kb-narrative"));
  assert.ok(run(complete.replace("- Status: MEASURED NVIDIA H200 2026-11-10", "- Status: MEASURED")).some((finding) => finding.rule === "kb-uncertified-claim"));
  assert.ok(run(complete.replace("- Status: MEASURED NVIDIA H200 2026-11-10", "- Status: MEASURED 2026-11-10")).some((finding) => /no GPU/.test(finding.why)));
  assert.ok(run(complete.replace("- Status: MEASURED NVIDIA H200 2026-11-10", "- Status: UNVERIFIED")).some((finding) => /what is missing/.test(finding.why)));

  fs.writeFileSync(file, complete);
  fs.rmSync(path.join(root, "kb", "sm90", "index.md"));
  assert.ok(lintKb(root, readKbTree(root)).findings.some((finding) => finding.rule === "kb-missing-index"));
});

test("README and TEMPLATE may name what the rules forbid", () => {
  const root = workspace();
  fs.writeFileSync(
    path.join(root, "kb", "sm90", "README.md"),
    "# Rules\n\nDo not cite `kernel.py:412` or flash_attn_dsl in an entry.\n",
  );
  fs.writeFileSync(path.join(root, "docs", "reference-tokens.txt"), "flash_attn_dsl\n");
  assert.deepEqual(lintKb(root, readKbTree(root), { referenceTokens: readReferenceTokens(root) }).findings, []);
});

test("a KB price on a gate line resolves through the same predicate as cite", async () => {
  const { parseMilestone, validateMilestone } = await import("../../extensions/pi-kernel-expert/kernel/milestone.ts");
  const MILESTONE = (source) => `# Milestone: probe

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
- register budget: 168
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
- the inner loop issues two LDG per 128 B [VERIFY: sass-derived][PRICED: -8% issue slots, ${source}]
- the probe lands [VERIFY: mechanism]

## 4. Dead Ends

## 5. Global Gate
The probe holds.

## 6. Rules
One rule.
`;

  const root = workspace();
  const { readKbTree: tree } = await import("../../extensions/pi-kernel-expert/kernel/kb.ts");
  const { cite } = await import("../../extensions/pi-kernel-expert/kernel/kb.ts");
  const resolver = (id) => {
    const result = cite(tree(root), id);
    return result.ok ? null : result.reason;
  };
  const problems = (text) =>
    validateMilestone(parseMilestone(text).model, { kbResolver: resolver }).filter((problem) => problem.rule === "gate-citation-unresolved");

  assert.deepEqual(problems(MILESTONE("KB:wgmma-a-operand-descriptor")), [], "a certified entry is a price");
  const empty = problems(MILESTONE("KB:"));
  assert.equal(empty.length, 1);
  assert.match(empty[0].what, /names no entry/);

  const unverified = problems(MILESTONE("KB:missing-entry"));
  assert.equal(unverified.length, 1);
  assert.match(unverified[0].what, /cannot be cited/);
  assert.match(unverified[0].what, /no entry missing-entry/);

  // The same entry, uncertified, is refused with the citation tool's reason.
  const file = path.join(root, "kb", "sm90", "wgmma-a-operand-descriptor.md");
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("- Status: MEASURED NVIDIA H200 2026-11-10", "- Status: UNVERIFIED — only one probe, on one card"));
  const refused = problems(MILESTONE("KB:wgmma-a-operand-descriptor"));
  assert.equal(refused.length, 1);
  assert.match(refused[0].what, /UNVERIFIED/);
});
