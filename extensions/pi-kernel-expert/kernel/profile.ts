import * as fs from "node:fs";
import * as path from "node:path";

import type { HostExec } from "../support/exec.ts";
import { sha256File } from "./diff.ts";

export interface ProfileGpu {
  name: string | null;
  clockSm: string | null;
  clockMem: string | null;
}

export interface ProfileRule {
  severity: string;
  estSpeedupPct: number | null;
  speedupType: string | null;
  section: string;
  rule: string;
  title: string;
}

export interface StallEntry {
  rank: number;
  total: number;
  file: string;
  line: number;
  breakdown: string;
}

export interface StallSummary {
  source: "kernel" | "innermost" | "none";
  totalLines: number | null;
  top: StallEntry[];
}

export interface ProfileSummary {
  version: 1;
  runId: string;
  tag: string;
  createdAt: string;
  kernel: string | null;
  gpu: ProfileGpu;
  ncuVersion: string | null;
  report: { path: string; sha256: string } | null;
  contractSha: string;
  diffHash: string;
  gitHead: string;
  metrics: Record<string, number>;
  absentMetrics: string[];
  rules: ProfileRule[];
  stalls: StallSummary;
  timelinePath: string | null;
  warnings: string[];
}

const MAX_RULES = 10;
const MAX_STALLS = 10;

export function parseKeyMetrics(text: string): {
  metrics: Record<string, number>;
  absent: string[];
  kernel: string | null;
} {
  const parsed = JSON.parse(text) as Record<string, unknown>;
  const metrics: Record<string, number> = {};
  const absent: string[] = [];
  let kernel: string | null = null;
  for (const [key, value] of Object.entries(parsed)) {
    if (key === "__kernel_name__") {
      kernel = typeof value === "string" ? value : null;
      continue;
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      metrics[key] = value;
    } else {
      absent.push(key);
    }
  }
  return { metrics, absent: absent.sort(), kernel };
}

export function parseRules(text: string): ProfileRule[] {
  const rules: ProfileRule[] = [];
  for (const line of text.split("\n")) {
    const match =
      /^\[([A-Z?]+)\]\s+(?:([\d.]+)%\s+\((\w+)\)|\s*-\s*)\s*(\S+)\s*\/\s*(\S+?)(?::\s*(.*))?$/.exec(
        line,
      );
    if (!match) continue;
    rules.push({
      severity: match[1],
      estSpeedupPct: match[2] === undefined ? null : Number(match[2]),
      speedupType: match[3] ?? null,
      section: match[4],
      rule: match[5],
      title: (match[6] ?? "").trim(),
    });
  }
  rules.sort((a, b) => (b.estSpeedupPct ?? -1) - (a.estSpeedupPct ?? -1));
  return rules.slice(0, MAX_RULES);
}

export function parseStallReport(text: string): StallSummary {
  const lines = text.split("\n");
  const kernelHeader = lines.findIndex((line) => line.startsWith("===== By line in the kernel function"));
  const innermostHeader = lines.findIndex((line) => line.startsWith("===== By innermost source line"));
  const stallTypeHeader = lines.findIndex((line) => line.startsWith("===== Per-stall-type"));

  let source: StallSummary["source"] = "none";
  let start = -1;
  let end = lines.length;
  if (kernelHeader >= 0) {
    source = "kernel";
    start = kernelHeader;
    end = innermostHeader > kernelHeader ? innermostHeader : stallTypeHeader > kernelHeader ? stallTypeHeader : lines.length;
  } else if (innermostHeader >= 0 && innermostHeader + 1 < lines.length) {
    source = "innermost";
    start = innermostHeader;
    end = stallTypeHeader > innermostHeader ? stallTypeHeader : lines.length;
  }
  if (start < 0) return { source: "none", totalLines: null, top: [] };

  let totalLines: number | null = null;
  const top: StallEntry[] = [];
  for (const line of lines.slice(start, end)) {
    const total = /^Total distinct \(file, line\) entries:\s*(\d+)/.exec(line);
    if (total) {
      totalLines = Number(total[1]);
      continue;
    }
    const row = /^\s*(\d+)\s+(\d+)\s+(.*?)\s+(\d+)\s{2,}(.+)$/.exec(line);
    if (!row) continue;
    top.push({
      rank: Number(row[1]),
      total: Number(row[2]),
      file: row[3].trim(),
      line: Number(row[4]),
      breakdown: row[5].trim(),
    });
    if (top.length >= MAX_STALLS) break;
  }
  return { source, totalLines, top };
}

