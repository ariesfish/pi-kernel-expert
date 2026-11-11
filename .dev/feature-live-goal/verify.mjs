import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { digest, repo, textOf, withRuntime, goalRoot } from "./runtime.mjs";
import { attachProfile } from "./profile.mjs";

const audit = path.join(repo, ".dev/audit/live-goal");
fs.mkdirSync(audit, { recursive: true });
const stateFile = path.join(audit, "state.json");
const phase = process.argv[2] ?? "prepare";
const sh = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const write = (root, file, text) => { fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), text); };
const git = (root, ...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();

if (phase === "prepare") {
  assert.ok(!fs.existsSync(stateFile), "A prepared task already exists; inspect state.json instead of overwriting it");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kernel-live-goal-"));
  const remote = `/root/pkex/live-goal-${path.basename(root).split("-").at(-1)}`;
  const state = { root, remote, host: "builder", gpu: 3, preparedAt: new Date().toISOString(), kernelCommit: git(repo, "rev-parse", "HEAD"), goalCommit: git(goalRoot, "rev-parse", "HEAD") };
  fs.writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`);
  git(root, "init", "-q"); git(root, "config", "user.name", "Integration verification"); git(root, "config", "user.email", "integration@example.invalid");
  write(root, ".gitignore", "runs/\nprofile/\ncandidates.jsonl\nbenchmark.csv\n.kernel/\n.goal/\n");
  write(root, "src/kernel.cuh", fs.readFileSync(path.join(repo, ".dev/feature-live-goal/fixtures/kernel.cuh"), "utf8"));
  write(root, "harness/harness.cu", fs.readFileSync(path.join(repo, ".dev/feature-live-goal/fixtures/harness.cu"), "utf8"));
  write(root, "harness/remote.sh", `#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${'${BASH_SOURCE[0]}'}")/.."
remote=${sh(remote)}
mode=${'${1:-bench}'}
sha=$(shasum -a 256 src/kernel.cuh | awk '{print $1}')
if [[ "$mode" == build ]]; then
  ssh -o BatchMode=yes -o ConnectTimeout=10 builder "mkdir -p '$remote/src'"
  scp -q src/kernel.cuh "builder:$remote/src/kernel.cuh"
  scp -q harness/harness.cu "builder:$remote/harness.cu"
  ssh -o BatchMode=yes builder "cd '$remote' && /usr/local/cuda-13.0/bin/nvcc -O3 -lineinfo -arch=sm_90 -Isrc -o task harness.cu && printf '%s\\n' '$sha' > build.sha"
  exit 0
fi
[[ "$mode" =~ ^(bench|reference|check|calibrate)$ ]] || exit 2
group=${'${KERNEL_GROUP:-typical}'}
[[ "$group" =~ ^(typical|zero_block|tail)$ ]] || exit 2
block=${'${2:-256}'}
[[ "$block" =~ ^[0-9]+$ ]] || exit 2
exec ssh -o BatchMode=yes -o ConnectTimeout=10 builder "cd '$remote' && test \\$(cat build.sha) = '$sha' && CUDA_VISIBLE_DEVICES=3 KERNEL_GROUP='$group' KERNEL_ATOL='0.000001' ./task '$mode' '$block'"
`);
  write(root, "harness/bin/nvidia-smi", "#!/usr/bin/env bash\nexec ssh -o BatchMode=yes -o ConnectTimeout=10 builder nvidia-smi \"$@\"\n");
  fs.chmodSync(path.join(root, "harness/bin/nvidia-smi"), 0o755);
  write(root, "goal.md", "# Live SAXPY integration verification\n\nPrimary metric: geomean_speedup, higher is better.\nKernel correctness and device time come from the same candidate on builder H200 card 3.\nOnly src/kernel.cuh may change. Freeze the generated correctness matrix before baseline.\nStop after a baseline, a coalesced candidate, and a deliberately incorrect candidate with rollback.\nThis is a protocol acceptance task, not a production kernel performance claim.\n");
  write(root, "goal.config.json", `${JSON.stringify({ maxIterations: 4 }, null, 2)}\n`);
  await withRuntime(root, async ({ call }) => {
    await call("kernel_init", {});
    const draft = {
      Objective: "Exercise a frozen Task Contract, real GPU reading, Candidate lineage, and pi-goal settlement.",
      "Baseline and validation": "Start with a correct strided SAXPY. Check the same kernel against a double CPU reference on typical, zero_block and tail data. Device timing uses CUDA events around 100 launches.",
      "Risks and unknowns": "Clock drift remains possible with unlocked clocks. Record GPU identity and both clock samples. Any host-bound reading or failed check is rejected.",
      "Candidate directions": "D1 maps adjacent lanes to adjacent elements; D2 changes the block size while retaining the strided mapping. Probe each before freezing.",
      "Commands and environment": "bash harness/remote.sh build; CUDA_VISIBLE_DEVICES=3 on builder. nvcc 13.0.88, sm_90, O3, lineinfo. Harness source and commands are protected.",
      "Evidence required": "Raw stdout, checks, five samples per group, calibration, Candidate ledger, pi-goal journal and attempt patch. No bottleneck claim without ncu evidence.",
    };
    const { DRAFT_HEADINGS, PLAN_HEADINGS } = await import(path.join(repo, "extensions/pi-kernel-expert/workspace/layout.ts"));
    write(root, "docs/draft.md", `# Live integration draft\n\n${DRAFT_HEADINGS.map((heading) => `## ${heading}\n${draft[heading] ?? "Run the GPU commands recorded in goal.md and retain their outputs under runs/."}\n`).join("\n")}`);
    const plan = ["Compile the baseline, probe both directions, and freeze the exact matrix with human approval.", "Archive every run, precision calibration, Candidate decision, and pi-goal keep or rollback.", "Stop after the incorrect kernel is rejected and the accepted source is restored; never alter clocks or the frozen harness."];
    write(root, "docs/plan.md", `# Live integration plan\n\n${PLAN_HEADINGS.map((heading, index) => `## ${heading}\n${plan[index]}\n`).join("\n")}`);
    // This first acceptance run has a bounded executable plan, without a milestone gate.
    fs.unlinkSync(path.join(root, "docs/milestone.md"));
    const generated = await call("kernel_contract", {
      objective: "Verify the live pi-goal loop on one H200 using a correct SAXPY baseline, a coalesced candidate and an incorrect candidate with rollback",
      check_command: "bash harness/remote.sh check", benchmark_command: "bash harness/remote.sh bench",
      calibrate_command: "bash harness/remote.sh calibrate", reference_command: "bash harness/remote.sh reference",
      cells: [{ id: "saxpy", dtype: "fp32", vars: { N: "16777216" }, groups: [
        { name: "typical", intent: "deterministic signed fp32 inputs across all indices" },
        { name: "zero_block", intent: "a quarter of x is zero while y remains nonzero" },
        { name: "tail", intent: "37 extra elements exercise a partial final block" },
      ] }],
      rtol: 0, atol: 1e-6, basis: "device", repeats: 5, warmup: 1, burn_in_ms: 0,
      guard_pct: 5, noise_floor_pct: 2, checks_timeout_seconds: 180,
      harness_globs: ["goal.sh", "goal.checks.sh", "harness/**", ".kernel/calibration.json", ".kernel/precision.tsv", ".kernel/baseline.tsv"],
      scope_globs: ["src/**"], test_globs: ["harness/**"],
    });
    assert.ok(generated.details.freeze, textOf(generated));
  });
  git(root, "add", ".gitignore", "src", "harness", "docs", "goal.md", "goal.config.json", "goal.sh", "goal.checks.sh", "kernel.contract.json", "kernel-freeze.json");
  git(root, "commit", "-q", "-m", "test(integration): prepare the frozen SAXPY harness");
  execFileSync("bash", ["harness/remote.sh", "build"], { cwd: root, stdio: "inherit", timeout: 90000 });
  const identity = execFileSync("ssh", ["-o", "BatchMode=yes", "builder", "hostname; uptime; nproc; nvidia-smi -i 3 --query-gpu=name,uuid,driver_version,clocks.sm,clocks.mem,utilization.gpu,memory.used --format=csv; /usr/local/cuda-13.0/bin/nvcc --version; /opt/nvidia/nsight-compute/2025.3.1/ncu --version"], { encoding: "utf8", timeout: 20000 });
  write(root, "runs/hardware.txt", identity);
  await withRuntime(root, async ({ call }) => {
    await call("frame_goal", { directions: [
      { id: "D1", title: "Coalesced memory mapping", mechanism: "Map adjacent lanes to adjacent elements", proxyMetric: "latency_us", cost: "one compiled reference run", risk: "Incorrect bounds at the tail", killIf: "Reference is not materially faster than the strided baseline" },
      { id: "D2", title: "Launch geometry", mechanism: "Use 128 threads per block to change occupancy and grid geometry", proxyMetric: "latency_us", cost: "one baseline run", risk: "More blocks may increase scheduling cost", killIf: "Deferred once the coalesced direction satisfies this acceptance task" },
    ] });
    await call("probe_goal", { direction_id: "D1", command: "bash harness/remote.sh reference", timeout_seconds: 30, decision: "keep", note: "Coalesced reference timing is a feasibility proxy; the candidate must still pass the full frozen matrix." });
    await call("probe_goal", { direction_id: "D2", command: "bash harness/remote.sh bench 128", timeout_seconds: 30, decision: "kill", note: "Measured as a separate mechanism; defer block tuning to keep this acceptance run bounded to one implementation change." });
  });
  state.approvalSha = digest(fs.readFileSync(path.join(root, "kernel-freeze.json")));
  fs.writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`);
  fs.copyFileSync(path.join(root, "kernel-freeze.json"), path.join(audit, "kernel-freeze.json"));
  fs.copyFileSync(path.join(root, "kernel.contract.json"), path.join(audit, "kernel.contract.json"));
  fs.copyFileSync(path.join(root, "runs/hardware.txt"), path.join(audit, "hardware.txt"));
  console.log(`READY FOR HUMAN FREEZE: ${state.approvalSha}\nTask: ${root}\nRemote: ${remote}`);
} else if (["run", "resume", "repair", "finish"].includes(phase)) {
  const resume = phase !== "run";
  const repair = phase === "repair" || phase === "finish";
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  const root = state.root;
  const suppliedApproval = process.argv[3];
  assert.equal(suppliedApproval, state.approvalSha, "Pass the SHA explicitly confirmed by the human");
  assert.equal(digest(fs.readFileSync(path.join(root, "kernel-freeze.json"))), suppliedApproval);
  const source = path.join(root, "src/kernel.cuh");
  const build = () => execFileSync("bash", ["harness/remote.sh", "build"], { cwd: root, stdio: "inherit", timeout: 90000 });
  // The generated script executes locally; its GPU-state reader delegates to
  // the same remote card used by the immutable harness commands.
  process.env.CUDA_VISIBLE_DEVICES = String(state.gpu);
  process.env.PATH = `${path.join(root, "harness/bin")}:${process.env.PATH}`;
  await withRuntime(root, async ({ call }) => {
    if (!resume) {
      const payload = JSON.parse(fs.readFileSync(path.join(root, "kernel-freeze.json"), "utf8"));
      const freeze = await call("freeze_criteria", payload);
      assert.ok(textOf(freeze).includes("Contract frozen:"), textOf(freeze));
      await call("validate_goal", { dry_run: false });
      const calibration = await call("bash", { command: "bash goal.checks.sh --calibrate", timeout: 60 });
      assert.ok(!textOf(calibration).includes("unmeasured dtype"), textOf(calibration));
    }

    const run = async (label) => {
      const result = await call("run_goal", { command: "bash goal.sh", timeout_seconds: 180, checks_timeout_seconds: 180 });
      const details = result.details;
      const stdout = details.fullOutputPath ? fs.readFileSync(details.fullOutputPath, "utf8") : details.tailOutput;
      write(root, `runs/${label}.stdout`, stdout);
      write(root, `runs/${label}.checks`, details.checksOutput ?? "");
      return { result, details, metrics: details.parsedMetrics, reading: `runs/${label}.stdout` };
    };
    const log = async (measured, status, description, asi) => {
      const metrics = { ...measured.metrics };
      delete metrics.geomean_speedup;
      const result = await call("log_goal", { commit: git(root, "rev-parse", "--short=7", "HEAD"), metric: measured.details.parsedPrimary ?? 0, status, description, metrics, asi });
      assert.ok(result.details.runResult, textOf(result));
      return result;
    };

    const savedRun = (index, label) => {
      const files = fs.readdirSync(path.join(root, "runs/runtime")).filter((file) => file.endsWith("-run_goal.json")).sort();
      const { result } = JSON.parse(fs.readFileSync(path.join(root, "runs/runtime", files[index]), "utf8"));
      return { result, details: result.details, metrics: result.details.parsedMetrics, reading: `runs/${label}.stdout` };
    };
    const baseline = resume ? savedRun(0, "baseline") : await run("baseline");
    assert.equal(baseline.details.passed, true, textOf(baseline.result));
    assert.equal(baseline.details.parsedPrimary, 1);
    if (!resume) await log(baseline, "keep", "test(integration): record the measured SAXPY baseline", { hypothesis: "Establish the unchanged strided kernel under the frozen contract", gpu: state.gpu, clocks: "unlocked", scope: "integration acceptance" });

    const coalesced = `#pragma once\n\n__global__ void saxpy_candidate(int n, float a, const float *x, float *y) {\n  const int i = blockIdx.x * blockDim.x + threadIdx.x;\n  if (i < n) y[i] = a * x[i] + y[i];\n}\n`;
    if (!resume) {
      fs.writeFileSync(source, coalesced);
      build();
    }
    const candidate = phase === "finish" ? savedRun(2, "coalesced-recovery") : repair ? await run("coalesced-recovery") : resume ? savedRun(1, "coalesced") : await run("coalesced");
    assert.equal(candidate.details.passed, true, textOf(candidate.result));
    assert.ok(candidate.details.parsedPrimary > 1.02);
    let profile;
    if (repair) {
      profile = attachProfile(state);
      const previousPath = process.env.PATH;
      process.env.PATH = `${profile.adapters}:${previousPath}`;
      try {
        const attached = await call("kernel_profile", { run_id: profile.runId, report: profile.report, reuse_analysis: true, kernel: "saxpy_candidate" });
        assert.ok(attached.details.summary, textOf(attached));
      } finally {
        process.env.PATH = previousPath;
        fs.rmSync(profile.adapters, { recursive: true, force: true });
      }
    }
    let keep;
    if (resume && !repair) {
      const files = fs.readdirSync(path.join(root, "runs/runtime")).filter((file) => file.endsWith("-kernel_candidate.json")).sort();
      keep = JSON.parse(fs.readFileSync(path.join(root, "runs/runtime", files.at(-1)), "utf8")).result;
    } else {
      keep = await call("kernel_candidate", { decision: "keep", description: "Map neighboring lanes to neighboring elements", metrics: candidate.metrics, reading: candidate.reading, ...(profile ? { profile_run: profile.runId } : {}), wiki: { none: true } });
    }
    assert.equal(keep.details.record?.decision, "keep", textOf(keep));
    await log(candidate, "keep", "perf(saxpy): coalesce candidate memory accesses", { hypothesis: "Adjacent lanes access adjacent elements", gpu: state.gpu, clocks: "unlocked", kernel_candidate: keep.details.record?.id, limitation: "No ncu limiter claim in this acceptance run" });
    const keptHead = git(root, "rev-parse", "HEAD");
    assert.equal(git(root, "show", "HEAD:src/kernel.cuh"), coalesced.trim());

    fs.writeFileSync(source, coalesced.replace("if (i < n) y[i] = a * x[i] + y[i];", "if (i < n) y[i] = (i + 1 < n && x[i] == 0.0f && x[i + 1] == 0.0f) ? 0.0f : a * x[i] + y[i];"));
    build();
    const broken = await run("broken-zero-block");
    assert.equal(broken.details.checksPass, false, textOf(broken.result));
    assert.match(broken.details.checksOutput, /FAIL cell saxpy group zero_block/);
    const refused = await call("kernel_candidate", { decision: "keep", description: "Incorrect zero-block fast path", metrics: broken.metrics, reading: broken.reading, wiki: { none: true } }, { allowRefusal: true });
    assert.equal(refused.details.record, undefined);
    assert.ok(refused.details.refusals.some((entry) => entry.rule === "precision-regression"), textOf(refused));
    const rejection = await call("kernel_candidate", { decision: "reject", description: "Incorrect zero-block fast path", reason: "The zero_block input group fails the fixed reference comparison and precision gate", metrics: broken.metrics, reading: broken.reading });
    assert.equal(rejection.details.record?.decision, "reject", textOf(rejection));
    await log(broken, "checks_failed", "test(integration): reject the incorrect zero-block fast path", { hypothesis: "Exercise rejection despite a measurable device timing", rollback_reason: "zero_block fails correctness and precision", next_action_hint: "Restore the accepted coalesced kernel", kernel_candidate: rejection.details.record?.id });
    assert.equal(git(root, "rev-parse", "HEAD"), keptHead);
    assert.equal(fs.readFileSync(source, "utf8"), coalesced);
    const candidates = fs.readFileSync(path.join(root, "candidates.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
    assert.deepEqual(candidates.map((entry) => entry.decision), repair ? ["keep", "keep", "reject"] : ["keep", "reject"]);
    const attempts = [];
    const findAttempts = (dir) => { for (const item of fs.readdirSync(dir, { withFileTypes: true })) { const file = path.join(dir, item.name); if (item.isDirectory()) findAttempts(file); else if (file.endsWith(".patch")) attempts.push(file); } };
    findAttempts(path.join(root, ".goal"));
    assert.ok(attempts.some((file) => fs.readFileSync(file, "utf8").includes("x[i + 1]")));
    build();
    const restored = await call("bash", { command: "bash goal.checks.sh", timeout: 180 });
    assert.ok(textOf(restored).includes("checks ok:"), textOf(restored));
    write(root, "runs/summary.json", `${JSON.stringify({ baseline: baseline.metrics, candidate: candidate.metrics, broken: broken.metrics, keptHead, candidates: candidates.map((entry) => ({ id: entry.id, decision: entry.decision, verdict: entry.verdict, pairing: entry.pairing })), attempts, restoredChecksPassed: true }, null, 2)}\n`);
  }, suppliedApproval);
  fs.cpSync(path.join(root, "runs"), path.join(audit, "runs"), { recursive: true });
  if (fs.existsSync(path.join(root, "profile"))) fs.cpSync(path.join(root, "profile"), path.join(audit, "profile"), { recursive: true });
  fs.cpSync(path.join(root, ".goal"), path.join(audit, "goal-state"), { recursive: true });
  fs.cpSync(path.join(root, ".kernel"), path.join(audit, "kernel-state"), { recursive: true });
  for (const file of ["candidates.jsonl", "benchmark.csv"]) fs.copyFileSync(path.join(root, file), path.join(audit, file));
  write(audit, "git-log.txt", git(root, "log", "-3", "--format=full"));
  console.log(`LIVE LOOP VERIFIED: ${root}`);
} else {
  throw new Error(`Unsupported phase ${phase}`);
}
