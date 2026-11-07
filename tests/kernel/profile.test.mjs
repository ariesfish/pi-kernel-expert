import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import {
  buildProfileSummary,
  detectGpu,
  formatProfileOutcome,
  parseKeyMetrics,
  parseRules,
  parseStallReport,
  runProfile,
} from "../../extensions/pi-kernel-expert/kernel/profile.ts";

const METRICS = JSON.stringify(
  {
    "__kernel_name__": "fmha_fwd",
    "gpu__dram_throughput.avg.pct_of_peak_sustained_elapsed": 12.5,
    "sm__throughput.avg.pct_of_peak_sustained_elapsed": 71.2,
    "l1tex__throughput.avg.pct_of_peak_sustained_elapsed": null,
    "launch__occupancy_limit_registers": "N/A",
  },
  null,
  2,
);

const RULES = `===== NCU rules for full, highest estimated speedup first =====
Kernel: fmha_fwd
speedup: est. % of the kernel's time (global) or of the part the rule is about (local)

[OPT]  18.50% (global)  MemoryWorkloadAnalysis / ExcessiveMemoryTraffic: DRAM traffic is high
    Long message line one.

[WRN]  4.00% (local)  SchedulerStats / WarpStall: warps stall
    Short message.

[INF]      -          LaunchStats / Occupancy: occupancy limited
`;

const STALLS = `===== Stall hotspots for full =====
Kernel: fmha_fwd

===== By line in the kernel function (outermost inline frame, from --binary; SASS of 10/10 sampled PCs matched the report) =====
Total distinct (file, line) entries: 42

Rank      Total File                           Line  Breakdown (stall: count)
-------------------------------------------------------------------------------
   0       1200 fmha.cu                           88  long_scoreboard: 900, short_scoreboard: 300
   1        800 fmha.cu                          102  wait: 800

===== By innermost source line (ncu's own attribution) =====
Total distinct (file, line) entries: 7

Rank      Total File                           Line  Breakdown (stall: count)
-------------------------------------------------------------------------------
   0        500 kernel_traits.h                   12  wait: 500

===== Per-stall-type top lines =====
`;

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeAnalysis(dir, tag) {
  const analysis = path.join(dir, "analysis");
  fs.mkdirSync(analysis, { recursive: true });
  fs.writeFileSync(path.join(analysis, `metrics_key_${tag}.json`), METRICS);
  fs.writeFileSync(path.join(analysis, `rules_${tag}.txt`), RULES);
  fs.writeFileSync(path.join(analysis, `stall_hotspots_${tag}.txt`), STALLS);
  fs.writeFileSync(path.join(analysis, `pm_timeline_${tag}.txt`), "plot\n");
}

const SUMMARY_INPUT = {
  runId: "run1",
  tag: "full",
  contractSha: "a".repeat(64),
  diffHash: "b".repeat(64),
  gitHead: "c".repeat(40),
  gpu: { name: "NVIDIA H100", clockSm: "1980", clockMem: "2619" },
  ncuVersion: "NVIDIA Nsight Compute 2026.3.1",
  report: { path: "/tmp/report.ncu-rep", sha256: "d".repeat(64) },
};

test("key metrics keep numbers and report absent ones without zeroing", () => {
  const parsed = parseKeyMetrics(METRICS);
  assert.equal(parsed.kernel, "fmha_fwd");
  assert.equal(parsed.metrics["sm__throughput.avg.pct_of_peak_sustained_elapsed"], 71.2);
  assert.deepEqual(parsed.absent, [
    "l1tex__throughput.avg.pct_of_peak_sustained_elapsed",
    "launch__occupancy_limit_registers",
  ]);
  assert.equal("l1tex__throughput.avg.pct_of_peak_sustained_elapsed" in parsed.metrics, false);
});

test("rules are parsed and ranked by estimated speedup, absent last", () => {
  const rules = parseRules(RULES);
  assert.equal(rules.length, 3);
  assert.equal(rules[0].rule, "ExcessiveMemoryTraffic");
  assert.equal(rules[0].estSpeedupPct, 18.5);
  assert.equal(rules[0].speedupType, "global");
  assert.equal(rules[1].severity, "WRN");
  assert.equal(rules[2].estSpeedupPct, null);
  assert.equal(rules[2].title, "occupancy limited");
});

test("stall parsing prefers the kernel's own lines over inlined frames", () => {
  const stalls = parseStallReport(STALLS);
  assert.equal(stalls.source, "kernel");
  assert.equal(stalls.totalLines, 42);
  assert.equal(stalls.top.length, 2);
  assert.deepEqual(stalls.top[0], {
    rank: 0,
    total: 1200,
    file: "fmha.cu",
    line: 88,
    breakdown: "long_scoreboard: 900, short_scoreboard: 300",
  });
});

test("stall parsing falls back to the innermost lines and tolerates no samples", () => {
  const innermostOnly = STALLS.split("===== By line in the kernel function")[0]
    + "===== By innermost source line (ncu's own attribution) =====\nTotal distinct (file, line) entries: 7\n\n"
    + "Rank  Total File  Line  Breakdown\n----\n   0   500  a.h  3  wait: 500\n";
  const stalls = parseStallReport(innermostOnly);
  assert.equal(stalls.source, "innermost");
  assert.equal(stalls.top.length, 1);
  assert.deepEqual(parseStallReport("nothing here"), { source: "none", totalLines: null, top: [] });
});

