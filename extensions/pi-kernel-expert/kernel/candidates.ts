import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import type { HostExec } from "../support/exec.ts";
import { workspacePaths } from "../workspace/layout.ts";
import {
  CONTRACT_SCHEMA_VERSION,
  DEFAULT_GROUP,
  type Basis,
  type KernelContract,
} from "./contract.ts";
import { diffFingerprint, sha256File, type DiffFingerprint } from "./diff.ts";
import {
  CALIBRATION_JSON_PATH,
  PRECISION_TSV_PATH,
  comparePrecision,
  formatPrecisionValue,
  parseCalibrationJson,
  parsePrecisionTsv,
  type CalibrationEntry,
  type PrecisionComparison,
  type PrecisionEvidence,
  type PrecisionRow,
} from "./precision.ts";
import type { ProfileSummary } from "./profile.ts";
import {
  READING_END_MARKER,
  READING_START_MARKER,
  parseReadingBlock,
  type HostBoundVerdict,
  type KernelReading,
  type Pairing,
} from "./reading.ts";
import {
  applyForce,
  collectRefusals,
  formatRefusal,
  type ProfileStaleness,
  type Refusal,
  type RuleId,
} from "./refusals.ts";

/**
 * Whether a same-job reference rode this run, re-exported from the reading so a
 * ledger reader needs one type. `mirrored` means the two pairs agreed inside the
 * band; `inadmissible` means they did not and the reading's warnings say why;
 * absent on a reading from a contract with no referenceCommand, which is the
 * normal state of an existing task, not a defect.
 */
export type { Pairing };

/**
 * What the reading can support, never defaulted to a pass. `measured` means the
 * host share was taken and is thin; `host_bound` means the number exists but is
 * the host path's; `unmeasured` means the reading says somewhere that it could
 * not measure. A keep with no reading is `unmeasured`, and rule 1 refuses it.
 */
export type CandidateVerdict = "measured" | "host_bound" | "unmeasured";

/** The parsed reading's key fields, kept on the ledger row so the evidence travels with the claim. */
export interface ReadingEvidence {
  contractSha: string;
  basis: Basis;
  hostBoundRatio: number | null;
  hostBoundVerdict: HostBoundVerdict;
  pairing: Pairing;
  verdict: CandidateVerdict;
  cells: Array<{ id: string; group: string; median?: number; spreadPct?: number }>;
  startedAt: string;
  warnings: string[];
}

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
  /** The reading the keep rests on, or null when there was none. */
  reading: ReadingEvidence | null;
  pairing: Pairing;
  verdict: CandidateVerdict;
  forced: boolean;
  forcedReason: string | null;
  /** The refusals `forceWithReason` bypassed; empty on an unforced record. */
  forcedRules: RuleId[];
  /**
   * The knowledge page this promotion left behind: a candidate id, `none` when
   * the keep proved no transferable mechanism, `declined` with a reason when the
   * author chose not to write one. Absent means nobody said — which is a warning
   * on a keep that has profile evidence, never a refusal.
   */
  wiki: WikiRecord | null;
}

export type WikiRecord = { state: "produced"; id: string } | { state: "none" } | { state: "declined"; reason: string };

export interface CandidateInput {
  workspace: string;
  decision: "keep" | "reject";
  description: string;
  metrics?: Record<string, number>;
  profileRun?: string;
  bottleneck?: { claim: string; metric: string };
  reason?: string;
  commit?: string;
  /**
   * goal.sh's stdout, the reading block on its own, the block's JSON, or a path
   * to a log holding one. Without it the keep has no evidence and rule 1 fires.
   */
  reading?: string;
  /** `{ id }`, `"none"`, or `{ declined: "reason" }`. */
  wiki?: { id?: string; declined?: string; none?: boolean };
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
      /** The precision gate's verdict on a keep; null on a reject. */
      precision?: PrecisionComparison | null;
      /** Non-blocking findings, e.g. a keep with profile evidence and no wiki entry. */
      warnings: string[];
    }
  | {
      ok: false;
      /** Every refusal line (rule, side, message, fix) first, then the non-rule errors. */
      errors: string[];
      /** The structured refusals, so a caller can assert without matching prose. */
      refusals: Refusal[];
    };

export type ContractOutcome =
  | { ok: true; contract: KernelContract; sha: string }
  | { ok: false; reason: string };

