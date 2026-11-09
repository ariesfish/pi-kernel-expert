/**
 * The reading block `goal.sh` prints once per run, and the parser that turns it
 * back into a typed record.
 *
 * One rule shapes every field here: a number that bash cannot measure is
 * absent, never zero. The generated script times only its own wall clock
 * (`shellMs`) and asks `nvidia-smi` for GPU state; device and enqueue figures
 * come from the task's own output (`METRIC device_ms=`, `METRIC
 * host_enqueue_ms=`), because a shell cannot clock the device. A host-free
 * basis (`cuda_graph`, `cupti_kernel_span`) needs a runner that can, and that
 * arrives with the runner, not with this script.
 *
 * `cells[]` holds one entry per (cell, input group): a run judged on several
 * data sets produces several entries under one cell id, and the per-cell
 * aggregate stays a `METRIC` line rather than a second reading entry.
 *
 * `pairing` / `pairRatios` / `pairSpreadPct` say whether a same-job reference
 * rode the run and whether its two ratios agreed. They are additive and
 * optional: a reading written before pairing existed still parses, and the
 * parser refuses an unknown state by name instead of guessing one.
 *
 * The parser is strict on purpose. A record here may be the only evidence a
 * promotion claim rests on, so a truncated block, a body that is not JSON, an
 * unknown `schemaVersion`, or a verdict that contradicts its ratio is refused
 * with a reason a caller can print — not repaired.
 */
import type { Basis } from "./contract.ts";

export const READING_SCHEMA_VERSION = 1;
export const READING_START_MARKER = "=== KERNEL READING ===";
export const READING_END_MARKER = "=== END KERNEL READING ===";

/** A plain basis is host-bound at or above this enqueue/device ratio. */
export const HOST_BOUND_RATIO = 0.5;

export type HostBoundVerdict = "host_bound" | "ok" | "unmeasured";

/**
 * `task-reported`: the bench command supplied device/enqueue figures.
 * `shell-wall`: it supplied neither, so the only clock in the record is the
 * shell's own wall time — which is not device time and never forms a ratio.
 */
export type BasisSource = "task-reported" | "shell-wall";

export const BASIS_SOURCE_VALUES = ["task-reported", "shell-wall"] as const satisfies readonly BasisSource[];
export const HOST_BOUND_VERDICTS = ["host_bound", "ok", "unmeasured"] as const satisfies readonly HostBoundVerdict[];

/**
 * Whether a same-job reference rode the run and whether its two ratios agreed.
 * `absent` is legal (a contract with no `referenceCommand` keeps a labelled
 * cross-run baseline); `inadmissible` means the reference did ride the run but
 * the pair decides nothing, and the reading's warnings say why.
 */
export type Pairing = "mirrored" | "inadmissible" | "absent";

export const PAIRING_VALUES = ["mirrored", "inadmissible", "absent"] as const satisfies readonly Pairing[];

/** One `nvidia-smi` sample. Anything the driver reports as `[N/A]` is absent. */
export interface GpuSample {
  clocksSmMhz?: number;
  clocksMemMhz?: number;
  utilPct?: number;
  /** Memory held by processes that are not this run. > 0 means contended. */
  foreignProcessMiB?: number;
}

export interface ReadingGpu {
  available: boolean;
  /** Why the state is missing. Present exactly when `available` is false. */
  error?: string;
  name?: string;
  index?: number;
  /** `CUDA_VISIBLE_DEVICES` as inherited: the claim, when the run made one. */
  visible?: string;
  start?: GpuSample;
  end?: GpuSample;
}

export interface ReadingCell {
  id: string;
  /**
   * The input group this entry measured. Absent on a record taken before groups
   * existed (`schemaVersion` stays 1: the field is additive and optional); the
   * generated script always writes one, `default` for a cell with no groups.
   */
  group?: string;
  /** The `METRIC` name the run printed for this cell (per group, when grouped). */
  metric: string;
  /** Absent only when the run's number was not JSON-representable. */
  median?: number;
  samples: number;
  /** Full sample range as a percentage of the median; absent for one sample. */
  spreadPct?: number;
}

