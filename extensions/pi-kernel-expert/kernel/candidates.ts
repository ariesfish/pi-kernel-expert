import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import type { HostExec } from "../support/exec.ts";
import { workspacePaths } from "../workspace/layout.ts";
import { cellMetricName, type KernelContract } from "./contract.ts";
import { diffFingerprint, sha256File, type DiffFingerprint } from "./diff.ts";
import type { ProfileSummary } from "./profile.ts";

export interface CandidateRecord {
  id: string;
  parent: string;
  at: string;
  decision: "keep" | "reject";
  description: string;
  commit: string | null;
  contractSha: string;
  diffHash: string;
  metrics: Record<string, number>;
  profile: { runId: string; path: string; sha256: string } | null;
  bottleneck: { claim: string; metric: string; value: number } | null;
  reason: string | null;
  forced: boolean;
  forcedReason: string | null;
}

export interface CandidateInput {
  workspace: string;
  decision: "keep" | "reject";
  description: string;
  metrics?: Record<string, number>;
  profileRun?: string;
  bottleneck?: { claim: string; metric: string };
  reason?: string;
  commit?: string;
  forceWithReason?: string;
  exec: HostExec;
  signal?: AbortSignal;
  now?: Date;
}

export type CandidateOutcome =
  | {
      ok: true;
      record: CandidateRecord;
      fingerprint: DiffFingerprint;
      ledger: string;
      benchmarkCsv: { path: string; rows: number } | null;
    }
  | { ok: false; errors: string[] };

export type ContractOutcome =
  | { ok: true; contract: KernelContract; sha: string }
  | { ok: false; reason: string };