export function readContract(workspace: string): ContractOutcome {
  const paths = workspacePaths(workspace);
  if (!fs.existsSync(paths.contract)) {
    return { ok: false, reason: `no kernel.contract.json at ${paths.contract}; run kernel_contract first` };
  }
  const text = fs.readFileSync(paths.contract, "utf8");
  let parsed: KernelContract;
  try {
    parsed = JSON.parse(text) as KernelContract;
  } catch (error) {
    return { ok: false, reason: `kernel.contract.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}` };
  }

  const schemaVersion = (parsed as { schemaVersion?: unknown }).schemaVersion;
  if (schemaVersion !== CONTRACT_SCHEMA_VERSION) {
    return { ok: false, reason: schemaRefusal(schemaVersion) };
  }
  // A v2 file can still be hand-written; refuse the fields the evidence rules
  // read rather than failing later on an undefined basis.
  if (parsed.basis !== "device" && parsed.basis !== "e2e") {
    return {
      ok: false,
      reason: `kernel.contract.json has no valid basis (got ${JSON.stringify(parsed.basis ?? null)}); regenerate with kernel_contract`,
    };
  }
  if (!Array.isArray(parsed.harnessGlobs)) {
    return { ok: false, reason: "kernel.contract.json has no harnessGlobs; regenerate with kernel_contract" };
  }

  return { ok: true, contract: parsed, sha: createHash("sha256").update(text).digest("hex") };
}