export interface KernelReading {
  schemaVersion: 1;
  contractSha: string;
  basis: Basis;
  basisSource: BasisSource;
  gpu: ReadingGpu;
  cells: ReadingCell[];
  /** The script's own wall clock around the measured region; not device time. */
  shellMs?: number;
  hostEnqueueMs?: number;
  deviceMs?: number;
  /**
   * `hostEnqueueMs / deviceMs`, both task-reported. `null` when the task did
   * not supply both: a ratio across two origins would mean nothing.
   */
  hostBoundRatio: number | null;
  hostBoundVerdict: HostBoundVerdict;
  /** Why the verdict is `unmeasured`. Absent when there is a ratio. */
  hostBoundReason?: string;
  startedAt: string;
  finishedAt: string;
  /**
   * Written by the generated script when the contract names a reference; absent
   * on a reading taken before pairing existed (the field is additive, so
   * `schemaVersion` stays 1). The parser never invents it.
   */
  pairing?: Pairing;
  /**
   * Two ratios per cell, in cell order: `ref1/k1` then `ref2/k2` (inverted when
   * higher is better). Never one on its own — half a pair is not a pair.
   */
  pairRatios?: number[];
  /**
   * Worst per-cell spread of a cell's two ratios, as a percentage of their
   * mid-point. Above 5% the pair is `inadmissible`.
   */
  pairSpreadPct?: number;
  /** The `nvidia-smi --version` line, when the tool was there to ask. */
  nvidiaSmi?: string;
  warnings: string[];
}

export type ReadingParseResult = { ok: true; reading: KernelReading } | { ok: false; reason: string };

/** The tri-state verdict for an enqueue/device ratio. `null` is unmeasured. */
export function verdictForRatio(ratio: number | null): HostBoundVerdict {
  if (ratio === null || !Number.isFinite(ratio)) return "unmeasured";
  return ratio >= HOST_BOUND_RATIO ? "host_bound" : "ok";
}

/**
 * Find and validate the last reading block in `text`. Last, because a
 * concatenated log holds several runs and the newest one is the evidence.
 */
