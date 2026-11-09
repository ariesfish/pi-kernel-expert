import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import {
  formatCandidateOutcome,
  isSafeRunId,
  readCandidates,
  readContract,
  recordCandidate,
} from "../../extensions/pi-kernel-expert/kernel/candidates.ts";
import { normalizeContract, writeContractFiles } from "../../extensions/pi-kernel-expert/kernel/contract.ts";
import { diffFingerprint } from "../../extensions/pi-kernel-expert/kernel/diff.ts";
import { buildProfileSummary } from "../../extensions/pi-kernel-expert/kernel/profile.ts";
import { READING_END_MARKER, READING_START_MARKER } from "../../extensions/pi-kernel-expert/kernel/reading.ts";
import {
  DRAFT_HEADINGS,
  PLAN_HEADINGS,
  initWorkspace,
} from "../../extensions/pi-kernel-expert/workspace/layout.ts";
import { processExec } from "../helpers/process-exec.mjs";

const METRIC_NAMES = {
  geomean: "geomean_speedup",
  a: "latency_us_a",
  b: "latency_us_b",
};

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function fill(root) {
  const docs = path.join(root, "docs");
  fs.writeFileSync(
    path.join(docs, "draft.md"),
    ["# draft", ...DRAFT_HEADINGS.flatMap((h) => [`## ${h}`, `text ${h}`, ""])].join("\n"),
  );
  fs.writeFileSync(
    path.join(docs, "plan.md"),
    ["# plan", ...PLAN_HEADINGS.flatMap((h) => [`## ${h}`, `text ${h}`, ""])].join("\n"),
  );
}

async function setup({
  noiseFloorPct = 2,
  harnessGlobs,
  scopeGlobs = ["kernel/**"],
  extraFiles = {},
} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kernel-expert-cand-"));
  git(["init", "-q"], root);
  git(["config", "user.email", "test@example.com"], root);
  git(["config", "user.name", "Test"], root);
  fs.mkdirSync(path.join(root, "kernel"));
  fs.writeFileSync(path.join(root, "kernel", "attn.cu"), "v1\n");
  for (const [relative, body] of Object.entries(extraFiles)) {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
  }
  git(["add", "-A"], root);
  git(["commit", "-q", "-m", "base"], root);

  initWorkspace(root);
  fill(root);
  const normalized = normalizeContract({
    objective: "cut latency",
    checkCommand: "bash check.sh",
    benchmarkCommand: "bash bench.sh",
    cells: [
      {
        id: "a",
        dtype: "bf16",
        groups: [
          { name: "typical", intent: "random normal inputs, the ordinary case" },
          { name: "zero_block", intent: "a fully masked block must not divide by zero" },
          { name: "tail", intent: "a length off the tile boundary must not read past M" },
        ],
      },
      {
        id: "b",
        dtype: "fp8",
        groups: [
          { name: "typical", intent: "fp8 saturates at the reference scale" },
          { name: "zero_block", intent: "an all-zero block must not produce NaN" },
          { name: "tail", intent: "a partial tile must not read past N" },
        ],
      },
    ],
    tolerance: { rtol: 1e-2, atol: 1e-3 },
    scopeGlobs,
    harnessGlobs,
    noiseFloorPct,
  });
  assert.deepEqual(normalized.errors, []);
  const written = writeContractFiles({ root, contract: normalized.contract });
  assert.equal(written.ok, true);

  fs.writeFileSync(path.join(root, "kernel", "attn.cu"), "v2\n");
  const fingerprint = await diffFingerprint({ exec: processExec(), root, scopeGlobs });
  assert.equal(fingerprint.ok, true);
  const loaded = readContract(root);
  assert.equal(loaded.ok, true);

  return { root, contract: loaded.contract, contractSha: loaded.sha, fingerprint: fingerprint.value, exec: processExec() };
}

function writeProfile(ctx, runId, { metrics = {}, contractSha, diffHash } = {}) {
  const dir = path.join(ctx.root, "profile", runId);
  const analysis = path.join(dir, "analysis");
  fs.mkdirSync(analysis, { recursive: true });
  fs.writeFileSync(
    path.join(analysis, "metrics_key_full.json"),
    JSON.stringify({ "__kernel_name__": "fmha_fwd", ...metrics }, null, 2),
  );
  const outcome = buildProfileSummary({
    dir,
    runId,
    tag: "full",
    contractSha: contractSha ?? ctx.contractSha,
    diffHash: diffHash ?? ctx.fingerprint.hash,
    gitHead: ctx.fingerprint.head,
    gpu: { name: "NVIDIA H100", clockSm: "1980", clockMem: "2619" },
    ncuVersion: "2026.3.1",
    report: null,
  });
  assert.equal(outcome.ok, true, outcome.ok ? "" : outcome.errors.join("\n"));
  return dir;
}

