import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import kernelExpertExtension from "../../extensions/pi-kernel-expert/index.ts";
import {
  MILESTONE_LOCK_RELATIVE_PATH,
  diffM0Block,
  formatMilestoneLock,
  m0ContractBlock,
  milestoneSha,
  parseMilestoneLock,
} from "../../extensions/pi-kernel-expert/kernel/milestone-lock.ts";
import { parseMilestone, validateMilestone } from "../../extensions/pi-kernel-expert/kernel/milestone.ts";
import { fakeCommandContext, fakePi } from "../helpers/fake-host.mjs";

/** A milestone with a frozen-able M0 Contract block; clean under all nine T-010 rules. */
const MILESTONE = `# Milestone: fused attention

## 1. Problem and Target
Decode attention on an H200 is memory bound: 1.2 ms of the 1.9 ms is weight traffic.

## 2. Contract
- basis: device
- cells: m1024, m4096
- groups: typical, tail

## 3. DAG and Phase Order
M0 Contract, then M0 Architecture, then M1 Levers.

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

#### D0.2 Double-buffer the smem tile
- Action: prefetch tile k+1 while computing tile k
- Purpose: hide the smem load behind the mma issue
- Trigger: waves/SM < 1 on the reference
- Cost: half a day, one extra barrier
- Depends on: ⇐ D0.1, ⊗ D0.1

### M0 Gate
- device_ms halves on m1024/typical with the checks still green [VERIFY: ncu-direct profile:run1]
- every cell/group still matches the reference [VERIFY: correctness]
- the inner loop issues two LDG per 128 B [VERIFY: sass-derived][PRICED: -8% issue slots, profile:run2]
- the two-stage pipeline hides the load [VERIFY: mechanism]

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

function lockOf(text = MILESTONE) {
  const parsed = model(text);
  const block = m0ContractBlock(parsed);
  return {
    version: 1,
    milestoneSha: milestoneSha(text),
    m0ContractSha: milestoneSha(block.lines.join("\n")),
    lockedAt: "2026-11-10T00:00:00.000Z",
    m0Contract: block.lines.join("\n"),
  };
}

function thawed(text) {
  return validateMilestone(model(text), { lock: lockOf() }).filter((problem) => problem.rule === "m0-thawed");
}

test("the M0 contract block is the ### M0 Contract section, items and all", () => {
  const block = m0ContractBlock(model());
  assert.ok(block, "a milestone with ### M0 Contract yields a block");
  assert.match(block.lines[0], /^### M0 Contract$/);
  assert.equal(block.items.length, 6);
  assert.deepEqual(block.items[0], { key: "tile", value: "128x128 fp16 smem" });
  assert.equal(m0ContractBlock(model(MILESTONE.replace("### M0 Contract", "### M0 Architecture"))), null);
});

test("an edited M0 item after the lock is refused, and the refusal names the item", () => {
  const problems = thawed(MILESTONE.replace("- register budget: 168", "- register budget: 255"));
  assert.equal(problems.length, 1);
  const [problem] = problems;
  assert.equal(problem.rule, "m0-thawed");
  assert.equal(problem.row, "M0 Contract: register budget");
  assert.match(problem.message, /168/);
  assert.match(problem.message, /255/);
  assert.match(problem.fix, /unlock/);
});

test("an added or removed M0 item is refused by its own name", () => {
  const added = thawed(MILESTONE.replace("- accumulator precision: fp32", "- accumulator precision: fp32\n- cluster dims: 2"));
  assert.equal(added.length, 1);
  assert.equal(added[0].row, "M0 Contract: cluster dims");
  assert.match(added[0].what, /added/);

  const removed = thawed(MILESTONE.replace("- issue order: cp.async, ldmatrix, mma\n", ""));
  assert.equal(removed.length, 1);
  assert.equal(removed[0].row, "M0 Contract: issue order");
  assert.match(removed[0].what, /removed/);
});

test("deleting the whole M0 block while locked is the loudest thaw, not a clean file", () => {
  const text = MILESTONE.slice(0, MILESTONE.indexOf("### M0 Contract")) + MILESTONE.slice(MILESTONE.indexOf("### M0 Architecture"));
  const problems = thawed(text);
  assert.equal(problems.length, 1);
  assert.equal(problems[0].row, "M0 Contract");
  assert.match(problems[0].what, /no longer/);
});

test("an edit outside M0 is accepted and the milestone sha moves", () => {
  const text = MILESTONE.replace("- Action: prefetch tile k+1 while computing tile k", "- Action: prefetch tile k+1 while the mma issues");
  const lock = lockOf();
  assert.notEqual(milestoneSha(text), lock.milestoneSha);
  assert.deepEqual(validateMilestone(model(text), { lock }), []);
});

test("without a lock nothing is thawed, and a malformed lock file is refused rather than trusted", () => {
  assert.deepEqual(validateMilestone(model(MILESTONE), {}), []);
  assert.equal(parseMilestoneLock("{not json"), null);
  assert.equal(parseMilestoneLock(JSON.stringify({ milestoneSha: "abc" })), null);
  assert.equal(parseMilestoneLock(JSON.stringify(lockOf())).m0ContractSha, lockOf().m0ContractSha);
  const round = parseMilestoneLock(formatMilestoneLock(lockOf()));
  assert.equal(round.lockedAt, "2026-11-10T00:00:00.000Z");
});

test("diffM0Block pairs a changed value with its item, and reports order separately", () => {
  const before = m0ContractBlock(model()).lines;
  const changed = diffM0Block(before, before.map((line) => line.replace("168", "255")));
  assert.deepEqual(changed, [
    { kind: "changed", key: "register budget", before: "- register budget: 168", after: "- register budget: 255" },
  ]);

  const reordered = [...before];
  [reordered[3], reordered[4]] = [reordered[4], reordered[3]];
  assert.deepEqual(diffM0Block(before, reordered), [
    { kind: "reordered", key: "warp roles", before: before[3], after: before[4] },
  ]);
  assert.deepEqual(diffM0Block(before, before), []);
});

function workspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kernel-expert-lock-"));
  fs.mkdirSync(path.join(root, "docs"));
  fs.writeFileSync(path.join(root, "docs", "milestone.md"), MILESTONE);
  return root;
}

async function milestoneTool(root) {
  const pi = fakePi();
  kernelExpertExtension(pi);
  const tool = pi.tools.get("kernel_milestone");
  const { ctx } = fakeCommandContext({ cwd: root });
  const run = (params) => tool.execute("call", params, undefined, undefined, ctx);
  return { tool, run };
}

test("kernel_milestone lock writes the freeze, and a later M0 edit is refused through the tool", async () => {
  const root = workspace();
  const { run } = await milestoneTool(root);

  const locked = await run({ lock: true });
  assert.equal(locked.details.ok, true, locked.content[0].text);
  const lockFile = path.join(root, MILESTONE_LOCK_RELATIVE_PATH);
  assert.ok(fs.existsSync(lockFile));
  const written = JSON.parse(fs.readFileSync(lockFile, "utf8"));
  assert.equal(written.version, 1);
  assert.equal(written.m0ContractSha, lockOf().m0ContractSha);
  assert.match(written.lockedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(locked.content[0].text, /locked/i);

  fs.writeFileSync(
    path.join(root, "docs", "milestone.md"),
    MILESTONE.replace("- register budget: 168", "- register budget: 255"),
  );
  const refused = await run({});
  assert.equal(refused.details.ok, false);
  assert.match(refused.content[0].text, /m0-thawed/);
  assert.match(refused.content[0].text, /register budget/);

  // The freeze still holds: re-locking is not a way to absorb the edit.
  const relock = await run({ lock: true });
  assert.equal(relock.details.ok, false);
  assert.match(relock.content[0].text, /m0-thawed/);
  assert.equal(JSON.parse(fs.readFileSync(lockFile, "utf8")).m0ContractSha, lockOf().m0ContractSha);
});

test("an edit outside M0 passes the lock and re-locking moves the milestone sha", async () => {
  const root = workspace();
  const { run } = await milestoneTool(root);
  assert.equal((await run({ lock: true })).details.ok, true);

  const edited = MILESTONE.replace("- Cost: half a day, one extra barrier", "- Cost: one day, two extra barriers");
  fs.writeFileSync(path.join(root, "docs", "milestone.md"), edited);
  assert.equal((await run({})).details.ok, true);
  assert.equal((await run({ lock: true })).details.ok, true);
  const written = JSON.parse(fs.readFileSync(path.join(root, MILESTONE_LOCK_RELATIVE_PATH), "utf8"));
  assert.equal(written.milestoneSha, milestoneSha(edited));
  assert.equal(written.m0ContractSha, lockOf().m0ContractSha);
});

test("unlock needs a reason, and the reason lands in Dead Ends", async () => {
  const root = workspace();
  const { run } = await milestoneTool(root);
  await run({ lock: true });
  const lockFile = path.join(root, MILESTONE_LOCK_RELATIVE_PATH);

  for (const reason of [undefined, "", "   ", "ok"]) {
    const refused = await run({ unlock: true, reason });
    assert.equal(refused.details.ok, false, `reason ${JSON.stringify(reason)} must be refused`);
    assert.match(refused.content[0].text, /unlock-reason/);
    assert.ok(fs.existsSync(lockFile), "a refused unlock leaves the freeze in place");
  }

  // The lock freezes an M0 that has changed, so the reason has to say why that is allowed.
  fs.writeFileSync(
    path.join(root, "docs", "milestone.md"),
    MILESTONE.replace("- register budget: 168", "- register budget: 255"),
  );
  const unlocked = await run({ unlock: true, reason: "the 168-register budget was measured on sm80, not sm90" });
  assert.equal(unlocked.details.ok, true, unlocked.content[0].text);
  assert.equal(fs.existsSync(lockFile), false);

  const after = fs.readFileSync(path.join(root, "docs", "milestone.md"), "utf8");
  assert.match(after, /^- M0 \| the 168-register budget was measured on sm80, not sm90 \| m0-contract@[0-9a-f]{12}$/m);
  assert.deepEqual(
    parseMilestone(after).model.deadEnds.filter((row) => row.startsWith("M0 |")),
    ["M0 | the 168-register budget was measured on sm80, not sm90 | m0-contract@" + lockOf().m0ContractSha.slice(0, 12)],
  );

  // Unlocked means the edit is now legal.
  assert.equal((await run({})).details.ok, true);
  const noLock = await run({ unlock: true, reason: "a second unlock with nothing to unlock" });
  assert.equal(noLock.details.ok, false);
  assert.match(noLock.content[0].text, /no-lock/);
});

test("locking a milestone with no M0 Contract block is refused by name", async () => {
  const root = workspace();
  fs.writeFileSync(
    path.join(root, "docs", "milestone.md"),
    MILESTONE.replace("### M0 Contract", "### M0 Architecture").replace(/\n### M0 Architecture\n#### D0\.1/, "\n#### D0.1"),
  );
  const { run } = await milestoneTool(root);
  const refused = await run({ lock: true });
  assert.equal(refused.details.ok, false);
  assert.match(refused.content[0].text, /m0-contract-missing/);
  assert.equal(fs.existsSync(path.join(root, MILESTONE_LOCK_RELATIVE_PATH)), false);
});