export interface BuildSummaryOptions {
  dir: string;
  runId: string;
  tag: string;
  contractSha: string;
  diffHash: string;
  gitHead: string;
  gpu: ProfileGpu;
  ncuVersion: string | null;
  report: { path: string; sha256: string } | null;
  kernel?: string | null;
  warnings?: string[];
  now?: Date;
}

export type SummaryOutcome =
  | { ok: true; summary: ProfileSummary; summaryPath: string }
  | { ok: false; errors: string[] };

export function buildProfileSummary(options: BuildSummaryOptions): SummaryOutcome {
  const analysis = path.join(options.dir, "analysis");
  const metricsFile = path.join(analysis, `metrics_key_${options.tag}.json`);
  if (!fs.existsSync(metricsFile)) {
    return {
      ok: false,
      errors: [
        `missing ${metricsFile}: the analysis step did not run or wrote a different tag`,
        "run kernel_profile without reuse_analysis, or copy the analysis/ directory from the machine that profiled",
      ],
    };
  }

  const parsed = parseKeyMetrics(fs.readFileSync(metricsFile, "utf8"));
  const rulesFile = path.join(analysis, `rules_${options.tag}.txt`);
  const stallsFile = path.join(analysis, `stall_hotspots_${options.tag}.txt`);
  const timelineFile = path.join(analysis, `pm_timeline_${options.tag}.txt`);

  const warnings = [...(options.warnings ?? [])];
  if (parsed.absent.length > 0) {
    warnings.push(`${parsed.absent.length} key metric(s) absent from this report — they are not zero`);
  }
  if (!fs.existsSync(stallsFile)) {
    warnings.push("no stall report: collect with --set full (SourceCounters) and -lineinfo");
  }

  const summary: ProfileSummary = {
    version: 1,
    runId: options.runId,
    tag: options.tag,
    createdAt: (options.now ?? new Date()).toISOString(),
    kernel: parsed.kernel ?? options.kernel ?? null,
    gpu: options.gpu,
    ncuVersion: options.ncuVersion,
    report: options.report,
    contractSha: options.contractSha,
    diffHash: options.diffHash,
    gitHead: options.gitHead,
    metrics: parsed.metrics,
    absentMetrics: parsed.absent,
    rules: fs.existsSync(rulesFile) ? parseRules(fs.readFileSync(rulesFile, "utf8")) : [],
    stalls: fs.existsSync(stallsFile)
      ? parseStallReport(fs.readFileSync(stallsFile, "utf8"))
      : { source: "none", totalLines: null, top: [] },
    timelinePath: fs.existsSync(timelineFile) ? timelineFile : null,
    warnings,
  };

  const summaryPath = path.join(options.dir, "summary.json");
  fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  return { ok: true, summary, summaryPath };
}

export interface ProfileRunOptions {
  workspace: string;
  runId: string;
  tag: string;
  helpersDir: string;
  contractSha: string;
  diffHash: string;
  gitHead: string;
  reportPath?: string;
  command?: string;
  kernel?: string;
  launchCount?: number;
  binary?: string;
  reuseAnalysis?: boolean;
  exec: HostExec;
  signal?: AbortSignal;
  now?: Date;
}

export type ProfileRunOutcome =
  | { ok: true; summary: ProfileSummary; summaryPath: string; runDir: string; reportPath: string | null }
  | { ok: false; errors: string[] };