/**
 * A reading block as the producer writes it, covering every cell x group of the
 * fixture contract (`a` and `b`, three groups each) and one aggregate per cell.
 * `group: "default"` is what a cell with no groups exports.
 */
function readingRecord(ctx, overrides = {}) {
  const cells = [];
  for (const cell of ctx.contract.cells) {
    const groups = cell.groups.length > 0 ? cell.groups.map((group) => group.name) : ["default"];
    for (const group of groups) {
      cells.push({ id: cell.id, group, metric: `latency_us_${cell.id}_${group}`, median: 9.1, samples: 5, spreadPct: 1.1 });
    }
  }
  return {
    schemaVersion: 1,
    contractSha: ctx.contractSha,
    basis: "device",
    basisSource: "task-reported",
    gpu: {
      available: true,
      name: "NVIDIA H200",
      index: 0,
      visible: "0",
      start: { clocksSmMhz: 1980, clocksMemMhz: 1593, utilPct: 0, foreignProcessMiB: 0 },
      end: { clocksSmMhz: 1980, clocksMemMhz: 1593, utilPct: 44, foreignProcessMiB: 0 },
    },
    cells,
    shellMs: 4120,
    hostEnqueueMs: 0.18,
    deviceMs: 9.1,
    hostBoundRatio: 0.0198,
    hostBoundVerdict: "ok",
    startedAt: "2026-11-10T08:00:00Z",
    finishedAt: "2026-11-10T08:00:05Z",
    warnings: [],
    ...overrides,
  };
}

function readingText(record) {
  return `${READING_START_MARKER}\n${JSON.stringify(record)}\n${READING_END_MARKER}\n`;
}

/** The per-cell metric each reading's own groups imply — the recorder now checks this arithmetic. */
function cellMetrics(record) {
  const byCell = new Map();
  for (const cell of record.cells) {
    const values = byCell.get(cell.id) ?? [];
    values.push(cell.median);
    byCell.set(cell.id, values);
  }
  const metrics = {};
  for (const [id, values] of byCell) {
    const geomean = Math.exp(values.reduce((sum, value) => sum + Math.log(value), 0) / values.length);
    metrics[`latency_us_${id}`] = Number(geomean.toPrecision(10));
  }
  return metrics;
}

function keepInput(ctx, overrides = {}) {
  const record = readingRecord(ctx);
  return {
    workspace: ctx.root,
    decision: "keep",
    description: "fuse the epilogue",
    metrics: {
      geomean_speedup: 1.12,
      ...cellMetrics(record),
    },
    reading: readingText(record),
    exec: ctx.exec,
    ...overrides,
  };
}

test("a keep with a fresh profile and a cited metric is recorded with lineage", async () => {
  const ctx = await setup();
  writeProfile(ctx, "run1", {
    metrics: { "l1tex__throughput.avg.pct_of_peak_sustained_elapsed": 8.4 },
  });

  const first = await recordCandidate(
    keepInput(ctx, {
      profileRun: "run1",
      bottleneck: { claim: "latency-bound on L1", metric: "l1tex__throughput.avg.pct_of_peak_sustained_elapsed" },
    }),
  );
  assert.equal(first.ok, true, first.ok ? "" : first.errors.join("\n"));
  assert.equal(first.record.id, "C1");
  assert.equal(first.record.parent, "baseline");
  assert.equal(first.record.profile.runId, "run1");
  assert.equal(first.record.bottleneck.value, 8.4);
  assert.match(formatCandidateOutcome(first), /recorded C1 \(keep\)/);

  const second = await recordCandidate(
    keepInput(ctx, { description: "tile the K loop", metrics: { ...keepInput(ctx).metrics, geomean_speedup: 1.2 } }),
  );
  assert.equal(second.ok, true);
  assert.equal(second.record.id, "C2");
  assert.equal(second.record.parent, "C1");

  const ledger = readCandidates(ctx.root);
  assert.equal(ledger.length, 2);
  assert.equal(fs.readFileSync(path.join(ctx.root, "candidates.jsonl"), "utf8").trim().split("\n").length, 2);
});