export function parseReadingBlock(text: string): ReadingParseResult {
  const start = text.lastIndexOf(READING_START_MARKER);
  if (start === -1) return { ok: false, reason: "no reading block" };

  const bodyStart = start + READING_START_MARKER.length;
  const end = text.indexOf(READING_END_MARKER, bodyStart);
  if (end === -1) {
    return {
      ok: false,
      reason: `reading block is truncated: no "${READING_END_MARKER}" after "${READING_START_MARKER}"`,
    };
  }

  const body = text.slice(bodyStart, end).trim();
  if (body === "") {
    return {
      ok: false,
      reason: `reading block is empty: nothing between "${READING_START_MARKER}" and "${READING_END_MARKER}"`,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (error) {
    return {
      ok: false,
      reason: `reading block is not JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: "reading block is not a JSON object" };
  }

  const record = parsed as Record<string, unknown>;
  if (record.schemaVersion !== READING_SCHEMA_VERSION) {
    return {
      ok: false,
      reason: `reading block schemaVersion ${JSON.stringify(record.schemaVersion ?? null)} is not understood by this build (reads ${READING_SCHEMA_VERSION}); regenerate with kernel_contract`,
    };
  }

  const issues = readingIssues(record);
  if (issues.length > 0) {
    return { ok: false, reason: `reading block is malformed: ${issues.join("; ")}` };
  }
  return { ok: true, reading: record as unknown as KernelReading };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Structural checks, not a schema library. Every issue is a one-line phrase so
 * the joined reason stays printable in a refusal.
 */
function readingIssues(record: Record<string, unknown>): string[] {
  const issues: string[] = [];

  if (typeof record.contractSha !== "string" || record.contractSha.trim() === "") {
    issues.push("contractSha is missing");
  }
  if (record.basis !== "device" && record.basis !== "e2e") {
    issues.push(`basis must be "device" or "e2e", got ${JSON.stringify(record.basis ?? null)}`);
  }
  if (!(BASIS_SOURCE_VALUES as readonly unknown[]).includes(record.basisSource)) {
    issues.push(`basisSource must be one of ${BASIS_SOURCE_VALUES.join(", ")}, got ${JSON.stringify(record.basisSource ?? null)}`);
  }

  if (!isPlainObject(record.gpu) || typeof record.gpu.available !== "boolean") {
    issues.push("gpu must be an object with a boolean available");
  } else {
    if (record.gpu.available === false && (typeof record.gpu.error !== "string" || record.gpu.error.trim() === "")) {
      issues.push("gpu.available is false but gpu.error is missing");
    }
    for (const phase of ["start", "end"] as const) {
      const sample = record.gpu[phase];
      if (sample !== undefined && !isPlainObject(sample)) {
        issues.push(`gpu.${phase} must be an object when present`);
      }
    }
  }

  if (!Array.isArray(record.cells) || record.cells.length === 0) {
    issues.push("cells must be a non-empty array");
  } else {
    for (const [index, cell] of record.cells.entries()) {
      if (!isPlainObject(cell)) {
        issues.push(`cells[${index}] is not an object`);
        continue;
      }
      if (typeof cell.id !== "string" || cell.id === "") issues.push(`cells[${index}].id is missing`);
      if (cell.group !== undefined && (typeof cell.group !== "string" || cell.group === "")) {
        issues.push(`cells[${index}].group must be a non-empty string when present`);
      }
      if (typeof cell.metric !== "string" || cell.metric === "") issues.push(`cells[${index}].metric is missing`);
      if (cell.median !== undefined && !isFiniteNumber(cell.median)) {
        issues.push(`cells[${index}].median is not a number`);
      }
      if (!Number.isInteger(cell.samples) || (cell.samples as number) < 1) {
        issues.push(`cells[${index}].samples must be a positive integer`);
      }
      if (cell.spreadPct !== undefined && !isFiniteNumber(cell.spreadPct)) {
        issues.push(`cells[${index}].spreadPct is not a number`);
      }
    }
  }

  for (const key of ["shellMs", "hostEnqueueMs", "deviceMs"] as const) {
    if (record[key] !== undefined && !isFiniteNumber(record[key])) {
      issues.push(`${key} must be a number when present`);
    }
  }

  if (!("hostBoundRatio" in record)) {
    issues.push("hostBoundRatio is missing (use null when it cannot be measured)");
  } else if (record.hostBoundRatio !== null && !isFiniteNumber(record.hostBoundRatio)) {
    issues.push("hostBoundRatio must be a number or null");
  }

  if (!(HOST_BOUND_VERDICTS as readonly unknown[]).includes(record.hostBoundVerdict)) {
    issues.push(
      `hostBoundVerdict must be one of ${HOST_BOUND_VERDICTS.join(", ")}, got ${JSON.stringify(record.hostBoundVerdict ?? null)}`,
    );
  } else if (issues.length === 0) {
    // A verdict that disagrees with its own ratio is a producer bug, and a
    // lenient reader would let it pass as evidence.
    const ratio = record.hostBoundRatio as number | null;
    const expected = verdictForRatio(ratio);
    if (record.hostBoundVerdict !== expected) {
      issues.push(
        `hostBoundVerdict "${String(record.hostBoundVerdict)}" contradicts hostBoundRatio ${String(ratio)} (expected "${expected}")`,
      );
    }
  }

  if (record.hostBoundReason !== undefined && typeof record.hostBoundReason !== "string") {
    issues.push("hostBoundReason must be a string when present");
  }

  // The paired reading. An unknown state is refused by name rather than ignored:
  // a reader that guessed would have to decide on its own whether a keep rested
  // on a same-job ratio or on nothing.
  if (record.pairing !== undefined && !(PAIRING_VALUES as readonly unknown[]).includes(record.pairing)) {
    issues.push(`pairing must be one of ${PAIRING_VALUES.join(", ")}, got ${JSON.stringify(record.pairing ?? null)}`);
  }
  if (record.pairRatios !== undefined) {
    if (!Array.isArray(record.pairRatios)) {
      issues.push("pairRatios must be an array of numbers when present");
    } else {
      for (const [index, ratio] of record.pairRatios.entries()) {
        if (!isFiniteNumber(ratio)) issues.push(`pairRatios[${index}] is not a number`);
      }
    }
  }
  if (record.pairSpreadPct !== undefined && !isFiniteNumber(record.pairSpreadPct)) {
    issues.push("pairSpreadPct must be a number when present");
  }
  if (typeof record.startedAt !== "string" || record.startedAt === "") issues.push("startedAt is missing");
  if (typeof record.finishedAt !== "string" || record.finishedAt === "") issues.push("finishedAt is missing");
  if (record.nvidiaSmi !== undefined && typeof record.nvidiaSmi !== "string") {
    issues.push("nvidiaSmi must be a string when present");
  }
  if (!Array.isArray(record.warnings) || record.warnings.some((warning) => typeof warning !== "string")) {
    issues.push("warnings must be an array of strings");
  }

  return issues;
}