export async function runProfile(options: ProfileRunOptions): Promise<ProfileRunOutcome> {
  const runDir = path.join(options.workspace, "profile", options.runId);
  if (fs.existsSync(runDir)) {
    // reuse_analysis resumes a run directory whose analysis/ was produced on
    // the profiling machine; anything else would overwrite evidence.
    if (!options.reuseAnalysis) {
      return { ok: false, errors: [`${runDir} already exists; one profile run per directory, pick another run_id`] };
    }
    if (fs.existsSync(path.join(runDir, "summary.json"))) {
      return { ok: false, errors: [`${runDir} already has a summary.json; pick another run_id`] };
    }
  }
  const warnings: string[] = [];
  fs.mkdirSync(path.join(runDir, "reports"), { recursive: true });
  fs.mkdirSync(path.join(runDir, "analysis"), { recursive: true });

  let reportPath = options.reportPath ? path.resolve(options.workspace, options.reportPath) : null;
  let ncuVersion: string | null = null;

  const ncuVersionResult = await options.exec.exec("ncu", ["--version"], {
    timeout: 30_000,
    signal: options.signal,
  });
  if (ncuVersionResult.code === 0) {
    ncuVersion = ncuVersionResult.stdout.split("\n").map((l) => l.trim()).filter(Boolean)[0] ?? null;
  } else {
    warnings.push("ncu is not available on this machine; collection cannot run here");
  }

  if (options.command) {
    if (reportPath) {
      return { ok: false, errors: ["pass either report (attach) or command (collect), not both"] };
    }
    if (!ncuVersion) {
      return {
        ok: false,
        errors: [
          "cannot collect: `ncu --version` failed",
          "install Nsight Compute or run the collection on the machine that has it, then pass the report path",
        ],
      };
    }
    const base = path.join(runDir, "reports", options.tag);
    const ncuArgs = [
      "--set",
      "full",
      "--import-source",
      "yes",
      "--clock-control",
      "boost",
      "--target-processes",
      "all",
      ...(options.kernel ? ["-k", options.kernel] : []),
      "-c",
      String(options.launchCount ?? 1),
      "-o",
      `${base}.ncu-rep`,
      "bash",
      "-lc",
      options.command,
    ];
    const collected = await options.exec.exec("ncu", ncuArgs, {
      cwd: options.workspace,
      timeout: 30 * 60_000,
      signal: options.signal,
    });
    fs.writeFileSync(
      path.join(runDir, "collection.json"),
      `${JSON.stringify(
        {
          command: options.command,
          kernel: options.kernel ?? null,
          launchCount: options.launchCount ?? 1,
          ncu: ncuVersion,
          clockControl: "boost",
          exitCode: collected.code,
          tail: collected.stderr.trim().slice(-2000),
        },
        null,
        2,
      )}\n`,
    );
    if (collected.code !== 0) {
      return {
        ok: false,
        errors: [
          `ncu collection failed (exit ${collected.code})`,
          (collected.stderr || collected.stdout).trim().slice(-2000),
          `run directory kept at ${runDir} for inspection`,
        ],
      };
    }
    const candidates = [`${base}.ncu-rep`, `${base}.ncu-repz`];
    reportPath = candidates.find((file) => fs.existsSync(file)) ?? null;
    if (!reportPath) {
      return { ok: false, errors: [`ncu reported success but wrote neither ${candidates.join(" nor ")}`] };
    }
  }

  if (!reportPath) {
    return { ok: false, errors: ["pass report (attach an existing .ncu-rep) or command (collect one)"] };
  }
  if (!fs.existsSync(reportPath)) {
    return { ok: false, errors: [`report not found: ${reportPath}`] };
  }

  if (!options.reuseAnalysis) {
    const helperRuns: Array<[string, string[], boolean]> = [
      ["analyze_reports.py", ["--run-dir", runDir, "--report", reportPath, "--tag", options.tag], true],
      [
        "extract_stall_hotspots.py",
        [
          "--run-dir",
          runDir,
          "--report",
          reportPath,
          "--tag",
          options.tag,
          ...(options.binary ? ["--binary", options.binary] : []),
        ],
        true,
      ],
      ["plot_timeline.py", ["--run-dir", runDir, "--report", reportPath, "--tag", options.tag], false],
    ];

    for (const [script, args, required] of helperRuns) {
      const result = await options.exec.exec("python3", [path.join(options.helpersDir, script), ...args], {
        cwd: options.helpersDir,
        timeout: 10 * 60_000,
        signal: options.signal,
      });
      if (result.code === 0) continue;
      const detail = (result.stderr || result.stdout).trim().slice(-2000);
      if (!required) {
        warnings.push(`${script} skipped: ${detail.split("\n").slice(-1)[0] ?? "failed"}`);
        continue;
      }
      const hint = /ncu_report|No module named/i.test(detail)
        ? "the helpers need Nsight Compute's ncu_report; set PYTHONPATH to <Nsight Compute>/extras/python or run on the profiling machine"
        : "the report could not be analyzed; check the tag and that it was collected with --set full";
      return { ok: false, errors: [`${script} failed (exit ${result.code})`, detail, hint, `run directory kept at ${runDir}`] };
    }
  }

  const gpuInfo = await detectGpu(options.exec, options.signal);
  const built = buildProfileSummary({
    dir: runDir,
    runId: options.runId,
    tag: options.tag,
    contractSha: options.contractSha,
    diffHash: options.diffHash,
    gitHead: options.gitHead,
    gpu: gpuInfo,
    ncuVersion,
    report: { path: reportPath, sha256: sha256File(reportPath) },
    kernel: options.kernel ?? null,
    warnings,
    now: options.now,
  });
  if (!built.ok) return { ok: false, errors: built.errors };
  return {
    ok: true,
    summary: built.summary,
    summaryPath: built.summaryPath,
    runDir,
    reportPath,
  };
}