test("a summary is written with metrics, rules, stalls, and the binding hashes", () => {
  const dir = tempDir("pi-kernel-expert-profile-");
  writeAnalysis(dir, "full");
  const outcome = buildProfileSummary({ dir, ...SUMMARY_INPUT });
  assert.equal(outcome.ok, true);
  const { summary, summaryPath } = outcome;
  assert.equal(summary.kernel, "fmha_fwd");
  assert.equal(summary.gpu.name, "NVIDIA H100");
  assert.equal(summary.contractSha, SUMMARY_INPUT.contractSha);
  assert.equal(summary.diffHash, SUMMARY_INPUT.diffHash);
  assert.equal(summary.rules.length, 3);
  assert.equal(summary.stalls.top.length, 2);
  assert.equal(summary.timelinePath, path.join(dir, "analysis", "pm_timeline_full.txt"));
  assert.match(summary.warnings.join("\n"), /2 key metric\(s\) absent/);
  assert.ok(fs.existsSync(summaryPath));
  assert.equal(JSON.parse(fs.readFileSync(summaryPath, "utf8")).runId, "run1");
});

test("a summary without the analysis file refuses instead of inventing metrics", () => {
  const dir = tempDir("pi-kernel-expert-profile-");
  const outcome = buildProfileSummary({ dir, ...SUMMARY_INPUT });
  assert.equal(outcome.ok, false);
  assert.match(outcome.errors.join("\n"), /missing .*metrics_key_full\.json/);
});

test("reuse_analysis skips the helpers and still writes a summary", async () => {
  const workspace = tempDir("pi-kernel-expert-profile-ws-");
  const runDir = path.join(workspace, "profile", "run1");
  writeAnalysis(runDir, "full");
  const report = path.join(runDir, "reports", "full.ncu-rep");
  fs.mkdirSync(path.dirname(report), { recursive: true });
  fs.writeFileSync(report, "fake report bytes");

  const exec = {
    async exec(command) {
      if (command === "nvidia-smi") {
        return { code: 0, stdout: "NVIDIA H100, 1980, 2619\n", stderr: "", killed: false, truncated: false };
      }
      return { code: 1, stdout: "", stderr: "not available", killed: false, truncated: false };
    },
  };

  const outcome = await runProfile({
    workspace,
    runId: "run1",
    tag: "full",
    helpersDir: "/nonexistent",
    contractSha: SUMMARY_INPUT.contractSha,
    diffHash: SUMMARY_INPUT.diffHash,
    gitHead: SUMMARY_INPUT.gitHead,
    reportPath: report,
    reuseAnalysis: true,
    exec,
  });
  assert.equal(outcome.ok, true, outcome.ok ? "" : outcome.errors.join("\n"));
  assert.equal(outcome.summary.gpu.name, "NVIDIA H100");
  assert.match(outcome.summary.warnings.join("\n"), /ncu is not available/);
  assert.match(formatProfileOutcome(outcome), /profile run run1/);

  const again = await runProfile({
    workspace,
    runId: "run1",
    tag: "full",
    helpersDir: "/nonexistent",
    contractSha: SUMMARY_INPUT.contractSha,
    diffHash: SUMMARY_INPUT.diffHash,
    gitHead: SUMMARY_INPUT.gitHead,
    reportPath: report,
    reuseAnalysis: true,
    exec,
  });
  assert.equal(again.ok, false);
  assert.match(again.errors.join("\n"), /already has a summary\.json/);
});

test("collect without ncu names the missing dependency", async () => {
  const workspace = tempDir("pi-kernel-expert-profile-ws-");
  const exec = {
    async exec() {
      return { code: 1, stdout: "", stderr: "spawn ncu ENOENT", killed: false, truncated: false };
    },
  };
  const outcome = await runProfile({
    workspace,
    runId: "run1",
    tag: "full",
    helpersDir: "/nonexistent",
    contractSha: SUMMARY_INPUT.contractSha,
    diffHash: SUMMARY_INPUT.diffHash,
    gitHead: SUMMARY_INPUT.gitHead,
    command: "python bench.py",
    exec,
  });
  assert.equal(outcome.ok, false);
  assert.match(outcome.errors.join("\n"), /ncu --version` failed/);
  assert.match(outcome.errors.join("\n"), /report path/);
});

test("a helper failure mentions ncu_report instead of a bare exit code", async () => {
  const workspace = tempDir("pi-kernel-expert-profile-ws-");
  const report = path.join(workspace, "r.ncu-rep");
  fs.writeFileSync(report, "bytes");
  const exec = {
    async exec(command) {
      if (command === "ncu") {
        return { code: 0, stdout: "NVIDIA Nsight Compute 2026.3.1\n", stderr: "", killed: false, truncated: false };
      }
      return {
        code: 1,
        stdout: "",
        stderr: "ModuleNotFoundError: No module named 'ncu_report'",
        killed: false,
        truncated: false,
      };
    },
  };
  const outcome = await runProfile({
    workspace,
    runId: "run1",
    tag: "full",
    helpersDir: "/helpers",
    contractSha: SUMMARY_INPUT.contractSha,
    diffHash: SUMMARY_INPUT.diffHash,
    gitHead: SUMMARY_INPUT.gitHead,
    reportPath: report,
    exec,
  });
  assert.equal(outcome.ok, false);
  assert.match(outcome.errors.join("\n"), /ncu_report/);
});

test("GPU detection degrades to nulls when nvidia-smi is absent", async () => {
  const exec = { async exec() { return { code: 1, stdout: "", stderr: "", killed: false, truncated: false }; } };
  assert.deepEqual(await detectGpu(exec), { name: null, clockSm: null, clockMem: null });
});