test("a keep below the noise floor is refused unless forced with a reason", async () => {
  const ctx = await setup();
  const noisy = await recordCandidate(
    keepInput(ctx, { metrics: { geomean_speedup: 1.01, latency_us_a: 9.1, latency_us_b: 9.1 } }),
  );
  assert.equal(noisy.ok, false);
  assert.match(noisy.errors.join("\n"), /below the 2% noise floor/);

  const forced = await recordCandidate(
    keepInput(ctx, {
      metrics: { geomean_speedup: 1.01, latency_us_a: 9.1, latency_us_b: 9.1 },
      forceWithReason: "removes a branch that was a correctness risk",
    }),
  );
  assert.equal(forced.ok, true);
  assert.equal(forced.record.forced, true);
  assert.equal(forced.record.forcedReason, "removes a branch that was a correctness risk");
});

test("a keep missing any matrix cell is refused", async () => {
  const ctx = await setup();
  const outcome = await recordCandidate(
    keepInput(ctx, { metrics: { geomean_speedup: 1.2, latency_us_a: 9.1 } }),
  );
  assert.equal(outcome.ok, false);
  assert.match(outcome.errors.join("\n"), /latency_us_b/);
});

test("a stale profile is refused and named", async () => {
  const ctx = await setup();
  writeProfile(ctx, "run1", { metrics: { "sm__throughput.avg.pct_of_peak_sustained_elapsed": 71 } });
  fs.writeFileSync(path.join(ctx.root, "kernel", "attn.cu"), "v3\n");

  const outcome = await recordCandidate(
    keepInput(ctx, { profileRun: "run1", bottleneck: { claim: "compute-bound", metric: "sm__throughput.avg.pct_of_peak_sustained_elapsed" } }),
  );
  assert.equal(outcome.ok, false);
  assert.match(outcome.errors.join("\n"), /is stale/);
});

test("a bottleneck metric absent from the report is refused", async () => {
  const ctx = await setup();
  writeProfile(ctx, "run1", { metrics: { "sm__throughput.avg.pct_of_peak_sustained_elapsed": 71 } });
  const outcome = await recordCandidate(
    keepInput(ctx, { profileRun: "run1", bottleneck: { claim: "DRAM-bound", metric: "gpu__dram_throughput.avg.pct_of_peak_sustained_elapsed" } }),
  );
  assert.equal(outcome.ok, false);
  assert.match(outcome.errors.join("\n"), /not present in profile run1/);
});

test("a bottleneck claim without a profile is refused", async () => {
  const ctx = await setup();
  const outcome = await recordCandidate(
    keepInput(ctx, { bottleneck: { claim: "compute-bound", metric: "sm__throughput.avg.pct_of_peak_sustained_elapsed" } }),
  );
  assert.equal(outcome.ok, false);
  assert.match(outcome.errors.join("\n"), /needs a profile run/);
});

test("a profile from an older contract is refused", async () => {
  const ctx = await setup();
  writeProfile(ctx, "run1", { metrics: { "sm__throughput.avg.pct_of_peak_sustained_elapsed": 71 }, contractSha: "f".repeat(64) });
  const outcome = await recordCandidate(keepInput(ctx, { profileRun: "run1" }));
  assert.equal(outcome.ok, false);
  assert.match(outcome.errors.join("\n"), /was taken under contract/);
});

test("rejections need a reason and record it", async () => {
  const ctx = await setup();
  const bare = await recordCandidate({ ...keepInput(ctx), decision: "reject" });
  assert.equal(bare.ok, false);
  assert.match(bare.errors.join("\n"), /needs a reason/);

  const rejected = await recordCandidate({
    ...keepInput(ctx),
    decision: "reject",
    reason: "12% faster but the 8192 cell regressed by 30%",
  });
  assert.equal(rejected.ok, true);
  assert.equal(rejected.record.reason, "12% faster but the 8192 cell regressed by 30%");
  assert.equal(rejected.record.profile, null);
});

