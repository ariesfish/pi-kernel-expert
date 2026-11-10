/**
 * T-013 evidence: a keep refused for a decision the plan does not have, the plan
 * row added, the same keep accepted, then a dead-ended bundle refused and
 * re-opened by a precondition.
 * Run from this directory: node --experimental-strip-types run-binding.mts
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { formatCandidateOutcome, readCandidates, recordCandidate } from "../../../../extensions/pi-kernel-expert/kernel/candidates.ts";
import { normalizeContract, writeContractFiles } from "../../../../extensions/pi-kernel-expert/kernel/contract.ts";
import { READING_END_MARKER, READING_START_MARKER } from "../../../../extensions/pi-kernel-expert/kernel/reading.ts";
import { DRAFT_HEADINGS, PLAN_HEADINGS, initWorkspace } from "../../../../extensions/pi-kernel-expert/workspace/layout.ts";
import { processExec } from "../../../../tests/helpers/process-exec.mjs";

const ROOT = path.resolve(".work");
fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(ROOT, { recursive: true });
const git = (args: string[]): string => execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();

git(["init", "-q"]);
git(["config", "user.email", "evidence@example.com"]);
git(["config", "user.name", "Evidence"]);
fs.mkdirSync(path.join(ROOT, "kernel"));
fs.writeFileSync(path.join(ROOT, "kernel", "attn.cu"), "v1\n");
git(["add", "-A"]);
git(["commit", "-q", "-m", "base"]);

initWorkspace(ROOT);
fs.writeFileSync(
  path.join(ROOT, "docs", "draft.md"),
  ["# draft", ...DRAFT_HEADINGS.flatMap((h) => [`## ${h}`, `text ${h}`, ""])].join("\n"),
);
fs.writeFileSync(
  path.join(ROOT, "docs", "plan.md"),
  ["# plan", ...PLAN_HEADINGS.flatMap((h) => [`## ${h}`, `text ${h}`, ""])].join("\n"),
);

const groups = [
  { name: "typical", intent: "random normal inputs, the ordinary case" },
  { name: "zero_block", intent: "a fully masked block must not divide by zero" },
  { name: "tail", intent: "a length off the tile boundary must not read past M" },
];
const normalized = normalizeContract({
  objective: "cut latency",
  checkCommand: "bash check.sh",
  benchmarkCommand: "bash bench.sh",
  cells: [{ id: "a", dtype: "bf16", groups }],
  tolerance: { rtol: 1e-2, atol: 1e-3 },
  scopeGlobs: ["kernel/**"],
  noiseFloorPct: 2,
});
if (normalized.errors.length > 0) throw new Error(normalized.errors.join("\n"));
const written = writeContractFiles({ root: ROOT, contract: normalized.contract });
if (!written.ok) throw new Error(written.errors.join("\n"));

// The change under test, and the reading that covers every cell x group.
fs.writeFileSync(path.join(ROOT, "kernel", "attn.cu"), "v2\n");
const contractSha = (await import("node:crypto")).createHash("sha256").update(fs.readFileSync(path.join(ROOT, "kernel.contract.json"))).digest("hex");
const cells = groups.map((group) => ({ id: "a", group: group.name, metric: `latency_us_a_${group.name}`, median: 9.1, samples: 5, spreadPct: 1.1 }));
const geomean = Number(Math.exp(cells.reduce((sum, cell) => sum + Math.log(cell.median), 0) / cells.length).toPrecision(10));
const reading = {
  schemaVersion: 1,
  contractSha,
  basis: "device",
  basisSource: "task-reported",
  gpu: {
    available: true, name: "NVIDIA H200", index: 0, visible: "0",
    start: { clocksSmMhz: 1980, clocksMemMhz: 1593, utilPct: 0, foreignProcessMiB: 0 },
    end: { clocksSmMhz: 1980, clocksMemMhz: 1593, utilPct: 44, foreignProcessMiB: 0 },
  },
  cells,
  shellMs: 4120, hostEnqueueMs: 0.18, deviceMs: 9.1, hostBoundRatio: 0.0198, hostBoundVerdict: "ok",
  startedAt: "2026-11-10T08:00:00Z", finishedAt: "2026-11-10T08:00:05Z", warnings: [],
};
const keep = (overrides: Record<string, unknown> = {}) => ({
  workspace: ROOT,
  decision: "keep" as const,
  description: "keep the accumulator in registers through the epilogue",
  metrics: { geomean_speedup: 1.12, latency_us_a: geomean },
  reading: `${READING_START_MARKER}\n${JSON.stringify(reading)}\n${READING_END_MARKER}\n`,
  exec: processExec(),
  ...overrides,
});

const MILESTONE = `# Milestone: fused attention epilogue

## 1. Problem and Target
20% of the decode time is the epilogue writing the accumulator to smem and reading it back.

## 2. Contract
- basis: device
- cells: a
- groups: typical, zero_block, tail

## 3. DAG and Phase Order
M0 first.

### M0 Contract
- tile: 128x128 bf16
- smem: 64 KiB, 2 stages
- warp roles: 4 mma, 4 copy
- register budget: 168
- issue order: cp.async, ldmatrix, mma
- accumulator precision: fp32

### M0 Architecture
#### D0.1 Fuse the epilogue into registers
- Action: keep the accumulator in registers and write the output once
- Purpose: remove the smem round trip the epilogue costs
- Trigger: ncu reports epilogue time above 20% of the kernel
- Cost: half a day, one new register window
- Depends on: none

#### D0.2 Stage two tiles through cp.async
- Action: prefetch tile k+1 while the mma of tile k issues
- Purpose: hide the global load
- Trigger: long scoreboard above 40% on a/typical
- Cost: one day
- Depends on: ⇐ D0.1

### M0 Gate
- device_ms drops by 15% on a/typical [VERIFY: mechanism]
- every group still matches the reference within its epsilon [VERIFY: correctness]

## 4. Dead Ends
- D0.1+D0.2 | the pair spills 190 registers at 128x128 | profile:run2

## 5. Global Gate
The gate holds on every group.

## 6. Rules
A decision is a five-tuple.
`;

const say = (heading: string, body: string): void => {
  console.log(`\n${"=".repeat(72)}\n${heading}\n${"=".repeat(72)}\n${body.trim()}`);
};

say(
  "1. no plan yet: the keep is recorded, and the record says it names no decision",
  formatCandidateOutcome(await recordCandidate(keep())),
);

fs.writeFileSync(path.join(ROOT, "docs", "milestone.md"), MILESTONE);
say("2. the plan written", MILESTONE.split("\n").filter((line) => /^####|^- D0/.test(line)).join("\n"));

say(
  "3. a keep naming a decision the plan does not have",
  formatCandidateOutcome(await recordCandidate(keep({ milestoneDecision: "D3.7" }))),
);

say("4. the same keep, naming D0.1", formatCandidateOutcome(await recordCandidate(keep({ milestoneDecision: "D0.1" }))));

say("5. the dead-ended pair, no precondition", formatCandidateOutcome(await recordCandidate(keep({ milestoneDecision: "D0.2+D0.1" }))));

say(
  "6. the same pair with a precondition",
  formatCandidateOutcome(
    await recordCandidate(
      keep({
        milestoneDecision: "D0.2+D0.1",
        precondition: "the 190-register spill was the 128x128 tile; this candidate keeps 64x128 and has room",
      }),
    ),
  ),
);

say("7. candidates.jsonl, the three fields", readCandidates(ROOT).map((record) => `${record.id} ${record.decision} milestoneDecision=${record.milestoneDecision} milestoneSha=${record.milestoneSha === null ? "null" : record.milestoneSha.slice(0, 12)} precondition=${record.precondition === null ? "null" : "recorded"}`).join("\n"));

say("8. benchmark.csv", fs.readFileSync(path.join(ROOT, "benchmark.csv"), "utf8").trim());