export async function detectGpu(exec: HostExec, signal?: AbortSignal): Promise<ProfileGpu> {
  const result = await exec.exec(
    "nvidia-smi",
    ["--query-gpu=name,clocks.current.sm,clocks.current.memory", "--format=csv,noheader,nounits"],
    { timeout: 20_000, signal },
  );
  if (result.code !== 0) return { name: null, clockSm: null, clockMem: null };
  const first = result.stdout.split("\n").map((line) => line.trim()).filter(Boolean)[0];
  if (!first) return { name: null, clockSm: null, clockMem: null };
  const [name, clockSm, clockMem] = first.split(",").map((part) => part.trim());
  return { name: name ?? null, clockSm: clockSm ?? null, clockMem: clockMem ?? null };
}

export function formatProfileOutcome(outcome: ProfileRunOutcome): string {
  if (!outcome.ok) {
    return ["Profiling did not produce a summary:", ...outcome.errors.map((error) => `- ${error}`)].join("\n");
  }
  const s = outcome.summary;
  const lines = [
    `profile run ${s.runId} (tag ${s.tag})`,
    `  kernel      ${s.kernel ?? "unknown"}`,
    `  gpu         ${s.gpu.name ?? "unknown"} (sm clock ${s.gpu.clockSm ?? "?"}, mem clock ${s.gpu.clockMem ?? "?"})`,
    `  ncu         ${s.ncuVersion ?? "unknown"}`,
    `  contract    ${s.contractSha.slice(0, 12)}  diff ${s.diffHash.slice(0, 12)}`,
    `  metrics     ${Object.keys(s.metrics).length} present, ${s.absentMetrics.length} absent from this report`,
    `  rules       ${s.rules.length} (top: ${s.rules[0] ? `${s.rules[0].estSpeedupPct ?? "?"}% ${s.rules[0].section}/${s.rules[0].rule}` : "none"})`,
    `  stalls      ${s.stalls.top.length} top line(s) from ${s.stalls.source}`,
  ];
  for (const warning of s.warnings) lines.push(`  warning: ${warning}`);
  lines.push(`summary: ${outcome.summaryPath}`);
  return lines.join("\n");
}