test("unsafe run ids and non-numeric metrics are refused", async () => {
  const ctx = await setup();
  const traversal = await recordCandidate(keepInput(ctx, { profileRun: "../escape" }));
  assert.equal(traversal.ok, false);
  assert.match(traversal.errors.join("\n"), /plain directory name/);

  const badMetric = await recordCandidate(
    keepInput(ctx, { metrics: { geomean_speedup: "fast", latency_us_a: 1, latency_us_b: 2 } }),
  );
  assert.equal(badMetric.ok, false);
  assert.match(badMetric.errors.join("\n"), /must be a finite number/);
});

test("readContract refuses a v1 contract and an unversioned one instead of upgrading", async () => {
  const ctx = await setup();
  const file = path.join(ctx.root, "kernel.contract.json");
  const current = JSON.parse(fs.readFileSync(file, "utf8"));
  const REFUSAL = "kernel.contract.json is schema v1 (or unversioned); regenerate with kernel_contract";

  fs.writeFileSync(file, `${JSON.stringify({ ...current, schemaVersion: 1 }, null, 2)}\n`);
  const v1 = readContract(ctx.root);
  assert.equal(v1.ok, false);
  assert.equal(v1.reason, REFUSAL, "a v1 contract is refused in one line, naming the file");

  const { schemaVersion, ...unversioned } = current;
  fs.writeFileSync(file, `${JSON.stringify({ ...unversioned, version: 1 }, null, 2)}\n`);
  const old = readContract(ctx.root);
  assert.equal(old.ok, false);
  assert.equal(old.reason, REFUSAL, "an unversioned contract is refused, never guessed at");

  const recorded = await recordCandidate(keepInput(ctx));
  assert.equal(recorded.ok, false);
  assert.equal(recorded.errors[0], REFUSAL, "the recorder surfaces the reader's refusal unchanged");
});

test("readContract refuses a v2 contract that lost its basis or harnessGlobs", async () => {
  const ctx = await setup();
  const file = path.join(ctx.root, "kernel.contract.json");
  const current = JSON.parse(fs.readFileSync(file, "utf8"));

  const { basis, ...noBasis } = current;
  fs.writeFileSync(file, `${JSON.stringify(noBasis, null, 2)}\n`);
  const missingBasis = readContract(ctx.root);
  assert.equal(missingBasis.ok, false);
  assert.match(missingBasis.reason, /kernel\.contract\.json has no valid basis \(got null\); regenerate with kernel_contract/);

  const { harnessGlobs, ...noHarness } = current;
  fs.writeFileSync(file, `${JSON.stringify(noHarness, null, 2)}\n`);
  const missingHarness = readContract(ctx.root);
  assert.equal(missingHarness.ok, false);
  assert.match(missingHarness.reason, /kernel\.contract\.json has no harnessGlobs; regenerate with kernel_contract/);
});

test("a corrupt contract is a refusal, not a crash", async () => {
  const ctx = await setup();
  fs.writeFileSync(path.join(ctx.root, "kernel.contract.json"), "{not json");
  const outcome = await recordCandidate(keepInput(ctx));
  assert.equal(outcome.ok, false);
  assert.match(outcome.errors.join("\n"), /not valid JSON/);
});

test("run id validation", () => {
  assert.equal(isSafeRunId("run1"), true);
  assert.equal(isSafeRunId("20261107-101500"), true);
  assert.equal(isSafeRunId("../escape"), false);
  assert.equal(isSafeRunId("a/b"), false);
  assert.equal(isSafeRunId("-leading"), false);
});