export function readContract(workspace: string): ContractOutcome {
  const paths = workspacePaths(workspace);
  if (!fs.existsSync(paths.contract)) {
    return { ok: false, reason: `no kernel.contract.json at ${paths.contract}; run kernel_contract first` };
  }
  const text = fs.readFileSync(paths.contract, "utf8");
  try {
    return { ok: true, contract: JSON.parse(text) as KernelContract, sha: createHash("sha256").update(text).digest("hex") };
  } catch (error) {
    return { ok: false, reason: `kernel.contract.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** Run ids become directory names; keep them boring. */
export function isSafeRunId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) && !value.includes("..");
}

/** Derived view: never hand-edited, regenerated from candidates.jsonl. */
export function renderBenchmarkCsv(records: CandidateRecord[]): string {
  const metricNames = [...new Set(records.flatMap((record) => Object.keys(record.metrics)))].sort();
  const header = [
    "candidate",
    "parent",
    "at",
    "decision",
    "description",
    ...metricNames,
    "profile_run",
    "bottleneck_metric",
    "reason",
    "forced",
  ];
  const escape = (value: unknown): string => {
    const text = value === null || value === undefined ? "" : String(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const lines = [header.join(",")];
  for (const record of records) {
    lines.push(
      [
        record.id,
        record.parent,
        record.at,
        record.decision,
        record.description,
        ...metricNames.map((name) => record.metrics[name] ?? ""),
        record.profile?.runId ?? "",
        record.bottleneck?.metric ?? "",
        record.reason ?? "",
        record.forced ? "yes" : "",
      ]
        .map(escape)
        .join(","),
    );
  }
  return `${lines.join("\n")}\n`;
}

export function exportBenchmarkCsv(workspace: string): { ok: true; path: string; rows: number } | { ok: false; reason: string } {
  const records = readCandidates(workspace);
  if (records.length === 0) {
    return { ok: false, reason: "candidates.jsonl is empty; record a candidate first" };
  }
  const file = path.join(workspace, "benchmark.csv");
  fs.writeFileSync(file, renderBenchmarkCsv(records));
  return { ok: true, path: file, rows: records.length };
}

export function readCandidates(workspace: string): CandidateRecord[] {
  const ledger = workspacePaths(workspace).candidates;
  if (!fs.existsSync(ledger)) return [];
  return fs
    .readFileSync(ledger, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as CandidateRecord);
}

export async function recordCandidate(input: CandidateInput): Promise<CandidateOutcome> {
  const paths = workspacePaths(input.workspace);
  const loaded = readContract(input.workspace);
  if (!loaded.ok) {
    return { ok: false, errors: [loaded.reason] };
  }
  if (!input.description?.trim()) {
    return { ok: false, errors: ["description is required: the ledger records what the candidate tried"] };
  }
  if (!input.decision) {
    return { ok: false, errors: ['decision must be "keep" or "reject"'] };
  }

  const fingerprint = await diffFingerprint({
    exec: input.exec,
    root: input.workspace,
    scopeGlobs: loaded.contract.scopeGlobs,
    signal: input.signal,
  });
  if (!fingerprint.ok) return { ok: false, errors: [fingerprint.reason] };

  const errors: string[] = [];
  const metrics = sanitizeMetrics(input.metrics ?? {}, errors);

  if (input.decision === "keep") {
    const required = ["geomean_speedup", ...loaded.contract.cells.map((cell) => cellMetricName(loaded.contract, cell))];
    const missing = required.filter((name) => metrics[name] === undefined);
    if (missing.length > 0) {
      errors.push(`keep needs these metrics from the run: ${missing.join(", ")}`);
    }
    const geomean = metrics.geomean_speedup;
    if (geomean !== undefined) {
      const floor = 1 + loaded.contract.noiseFloorPct / 100;
      if (geomean < floor && !input.forceWithReason?.trim()) {
        errors.push(
          `geomean_speedup ${geomean} is below the ${loaded.contract.noiseFloorPct}% noise floor (needs >= ${floor.toFixed(4)}); pass force_with_reason to keep anyway`,
        );
      }
    }
  } else if (!input.reason?.trim()) {
    errors.push("a rejected candidate needs a reason; that reason is the evidence a later reader gets");
  }

  let profile: CandidateRecord["profile"] = null;
  let bottleneck: CandidateRecord["bottleneck"] = null;
  if (input.profileRun) {
    if (!isSafeRunId(input.profileRun)) {
      errors.push(`profile_run "${input.profileRun}" must be a plain directory name`);
    }
    const summaryPath = path.join(input.workspace, "profile", input.profileRun, "summary.json");
    if (!fs.existsSync(summaryPath)) {
      errors.push(`profile run not found: ${summaryPath}`);
    } else {
      let summary: ProfileSummary;
      try {
        summary = JSON.parse(fs.readFileSync(summaryPath, "utf8")) as ProfileSummary;
      } catch {
        errors.push(`${summaryPath} is not readable JSON`);
        return { ok: false, errors };
      }
      if (summary.contractSha !== loaded.sha) {
        errors.push(`profile ${input.profileRun} was taken under contract ${summary.contractSha.slice(0, 12)}, current is ${loaded.sha.slice(0, 12)}`);
      }
      if (summary.diffHash !== fingerprint.value.hash) {
        errors.push(
          `profile ${input.profileRun} is stale: it measured diff ${summary.diffHash.slice(0, 12)}, the tree is now ${fingerprint.value.hash.slice(0, 12)}; re-profile before committing to this candidate`,
        );
      }
      profile = {
        runId: input.profileRun,
        path: path.relative(input.workspace, summaryPath),
        sha256: sha256File(summaryPath),
      };

      if (input.bottleneck) {
        if (!input.bottleneck.claim?.trim() || !input.bottleneck.metric?.trim()) {
          errors.push("bottleneck needs both a claim and the metric name it rests on");
        } else {
          const value = summary.metrics[input.bottleneck.metric];
          if (typeof value !== "number") {
            errors.push(
              `bottleneck metric "${input.bottleneck.metric}" is not present in profile ${input.profileRun}; cite a metric that exists in the report (absent metrics are listed in summary.json)`,
            );
          } else {
            bottleneck = { claim: input.bottleneck.claim.trim(), metric: input.bottleneck.metric.trim(), value };
          }
        }
      }
    }
  } else if (input.bottleneck) {
    errors.push("a bottleneck claim needs a profile run; pass profile_run with the summary that supports it");
  }

  if (errors.length > 0) return { ok: false, errors };

  const existing = readCandidates(input.workspace);
  const parent = existing.length > 0 ? existing[existing.length - 1].id : "baseline";
  const record: CandidateRecord = {
    id: `C${existing.length + 1}`,
    parent,
    at: (input.now ?? new Date()).toISOString(),
    decision: input.decision,
    description: input.description.trim(),
    commit: input.commit?.trim() || null,
    contractSha: loaded.sha,
    diffHash: fingerprint.value.hash,
    metrics,
    profile,
    bottleneck,
    reason: input.reason?.trim() || null,
    forced: Boolean(input.forceWithReason?.trim()),
    forcedReason: input.forceWithReason?.trim() || null,
  };

  fs.appendFileSync(paths.candidates, `${JSON.stringify(record)}\n`);
  const csv = exportBenchmarkCsv(input.workspace);
  return {
    ok: true,
    record,
    fingerprint: fingerprint.value,
    ledger: paths.candidates,
    benchmarkCsv: csv.ok ? { path: csv.path, rows: csv.rows } : null,
  };
}

function sanitizeMetrics(raw: Record<string, unknown>, errors: string[]): Record<string, number> {
  const metrics: Record<string, number> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (!/^[A-Za-z0-9_.]+$/.test(name)) {
      errors.push(`metric name "${name}" must match [A-Za-z0-9_.]+`);
      continue;
    }
    if (typeof value !== "number" || !Number.isFinite(value)) {
      errors.push(`metric "${name}" must be a finite number, got ${JSON.stringify(value)}`);
      continue;
    }
    metrics[name] = value;
  }
  return metrics;
}

export function formatCandidateOutcome(outcome: CandidateOutcome): string {
  if (!outcome.ok) {
    return ["Candidate not recorded:", ...outcome.errors.map((error) => `- ${error}`)].join("\n");
  }
  const r = outcome.record;
  const lines = [
    `recorded ${r.id} (${r.decision}) — parent ${r.parent}`,
    `  diff ${r.diffHash.slice(0, 12)}  contract ${r.contractSha.slice(0, 12)}`,
    r.metrics.geomean_speedup !== undefined ? `  geomean_speedup ${r.metrics.geomean_speedup}` : null,
    r.profile ? `  profile ${r.profile.runId} (${r.profile.sha256.slice(0, 12)})` : null,
    r.bottleneck ? `  bottleneck: ${r.bottleneck.claim} [${r.bottleneck.metric} = ${r.bottleneck.value}]` : null,
    r.reason ? `  reason: ${r.reason}` : null,
    r.forced ? `  forced: ${r.forcedReason}` : null,
    `ledger: ${path.basename(outcome.ledger)}`,
    outcome.benchmarkCsv
      ? `benchmark.csv refreshed (${outcome.benchmarkCsv.rows} row(s), derived — never edit it)`
      : null,
  ].filter((line): line is string => line !== null);
  if (r.decision === "keep") {
    lines.push("Next: pi-goal's log_goal decides the keep; this record is the lineage and evidence.");
  }
  return lines.join("\n");
}