function schemaRefusal(schemaVersion: unknown): string {
  if (schemaVersion === undefined || schemaVersion === 1) {
    return "kernel.contract.json is schema v1 (or unversioned); regenerate with kernel_contract";
  }
  return `kernel.contract.json is schema v${String(schemaVersion)}; this build reads v${CONTRACT_SCHEMA_VERSION}; regenerate with kernel_contract`;
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
    "pairing",
    "verdict",
    "forced_rules",
    "wiki",
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
        record.pairing ?? "",
        record.verdict ?? "",
        (record.forcedRules ?? []).join(" "),
        record.wiki === null || record.wiki === undefined
          ? ""
          : record.wiki.state === "produced"
            ? record.wiki.id
            : record.wiki.state,
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

/**
 * The knowledge page a keep left behind. A candidate entry that `kernel_wiki_candidate`
 * actually wrote is checked to exist: a ledger row that cites a page nobody wrote is
 * worse than a row that says `none`.
 */
function readWikiInput(
  input: CandidateInput["wiki"],
  workspace: string,
): { ok: true; record: WikiRecord | null } | { ok: false; errors: string[]; record: WikiRecord | null } {
  if (input === undefined) return { ok: true, record: null };
  if (input.none === true) return { ok: true, record: { state: "none" } };
  if (input.declined !== undefined) {
    const reason = input.declined.trim();
    if (reason === "") {
      return { ok: false, errors: ['a declined wiki entry needs a reason; "declined" alone is a shrug'], record: null };
    }
    return { ok: true, record: { state: "declined", reason } };
  }
  if (input.id !== undefined) {
    const id = input.id.trim();
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(id)) {
      return { ok: false, errors: [`wiki id "${id}" is not kebab-case`], record: null };
    }
    const file = path.join(workspace, ".kernel", "wiki-candidates", `${id}.md`);
    if (!fs.existsSync(file)) {
      return {
        ok: false,
        errors: [
          `wiki id "${id}" cites ${path.relative(workspace, file)}, which does not exist; run kernel_wiki_candidate first or record wiki: { none: true }`,
        ],
        record: null,
      };
    }
    return { ok: true, record: { state: "produced", id } };
  }
  return { ok: false, errors: ["wiki must be { id }, { none: true }, or { declined: \"reason\" }"], record: null };
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

/**
 * The two files the precision gate judges: `.kernel/precision.tsv` (one
 * `max_diff` per cell x group, written by `goal.checks.sh`) and
 * `.kernel/calibration.json` (the reference's own error per dtype, written by
 * `goal.checks.sh --calibrate`). An absent file is `null`, never an empty one:
 * "no evidence" and "wrote nothing" are different facts.
 */
export function readPrecisionEvidence(workspace: string): PrecisionEvidence {
  const tsvPath = path.join(workspace, PRECISION_TSV_PATH);
  const calibrationPath = path.join(workspace, CALIBRATION_JSON_PATH);

  let rows: PrecisionRow[] | null = null;
  if (fs.existsSync(tsvPath)) {
    try {
      rows = parsePrecisionTsv(fs.readFileSync(tsvPath, "utf8")).rows;
    } catch {
      rows = null;
    }
  }

  let calibration: CalibrationEntry[] | null = null;
  let calibrationReason: string | null = null;
  if (!fs.existsSync(calibrationPath)) {
    calibrationReason = `${CALIBRATION_JSON_PATH} does not exist — run bash goal.checks.sh --calibrate so the reference's own error is recorded per dtype`;
  } else {
    const parsed = parseCalibrationJson(fs.readFileSync(calibrationPath, "utf8"));
    if (parsed.ok) calibration = parsed.entries;
    else calibrationReason = parsed.reason;
  }

  return { rows, calibration, calibrationReason };
}

export async function recordCandidate(input: CandidateInput): Promise<CandidateOutcome> {
  const paths = workspacePaths(input.workspace);
  const loaded = readContract(input.workspace);
  if (!loaded.ok) {
    return { ok: false, errors: [loaded.reason], refusals: [] };
  }
  if (!input.description?.trim()) {
    return {
      ok: false,
      errors: ["description is required: the ledger records what the candidate tried"],
      refusals: [],
    };
  }
  if (!input.decision) {
    return { ok: false, errors: ['decision must be "keep" or "reject"'], refusals: [] };
  }

  const fingerprint = await diffFingerprint({
    exec: input.exec,
    root: input.workspace,
    scopeGlobs: loaded.contract.scopeGlobs,
    signal: input.signal,
  });
  if (!fingerprint.ok) return { ok: false, errors: [fingerprint.reason], refusals: [] };

  const errors: string[] = [];
  const metrics = sanitizeMetrics(input.metrics ?? {}, errors);
  const resolved = resolveReading(input.workspace, input.reading);
  const evidence = resolved.reading === null ? null : summarizeReading(resolved.reading);

  let profile: CandidateRecord["profile"] = null;
  let bottleneck: CandidateRecord["bottleneck"] = null;
  let staleness: ProfileStaleness | null = null;
  if (input.profileRun) {
    // An unsafe run id is refused before it is used as a path: reading through
    // "../" would be the traversal the check exists to stop.
    const safeRunId = isSafeRunId(input.profileRun);
    if (!safeRunId) {
      errors.push(`profile_run "${input.profileRun}" must be a plain directory name`);
    }
    const summaryPath = path.join(input.workspace, "profile", input.profileRun, "summary.json");
    if (!safeRunId) {
      // nothing below may touch the filesystem for an unsafe id
    } else if (!fs.existsSync(summaryPath)) {
      errors.push(`profile run not found: ${summaryPath}`);
    } else {
      let summary: ProfileSummary;
      try {
        summary = JSON.parse(fs.readFileSync(summaryPath, "utf8")) as ProfileSummary;
      } catch {
        errors.push(`${summaryPath} is not readable JSON`);
        return { ok: false, errors, refusals: [] };
      }
      if (summary.contractSha !== loaded.sha) {
        staleness = {
          runId: input.profileRun,
          problem: "contract",
          measuredContract: summary.contractSha,
          currentContract: loaded.sha,
        };
      } else if (summary.diffHash !== fingerprint.value.hash) {
        staleness = {
          runId: input.profileRun,
          problem: "diff",
          measuredDiff: summary.diffHash,
          currentDiff: fingerprint.value.hash,
        };
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

  let refusals: Refusal[] = [];
  let forcedRules: RuleId[] = [];
  let precision: PrecisionComparison | null = null;

  if (input.decision === "keep") {
    // Rule 4 owns the per-cell aggregates; the geomean is the gate's own metric
    // and has no cell to be covered by.
    if (metrics.geomean_speedup === undefined) {
      errors.push("keep needs geomean_speedup from the run (goal.sh prints it as METRIC geomean_speedup=)");
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

    // The precision gate needs the contract (which dtype each cell is) plus the
    // two files on disk; the math lives in precision.ts, the words in refusals.ts.
    precision = comparePrecision({ contract: loaded.contract, evidence: readPrecisionEvidence(input.workspace) });

    const collected = collectRefusals({
      contract: loaded.contract,
      contractSha: loaded.sha,
      reading: evidence,
      readingReason: resolved.reason,
      changedFiles: fingerprint.value.changedFiles,
      metrics,
      precision,
      profile: staleness,
    });
    const applied = applyForce(collected, input.forceWithReason);
    refusals = applied.blocking;
    forcedRules = applied.forcedRules;
  } else if (!input.reason?.trim()) {
    errors.push("a rejected candidate needs a reason; that reason is the evidence a later reader gets");
  }

  if (refusals.length > 0 || errors.length > 0) {
    // Every refusal is printed in one block: a keep with three problems says three.
    return { ok: false, errors: [...refusals.map(formatRefusal), ...errors], refusals };
  }

  // The wiki field is checked here, after the refusal gate, because it is not a
  // refusal: a malformed value is an error, and an error still stops the record.
  const wikiInput = readWikiInput(input.wiki, input.workspace);
  if (!wikiInput.ok) {
    return { ok: false, errors: wikiInput.errors, refusals: [] };
  }

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
    reading: evidence,
    pairing: evidence?.pairing ?? "absent",
    verdict: evidence?.verdict ?? "unmeasured",
    forced: Boolean(input.forceWithReason?.trim()),
    forcedReason: input.forceWithReason?.trim() || null,
    forcedRules,
    wiki: wikiInput.record,
  };

  fs.appendFileSync(paths.candidates, `${JSON.stringify(record)}\n`);
  const csv = exportBenchmarkCsv(input.workspace);
  return {
    ok: true,
    record,
    fingerprint: fingerprint.value,
    ledger: paths.candidates,
    benchmarkCsv: csv.ok ? { path: csv.path, rows: csv.rows } : null,
    precision,
    warnings: keepWarnings(record),
  };
}

/**
 * A keep that proved a mechanism but left no page is a missed entry, not a bad
 * keep: the promotion is still valid, so this warns. It fires only when there is
 * something to write about — profile evidence plus a bottleneck claim — because a
 * bare speedup with no mechanism has nothing to say and `none` is its answer.
 */
function keepWarnings(record: CandidateRecord): string[] {
  if (record.decision !== "keep") return [];
  if (record.wiki !== null) return [];
  if (record.profile === null) return [];
  if (record.bottleneck === null) return [];
  return [
    `this keep has profile evidence (${record.profile.runId}) and a bottleneck claim but no wiki entry: run kernel_wiki_candidate to leave the mechanism behind, or pass wiki: { none: true } if it does not transfer`,
  ];
}

/**
 * Turn the caller's `reading` into a parsed record. Four shapes are accepted because
 * the evidence arrives in four shapes in practice: goal.sh's whole stdout, the block
 * on its own, the block's JSON, or a path to a log holding one. A block that does not
 * parse is *not* an error here — it is a reading the rules refuse by name, with the
 * parser's reason quoted, which is more useful than a stack of JSON diagnostics.
 */
export function resolveReading(
  workspace: string,
  raw: string | undefined,
): { reading: KernelReading | null; reason: string | null } {
  const text = raw?.trim();
  if (!text) {
    return { reading: null, reason: "no reading was passed to the recorder" };
  }

  let body = text;
  if (!body.includes(READING_START_MARKER) && !body.trimStart().startsWith("{")) {
    const candidatePath = path.isAbsolute(body) ? body : path.join(workspace, body);
    if (!fs.existsSync(candidatePath)) {
      return {
        reading: null,
        reason: `"${text.split("\n")[0].slice(0, 60)}" is not a reading block, not the block's JSON, and not a readable path`,
      };
    }
    try {
      body = fs.readFileSync(candidatePath, "utf8");
    } catch (error) {
      return { reading: null, reason: `could not read ${candidatePath}: ${error instanceof Error ? error.message : String(error)}` };
    }
  } else if (!body.includes(READING_START_MARKER)) {
    body = `${READING_START_MARKER}\n${body}\n${READING_END_MARKER}`;
  }

  const parsed = parseReadingBlock(body);
  if (!parsed.ok) return { reading: null, reason: parsed.reason };
  return { reading: parsed.reading, reason: null };
}

/**
 * The ledger copy of a reading: the fields a later reader needs to re-judge the
 * claim without the original log. `pairing` is the producer's own word — the
 * typed field, never a re-derived guess; a reading written before the field
 * existed is `absent` and says so.
 */
export function summarizeReading(reading: KernelReading): ReadingEvidence {
  const pairing: Pairing = reading.pairing ?? "absent";
  return {
    contractSha: reading.contractSha,
    basis: reading.basis,
    hostBoundRatio: reading.hostBoundRatio ?? null,
    hostBoundVerdict: reading.hostBoundVerdict,
    pairing,
    verdict: containsUnmeasured(reading) ? "unmeasured" : reading.hostBoundVerdict === "host_bound" ? "host_bound" : "measured",
    cells: reading.cells.map((cell) => ({
      id: cell.id,
      group: cell.group ?? DEFAULT_GROUP,
      median: cell.median,
      spreadPct: cell.spreadPct,
    })),
    startedAt: reading.startedAt,
    warnings: reading.warnings,
  };
}

/**
 * `unmeasured` anywhere in the record — the verdict, a pairing, a warning that
 * says the error is unavailable — makes the whole reading unmeasured. Searching
 * the values rather than naming the fields is deliberate: a field added later
 * that says "unmeasured" must not slip through as a pass.
 */
function containsUnmeasured(value: unknown, depth = 0): boolean {
  if (depth > 8) return false;
  if (typeof value === "string") return value.trim().toLowerCase() === "unmeasured";
  if (Array.isArray(value)) return value.some((entry) => containsUnmeasured(entry, depth + 1));
  if (value !== null && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).some((entry) => containsUnmeasured(entry, depth + 1));
  }
  return false;
}

function sanitizeMetrics(raw: Record<string, unknown>, errors: string[]): Record<string, number> {  const metrics: Record<string, number> = {};
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

/** One line per dtype: the candidate's error, the ruler, and the threshold it had to beat. */
function precisionLine(comparison: PrecisionComparison): string {
  const parts = comparison.dtypes.map((entry) => {
    const cand = entry.eCand === null ? "e_cand n/a" : `e_cand ${formatPrecisionValue(entry.eCand)}`;
    const ref = entry.eRef === null ? "e_ref unmeasured" : `e_ref ${formatPrecisionValue(entry.eRef)}`;
    const threshold = entry.threshold === null ? "" : `, threshold ${formatPrecisionValue(entry.threshold)}`;
    return `${entry.dtype} ${cand} vs ${ref}${threshold}`;
  });
  return parts.length === 0 ? "no dtype to judge" : parts.join("; ");
}

export function formatCandidateOutcome(outcome: CandidateOutcome): string {
  if (!outcome.ok) {
    const lines = [
      outcome.refusals.length > 0
        ? `Candidate not recorded — ${outcome.refusals.length} refusal(s), all printed:`
        : "Candidate not recorded:",
    ];
    for (const refusal of outcome.refusals) {
      lines.push(`- ${formatRefusal(refusal)}`);
    }
    for (const error of outcome.errors.slice(outcome.refusals.length)) {
      lines.push(`- ${error}`);
    }
    return lines.join("\n");
  }
  const r = outcome.record;
  const lines = [
    `recorded ${r.id} (${r.decision}) — parent ${r.parent}`,
    `  diff ${r.diffHash.slice(0, 12)}  contract ${r.contractSha.slice(0, 12)}`,
    r.metrics.geomean_speedup !== undefined ? `  geomean_speedup ${r.metrics.geomean_speedup}` : null,
    r.profile ? `  profile ${r.profile.runId} (${r.profile.sha256.slice(0, 12)})` : null,
    r.bottleneck ? `  bottleneck: ${r.bottleneck.claim} [${r.bottleneck.metric} = ${r.bottleneck.value}]` : null,
    r.reading
      ? `  reading: basis ${r.reading.basis}, hostBoundRatio ${r.reading.hostBoundRatio ?? "absent"}, verdict ${r.verdict}, pairing ${r.pairing}`
      : `  reading: none — verdict ${r.verdict}, pairing ${r.pairing}`,
    outcome.precision?.armed ? `  precision: ${precisionLine(outcome.precision)}` : null,
    ...(outcome.precision?.armed ? outcome.precision.warnings.map((warning) => `  precision warning: ${warning}`) : []),
    r.wiki === null
      ? null
      : r.wiki.state === "produced"
        ? `  wiki: ${r.wiki.id}`
        : r.wiki.state === "declined"
          ? `  wiki: declined — ${r.wiki.reason}`
          : "  wiki: none (this keep proved no transferable mechanism)",
    r.forcedRules.length > 0 ? `  forced through: ${r.forcedRules.join(", ")}` : null,
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
  const body = lines.join("\n");
  return outcome.warnings.length === 0
    ? body
    : `${body}\n\nwarning(s):\n${outcome.warnings.map((warning) => `- ${warning}`).join("\n")}`;
}
