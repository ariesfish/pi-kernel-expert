import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { checkMilestoneBinding, readMilestoneSnapshot } from "../../extensions/pi-kernel-expert/kernel/milestone-binding.ts";

const MILESTONE = `# Milestone: probe

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

#### D0.2 Stage through cp.async
- Action: prefetch the next tile
- Purpose: overlap the load with the mma
- Trigger: long scoreboard above 40%
- Cost: one day
- Depends on: ⇐ D0.1

### M0 Gate
- the probe lands [VERIFY: mechanism]

## 4. Dead Ends
- D0.1+D0.2 | the pair spills 190 registers | profile:run2
- D0.2 | staging alone gains nothing at 8 MB | profile:run3

## 5. Global Gate
The probe holds.

## 6. Rules
One rule.
`;

function workspace(text = MILESTONE) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kernel-expert-bind-"));
  fs.mkdirSync(path.join(root, "docs"));
  fs.writeFileSync(path.join(root, "docs", "milestone.md"), text);
  return root;
}

test("the snapshot carries the decisions and the dead ends, or null when there is no milestone", () => {
  assert.equal(readMilestoneSnapshot(fs.mkdtempSync(path.join(os.tmpdir(), "pi-kernel-expert-none-"))), null);
  const snapshot = readMilestoneSnapshot(workspace());
  assert.deepEqual(snapshot.decisions, ["D0.1", "D0.2"]);
  assert.equal(snapshot.sha.length, 64);
  assert.deepEqual(
    snapshot.deadEnds.map((entry) => entry.ids.join("+")),
    ["D0.1+D0.2", "D0.2"],
  );
  assert.match(snapshot.deadEnds[0].reason, /spills 190 registers/);
});

test("a keep with a decision in the milestone records the id and the sha it was read from", () => {
  const snapshot = readMilestoneSnapshot(workspace());
  const result = checkMilestoneBinding({ snapshot, requested: "D0.1", declaredSha: null, precondition: null });
  assert.deepEqual(result.refusals, []);
  assert.equal(result.record.milestoneDecision, "D0.1");
  assert.equal(result.record.milestoneSha, snapshot.sha);
  assert.equal(result.record.precondition, null);
});

test("a decision the milestone does not have is refused by name, with the ids it does have", () => {
  const snapshot = readMilestoneSnapshot(workspace());
  const result = checkMilestoneBinding({ snapshot, requested: "D9.9", declaredSha: null, precondition: null });
  assert.equal(result.refusals.length, 1);
  assert.equal(result.refusals[0].rule, "decision-unknown");
  assert.match(result.refusals[0].message, /D9\.9/);
  assert.match(result.refusals[0].message, /D0\.1, D0\.2/);
  assert.equal(result.refusals[0].charged, "candidate");
  assert.equal(result.refusals[0].forceable, false);
});

test("a bundle is checked one id at a time, and one absent id refuses the bundle", () => {
  const snapshot = readMilestoneSnapshot(workspace());
  const bad = checkMilestoneBinding({ snapshot, requested: "D0.1+D7.1", declaredSha: null, precondition: null });
  assert.equal(bad.refusals[0].rule, "decision-unknown");
  assert.match(bad.refusals[0].message, /D7\.1/);
  assert.match(bad.refusals[0].message, /D0\.1 is in the milestone/);
});

test("a declared milestone sha that no longer matches the file is refused: the decision may have changed under it", () => {
  const snapshot = readMilestoneSnapshot(workspace());
  const result = checkMilestoneBinding({ snapshot, requested: "D0.1", declaredSha: "a".repeat(64), precondition: null });
  assert.equal(result.refusals[0].rule, "milestone-stale");
  assert.match(result.refusals[0].message, /aaaaaaa/);
  assert.match(result.refusals[0].message, new RegExp(snapshot.sha.slice(0, 12)));
});

test("a bundle the plan recorded as a dead end is refused unless a precondition says what changed", () => {
  const snapshot = readMilestoneSnapshot(workspace());
  const refused = checkMilestoneBinding({ snapshot, requested: "D0.2+D0.1", declaredSha: null, precondition: null });
  assert.equal(refused.refusals[0].rule, "dead-end-bundle");
  assert.match(refused.refusals[0].message, /spills 190 registers/);
  assert.match(refused.refusals[0].message, /precondition/);
  assert.match(refused.refusals[0].message, /D0\.1\+D0\.2/);

  const allowed = checkMilestoneBinding({
    snapshot,
    requested: "D0.1+D0.2",
    declaredSha: null,
    precondition: "the 190-register spill was the smem stage; this version has no smem",
  });
  assert.deepEqual(allowed.refusals, []);
  assert.equal(allowed.record.precondition, "the 190-register spill was the smem stage; this version has no smem");

  // A single member is not the banned combination, and is not refused for it.
  const single = checkMilestoneBinding({ snapshot, requested: "D0.1", declaredSha: null, precondition: null });
  assert.deepEqual(single.refusals, []);
});

test("a keep that names no decision is refused when the plan is there, and the fix names the decisions it could have used", () => {
  const snapshot = readMilestoneSnapshot(workspace());
  const result = checkMilestoneBinding({ snapshot, requested: null, declaredSha: null, precondition: null });
  assert.equal(result.refusals[0].rule, "decision-missing");
  assert.match(result.refusals[0].message, /D0\.1, D0\.2/);
});

test("no milestone is a declared degradation: no decision, no refusal, and the reason is recorded", () => {
  const result = checkMilestoneBinding({ snapshot: null, requested: null, declaredSha: null, precondition: null });
  assert.deepEqual(result.refusals, []);
  assert.equal(result.record.milestoneDecision, null);
  assert.equal(result.record.milestoneSha, null);
  assert.match(result.note, /no docs\/milestone\.md/);
});