test("benchmark.csv is derived from the ledger and quotes free text", async () => {
  const ctx = await setup();
  const first = await recordCandidate(keepInput(ctx));
  assert.equal(first.ok, true);
  const second = await recordCandidate({
    ...keepInput(ctx),
    decision: "reject",
    description: 'rejected: "tile" swap, slower',
    reason: "8k cell regressed, see goal.jsonl",
  });
  assert.equal(second.ok, true);
  assert.match(formatCandidateOutcome(second), /benchmark\.csv refreshed \(2 row\(s\), derived/);

  const file = path.join(ctx.root, "benchmark.csv");
  assert.ok(fs.existsSync(file));
  const lines = fs.readFileSync(file, "utf8").trim().split("\n");
  assert.match(
    lines[0],
    /^candidate,parent,at,decision,description,geomean_speedup,latency_us_a,latency_us_b,profile_run,bottleneck_metric,reason,forced,pairing,verdict,forced_rules$/,
  );
  assert.match(lines[1], /^C1,baseline,/);
  assert.match(lines[1], /1\.12,9\.1,9\.1/);
  assert.match(lines[2], /"rejected: ""tile"" swap, slower"/);
  assert.match(lines[2], /"8k cell regressed, see goal\.jsonl"/);
});

test("exporting before any candidate is a refusal", async () => {
  const ctx = await setup();
  const { exportBenchmarkCsv } = await import("../../extensions/pi-kernel-expert/kernel/candidates.ts");
  const outcome = exportBenchmarkCsv(ctx.root);
  assert.equal(outcome.ok, false);
  assert.match(outcome.reason, /candidates\.jsonl is empty/);
});

// --- the refusal set: five rules, each naming the side it is charged to ------

test("a keep with no reading is refused for its basis, and every rule prints in one block", async () => {
  const ctx = await setup();
  const outcome = await recordCandidate(keepInput(ctx, { reading: undefined }));
  assert.equal(outcome.ok, false);
  assert.deepEqual(outcome.refusals.map((entry) => entry.rule), ["basis-missing", "cell-group-uncovered"]);
  assert.equal(outcome.refusals[0].charged, "run");
  assert.match(outcome.errors.join("\n"), /basis-missing \(charged to the run\)/);
  assert.equal(outcome.errors[0], formatRefusalOf(outcome.refusals[0]), "the printable line is the refusal plus its fix");

  const printed = formatCandidateOutcome(outcome);
  assert.match(printed, /2 refusal\(s\), all printed/);
  assert.match(printed, /6 cell\/group pair\(s\) have no reading entry: a\/typical, a\/zero_block, a\/tail/);
  assert.match(printed, /re-run goal\.sh on a build that emits a reading block/);
  assert.equal(printed.split("\n").filter((line) => line.startsWith("- ")).length, 2, "one line per refusal, one block");
});

function formatRefusalOf(refusal) {
  return `${refusal.message} Fix: ${refusal.fix}`;
}

test("a host-bound reading is refused with the ratio and the four host causes", async () => {
  const ctx = await setup();
  const outcome = await recordCandidate(
    keepInput(ctx, { reading: readingText(readingRecord(ctx, { hostBoundRatio: 4.25, hostBoundVerdict: "host_bound" })) }),
  );
  assert.equal(outcome.ok, false);
  assert.deepEqual(outcome.refusals.map((entry) => entry.rule), ["host-bound"]);
  assert.equal(outcome.refusals[0].charged, "candidate");
  const text = outcome.errors.join("\n");
  assert.match(text, /host-bound \(charged to the candidate\)/);
  assert.match(text, /hostBoundRatio 4\.25/);
  assert.match(text, /recompile\/JIT per call/);
  assert.match(text, /python-side allocation/);
  assert.match(text, /extra launches/);
  assert.match(text, /synchronize inside the call/);
});

test("an unmeasured reading is refused rather than defaulted to a pass", async () => {
  const ctx = await setup();
  const outcome = await recordCandidate(
    keepInput(ctx, {
      reading: readingText(
        readingRecord(ctx, {
          hostBoundRatio: null,
          hostBoundVerdict: "unmeasured",
          hostBoundReason: "the task reported device_ms but no host_enqueue_ms",
        }),
      ),
    }),
  );
  assert.equal(outcome.ok, false);
  assert.deepEqual(outcome.refusals.map((entry) => entry.rule), ["host-bound"]);
  assert.equal(outcome.refusals[0].charged, "run");
  assert.match(outcome.errors.join("\n"), /not a pass/);
});

test("a reading passed as a path to the run log is accepted, and the ledger keeps its key fields", async () => {
  const ctx = await setup();
  const log = path.join(ctx.root, "runs", "run1.log");
  fs.mkdirSync(path.dirname(log), { recursive: true });
  fs.writeFileSync(log, `bench output\n${readingText(readingRecord(ctx))}exit 0\n`);

  const outcome = await recordCandidate(keepInput(ctx, { reading: path.relative(ctx.root, log) }));
  assert.equal(outcome.ok, true, outcome.ok ? "" : outcome.errors.join("\n"));
  assert.equal(outcome.record.reading.basis, "device");
  assert.equal(outcome.record.reading.hostBoundVerdict, "ok");
  assert.equal(outcome.record.reading.cells.length, 6, "two cells x three groups");
  assert.equal(outcome.record.reading.cells[0].group, "typical");

  const [row] = readCandidates(ctx.root);
  assert.equal(row.pairing, "absent");
  assert.equal(row.verdict, "measured");
  assert.deepEqual(row.forcedRules, []);
  const ledgerLine = JSON.parse(fs.readFileSync(path.join(ctx.root, "candidates.jsonl"), "utf8").trim());
  assert.equal(ledgerLine.pairing, "absent");
  assert.equal(ledgerLine.verdict, "measured");
});

test("pairing is copied from the reading when the producer writes it", async () => {
  const ctx = await setup();
  const outcome = await recordCandidate(keepInput(ctx, { reading: readingText(readingRecord(ctx, { pairing: "mirrored" })) }));
  assert.equal(outcome.ok, true, outcome.ok ? "" : outcome.errors.join("\n"));
  assert.equal(outcome.record.pairing, "mirrored");
  assert.equal(outcome.record.verdict, "measured");
});

test("force_with_reason accepts a run-level defect and the record lists what it forced", async () => {
  const ctx = await setup();
  const partial = readingRecord(ctx, { hostBoundRatio: 2.4, hostBoundVerdict: "host_bound" });
  partial.cells = partial.cells.filter((cell) => cell.id === "a");

  const forced = await recordCandidate(
    keepInput(ctx, { reading: readingText(partial), forceWithReason: "the other card was contended; I re-timed by hand" }),
  );
  assert.equal(forced.ok, true, forced.ok ? "" : forced.errors.join("\n"));
  assert.deepEqual(forced.record.forcedRules, ["host-bound", "cell-group-uncovered"]);
  assert.equal(forced.record.verdict, "host_bound", "a forced keep does not record its host-bound reading as measured");
  assert.equal(forced.record.forced, true);
  assert.match(formatCandidateOutcome(forced), /forced through: host-bound, cell-group-uncovered/);

  const clean = await recordCandidate(
    keepInput(ctx, { description: "no rule fired, forced anyway", forceWithReason: "checked above noise by hand" }),
  );
  assert.equal(clean.ok, true);
  assert.deepEqual(clean.record.forcedRules, [], "forcing with nothing to bypass records nothing forced");
});

test("force_with_reason cannot hide a harness edit or a stale profile", async () => {
  const ctx = await setup({
    harnessGlobs: ["compare.py"],
    scopeGlobs: ["kernel/**", "compare.py"],
    extraFiles: { "compare.py": "v1\n" },
  });

  fs.writeFileSync(path.join(ctx.root, "compare.py"), "v2, looser tolerance\n");
  const harness = await recordCandidate(
    keepInput(ctx, { forceWithReason: "the number is real, I checked it" }),
  );
  assert.equal(harness.ok, false, "an edited harness is never forced through");
  assert.deepEqual(harness.refusals.map((entry) => entry.rule), ["harness-touched"]);
  assert.equal(harness.refusals[0].charged, "candidate");
  assert.match(harness.errors.join("\n"), /compare\.py/);
  assert.match(formatCandidateOutcome(harness), /harness-touched \(charged to the candidate\)/);

  fs.writeFileSync(path.join(ctx.root, "compare.py"), "v1\n");
  writeProfile(ctx, "run1", { metrics: { "sm__throughput.avg.pct_of_peak_sustained_elapsed": 71 } });
  fs.writeFileSync(path.join(ctx.root, "kernel", "attn.cu"), "v3\n");
  const stale = await recordCandidate(
    keepInput(ctx, { profileRun: "run1", forceWithReason: "the profile is close enough" }),
  );
  assert.equal(stale.ok, false, "a stale profile is never forced through");
  assert.deepEqual(stale.refusals.map((entry) => entry.rule), ["profile-stale"]);
  assert.equal(stale.refusals[0].charged, "candidate");
  assert.match(stale.errors.join("\n"), /is stale/);
});

test("a cell x group with no reading entry is refused without blaming the whole cell", async () => {
  const ctx = await setup();
  const record = readingRecord(ctx);
  record.cells = record.cells.filter((cell) => !(cell.id === "a" && cell.group !== "typical"));

  const outcome = await recordCandidate(keepInput(ctx, { reading: readingText(record) }));
  assert.equal(outcome.ok, false);
  assert.deepEqual(outcome.refusals.map((entry) => entry.rule), ["cell-group-uncovered"]);
  assert.match(outcome.errors.join("\n"), /a\/zero_block, a\/tail/);
  assert.doesNotMatch(outcome.errors.join("\n"), /cell a carry/);
});
