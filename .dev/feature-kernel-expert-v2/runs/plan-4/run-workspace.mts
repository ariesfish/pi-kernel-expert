/**
 * T-016: one workspace, every plan-module behaviour driven through the real tools.
 *
 *   node --experimental-strip-types run-workspace.mts build   # steps 1..11
 *   node --experimental-strip-types run-workspace.mts diagnose # step 12, needs reviewer.md
 *
 * The workspace is a plausible task (fused attention epilogue, two cells, three
 * groups each) and every number in it comes from the tools: the contract is
 * generated, the profile summaries are built by buildProfileSummary, the keeps
 * are recorded by recordCandidate against a reading block that covers every cell.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import kernelExpertExtension from "../../../../extensions/pi-kernel-expert/index.ts";
import { readCandidates, recordCandidate } from "../../../../extensions/pi-kernel-expert/kernel/candidates.ts";
import { diffFingerprint } from "../../../../extensions/pi-kernel-expert/kernel/diff.ts";
import { buildProfileSummary } from "../../../../extensions/pi-kernel-expert/kernel/profile.ts";
import { READING_END_MARKER, READING_START_MARKER } from "../../../../extensions/pi-kernel-expert/kernel/reading.ts";
import { DRAFT_HEADINGS, PLAN_HEADINGS, workspacePaths } from "../../../../extensions/pi-kernel-expert/workspace/layout.ts";
import { fakeCommandContext, fakePi } from "../../../../tests/helpers/fake-host.mjs";
import { processExec } from "../../../../tests/helpers/process-exec.mjs";

const MODE = process.argv[2] ?? "build";
const ROOT = path.resolve(".work");
const say = (heading: string, body: string): void => {
  console.log(`\n${"=".repeat(72)}\n${heading}\n${"=".repeat(72)}\n${body.replace(/\s+$/, "")}`);
};
const git = (args: string[]): string => execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();

const pi = fakePi({ exec: processExec() });
kernelExpertExtension(pi);
const { ctx } = fakeCommandContext({ cwd: ROOT });
const call = async (name: string, params: Record<string, unknown> = {}): Promise<string> => {
  const result = await pi.tools.get(name).execute("call", params, undefined, undefined, ctx);
  return result.content[0].text;
};

const GROUPS = [
  { name: "typical", intent: "random normal inputs, the ordinary case" },
  { name: "zero_block", intent: "a fully masked block must not divide by zero" },
  { name: "tail", intent: "a length off the tile boundary must not read past M" },
];

const MILESTONE = `# Milestone: fused attention epilogue

## 1. Problem and Target
Decode attention at m1024 spends 20% of its 1.9 ms in the epilogue: the accumulator
goes out to smem and comes straight back. The target is that share below 5%, with
geomean_speedup at 1.15 or better on the frozen contract.

## 2. Contract
- basis: device
- cells: a (bf16), b (fp8)
- groups: typical, zero_block, tail
- harness: goal.sh, goal.checks.sh (generated; a candidate may not edit them)

## 3. DAG and Phase Order
M0 Contract, then M0 Architecture. M1 waits for M0's gate: the epilogue's cost has
to be gone before the K loop is worth splitting.

### M0 Contract
- tile: 128x128 accumulator, 4 mma warps
- smem: 64 KiB, 2 stages
- warp roles: 4 mma, 4 copy
- register budget: 168
- issue order: cp.async, ldmatrix, mma, st.global
- accumulator precision: fp32

### M0 Architecture
#### D0.1 Fuse the epilogue into registers
- Action: keep the accumulator in registers and write the output once
- Purpose: remove the smem round trip the epilogue costs
- Trigger: ncu reports epilogue time above 20% of the kernel on a/typical
- Cost: half a day, one extra register window
- Depends on: none

#### D0.2 Stage two tiles through cp.async
- Action: prefetch tile k+1 while the mma of tile k issues
- Purpose: hide the global load behind the mma
- Trigger: long scoreboard above 40% on a/typical
- Cost: one day
- Depends on: ⇐ D0.1

### M0 Gate
- epilogue share drops below 5% on a/typical [VERIFY: ncu-direct profile:run1]
- every cell and group still matches the reference within its epsilon [VERIFY: correctness cell-group: a/typical]
- one warp request reads four sectors, not 128 [VERIFY: ncu-derived profile:run1]
- the epilogue is gone, which is why device_ms moved [VERIFY: mechanism]

## 4. Dead Ends
- D0.1+D0.2 | the pair spills 190 registers at 128x128 | profile:run2

## 5. Global Gate
Both cells on every group, and goal.checks.sh green on the promoted kernel.

## 6. Rules
A candidate may not change the register budget while it is frozen, and may not
edit goal.sh or goal.checks.sh.
`;

function keepInput(overrides: Record<string, unknown> = {}) {
  const cells: Array<Record<string, unknown>> = [];
  for (const cell of ["a", "b"]) {
    for (const group of GROUPS) {
      cells.push({ id: cell, group: group.name, metric: `latency_us_${cell}_${group.name}`, median: cell === "a" ? 9.1 : 11.4, samples: 5, spreadPct: 1.1 });
    }
  }
  const metrics: Record<string, number> = { geomean_speedup: 1.12 };
  for (const cell of ["a", "b"]) {
    const values = cells.filter((entry) => entry.id === cell).map((entry) => entry.median as number);
    metrics[`latency_us_${cell}`] = Number(Math.exp(values.reduce((sum, value) => sum + Math.log(value), 0) / values.length).toPrecision(10));
  }
  const contractSha = createHash("sha256").update(fs.readFileSync(workspacePaths(ROOT).contract)).digest("hex");
  const reading = {
    schemaVersion: 1,
    contractSha,
    basis: "device",
    basisSource: "task-reported",
    gpu: {
      available: true, name: "NVIDIA H200", index: 0, visible: "0",
      start: { clocksSmMhz: 1980, clocksMemMhz: 3201, utilPct: 0, foreignProcessMiB: 0 },
      end: { clocksSmMhz: 1980, clocksMemMhz: 3201, utilPct: 44, foreignProcessMiB: 0 },
    },
    cells,
    shellMs: 4120, hostEnqueueMs: 0.18, deviceMs: 9.1, hostBoundRatio: 0.0198, hostBoundVerdict: "ok",
    startedAt: "2026-11-10T08:00:00Z", finishedAt: "2026-11-10T08:00:05Z", warnings: [],
  };
  return {
    workspace: ROOT,
    decision: "keep" as const,
    description: "keep the accumulator in registers through the epilogue",
    metrics,
    reading: `${READING_START_MARKER}\n${JSON.stringify(reading)}\n${READING_END_MARKER}\n`,
    exec: processExec(),
    ...overrides,
  };
}

function profile(runId: string, diffHash: string, contractSha: string, metrics: Record<string, number>): void {
  const dir = path.join(ROOT, "profile", runId);
  fs.mkdirSync(path.join(dir, "analysis"), { recursive: true });
  fs.writeFileSync(path.join(dir, "analysis", "metrics_key_full.json"), JSON.stringify({ __kernel_name__: "fmha_fwd", ...metrics }, null, 2));
  const outcome = buildProfileSummary({
    dir, runId, tag: "full", contractSha, diffHash, gitHead: git(["rev-parse", "HEAD"]),
    gpu: { name: "NVIDIA H200", clockSm: "1980", clockMem: "3201" }, ncuVersion: "2025.3.1", report: null,
  });
  if (!outcome.ok) throw new Error(outcome.errors.join("\n"));
}

if (MODE === "build") {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(ROOT, { recursive: true });
  git(["init", "-q"]);
  git(["config", "user.email", "evidence@example.com"]);
  git(["config", "user.name", "Evidence"]);
  fs.mkdirSync(path.join(ROOT, "kernel"));
  fs.writeFileSync(path.join(ROOT, "kernel", "attn.cu"), "v1\n");
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "base"]);

  say("1. kernel_init", await call("kernel_init"));
  const paths = workspacePaths(ROOT);
  fs.writeFileSync(paths.draft, ["# draft", ...DRAFT_HEADINGS.flatMap((h) => [`## ${h}`, `text ${h}`, ""])].join("\n"));
  fs.writeFileSync(paths.plan, ["# plan", ...PLAN_HEADINGS.flatMap((h) => [`## ${h}`, `text ${h}`, ""])].join("\n"));

  say("2. kernel_contract, milestone still the template", (await call("kernel_contract", {
    objective: "cut the epilogue cost",
    check_command: "bash check.sh",
    benchmark_command: "bash bench.sh",
    cells: [{ id: "a", dtype: "bf16", groups: GROUPS }, { id: "b", dtype: "fp8", groups: GROUPS }],
    rtol: 1e-2, atol: 1e-3,
    // The candidate change is the kernel. With the whole tree in scope, editing
    // the plan would invalidate every profile taken before the edit — and the
    // plan is where the loop writes what it learned.
    scope_globs: ["kernel/**"],
  })).split("\nfreeze_criteria payload:")[0]);

  // The contract — including the harness it generates — is committed before any
  // candidate is recorded, so the harness fingerprint does not include it.
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "freeze the contract"]);
  const contractSha = createHash("sha256").update(fs.readFileSync(paths.contract)).digest("hex");
  const kernelFile = path.join(ROOT, "kernel", "attn.cu");

  /** The diff hash of the tree as it stands, with the kernel at `body`. */
  const hashWith = async (body: string): Promise<string> => {
    fs.writeFileSync(kernelFile, body);
    const fingerprint = await diffFingerprint({ exec: processExec(), root: ROOT, scopeGlobs: ["kernel/**"] });
    if (!fingerprint.ok) throw new Error(fingerprint.reason);
    return fingerprint.value.hash;
  };

  // The plan is written first, but validated after the profile it cites exists:
  // a gate line naming profile:run1 is refused until run1 is on disk.
  fs.writeFileSync(paths.milestone, MILESTONE);

  // C1's change, and the profile of *that* diff: a profile taken before the
  // change measures a change nobody made, which is what `profile-stale` is for.
  const h1 = await hashWith("v2 // fused epilogue\n");
  profile("run1", h1, contractSha, { "smsp__warp_issue_stalled_short_scoreboard_per_warp_active.pct": 31.7, "sm__throughput.avg.pct_of_peak_sustained_elapsed": 61.2, "launch__waves_per_multiprocessor": 1.12 });

  say("3. the plan, validated against the profile that exists", await call("kernel_milestone"));

  say("4. kernel_milestone lock: M0 freezes", await call("kernel_milestone", { lock: true }));

  say(
    "5. a keep naming a decision the plan does not have",
    await call("kernel_candidate", {
      decision: "keep",
      description: "fuse the epilogue",
      milestone_decision: "D3.7",
      reading: keepInput().reading,
      metrics: keepInput().metrics,
    }),
  );

  // The row lands: a real decision is added and the same keep is recorded.
  fs.writeFileSync(paths.milestone, fs.readFileSync(paths.milestone, "utf8").replace("### M0 Gate", `#### D0.3 Split the output writeback across the 8 warps
- Action: write the output from all eight warps, each holding half a subtile
- Purpose: fund the fused epilogue inside the frozen register budget
- Trigger: local ld/st sectors above zero at 168 registers on a/typical
- Cost: two days, one new subtile pass
- Depends on: ⇐ D0.1

### M0 Gate`));
  say("6. the decision row lands, and the milestone still validates", (await call("kernel_milestone")).split("\n").slice(0, 2).join("\n"));

  const kept = await recordCandidate(
    keepInput({
      milestoneDecision: "D0.3",
      profileRun: "run1",
      bottleneck: { claim: "the smem round trip is the stall", metric: "smsp__warp_issue_stalled_short_scoreboard_per_warp_active.pct" },
      wiki: { none: true },
    }),
  );
  say(
    "7. the same keep, naming D0.3",
    kept.ok
      ? `recorded ${kept.record.id} (${kept.record.decision}) milestone=${kept.record.milestoneDecision} sha=${kept.record.milestoneSha?.slice(0, 12)} profile=${kept.record.profile?.runId} geomean=${kept.record.metrics.geomean_speedup}`
      : kept.errors.join("\n"),
  );

  const ms = paths.milestone;
  fs.writeFileSync(ms, fs.readFileSync(ms, "utf8").replace("- warp roles: 4 mma, 4 copy", "- warp roles: 8 mma, 4 copy"));
  say("8. an M0 edit after the lock", await call("kernel_milestone"));

  say("9. unlock with the reason that lets it move", await call("kernel_milestone", { unlock: true, reason: "D0.3 splits the writeback across eight mma warps, so the warp split in M0 is no longer the layout the plan measured; 168 registers still holds" }));

  const relocked = await call("kernel_milestone", { lock: true });
  say("10. re-locked on the new M0", `${relocked.split("\n")[0]}\n${fs.readFileSync(ms, "utf8").split("## 4. Dead Ends")[1].split("## 5.")[0].trim()}`);

  // Three rejects, each against its own diff and its own profile: the plateau
  // this ticket has to diagnose is three attempts that *did* measure.
  const attempts = [
    ["run2", "v3 // 128-bit epilogue stores\n", "widen the epilogue store to 128-bit vectors", "geomean 1.001 is below the 2% noise floor; short scoreboard unchanged at 30.9%"],
    ["run3", "v4 // epilogue hoisted into its own kernel\n", "hoist the epilogue into a second kernel", "host-bound: hostEnqueueMs 0.42 against deviceMs 0.19 on a/typical"],
    ["run4", "v5 // register budget raised to 210\n", "raise the register budget to 210", "waves/SM 0.75 from 1.12 and geomean 0.94: the extra registers cost occupancy"],
  ];
  for (const [runId, body, description, reason] of attempts) {
    const hash = await hashWith(body);
    profile(runId, hash, contractSha, { "smsp__warp_issue_stalled_short_scoreboard_per_warp_active.pct": runId === "run2" ? 30.9 : runId === "run3" ? 29.4 : 33.8, "launch__waves_per_multiprocessor": runId === "run4" ? 0.75 : 1.11 });
    const rejected = await recordCandidate({ workspace: ROOT, decision: "reject", description, reason, milestoneDecision: "D0.3", profileRun: runId, exec: processExec() });
    if (!rejected.ok) throw new Error(rejected.errors.join("\n"));
  }

  const ledger = readCandidates(ROOT).map((record) => `${record.id} ${record.decision} ${record.milestoneDecision ?? "-"} profile=${record.profile?.runId ?? "-"} ${record.description}`);
  say("11. the ledger the reviewer will see", ledger.join("\n"));
  say("12. benchmark.csv", fs.readFileSync(path.join(ROOT, "benchmark.csv"), "utf8").trim());
  console.log("\nREADY FOR REVIEWER: one keep on D0.3, then three rejects on D0.3, each with its own profile.\n");
}

if (MODE === "diagnose") {
  const block = fs.readFileSync("reviewer.md", "utf8").trim();
  const paths = workspacePaths(ROOT);
  const milestone = fs.readFileSync(paths.milestone, "utf8");
  fs.writeFileSync(paths.milestone, milestone.replace("## 5. Global Gate", `${block}\n\n## 5. Global Gate`));
  say("12. the reviewer's block, validated by kernel_milestone", await call("kernel_milestone"));
  say("13. the diagnosis as the summary reports it", (await call("kernel_milestone")).split("\n").filter((line) => /Diagnosis/.test(line)).join("\n"));
}
