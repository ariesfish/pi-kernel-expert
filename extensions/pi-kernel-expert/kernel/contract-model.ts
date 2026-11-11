import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { matchesGlob } from "../support/glob.ts";

/** The schema this build writes and the only one it reads. */
export const CONTRACT_SCHEMA_VERSION = 2;

/**
 * How the number was taken: `device` means the kernel's own device time, `e2e`
 * means the whole host-to-device call. A comparison across bases is meaningless.
 */
export type Basis = "device" | "e2e";

export const BASIS_VALUES = ["device", "e2e"] as const satisfies readonly Basis[];

/**
 * What the generated scripts already protect. The task's own comparator is not
 * here by design: it cannot be guessed, so the task must add it.
 */
export const DEFAULT_HARNESS_GLOBS = [
  "goal.sh",
  "goal.checks.sh",
  // The ruler and the comparison point are as load-bearing as the scripts: a
  // candidate that edits its own calibration loosens the precision gate, and
  // one that edits the baseline picks the number it is compared to.
  ".kernel/calibration.json",
  ".kernel/precision.tsv",
  ".kernel/baseline.tsv",
] as const;

/**
 * One data set a cell is judged on. A shape is not a data set: a cell names
 * the distributions the kernel must survive, and each one carries the reason
 * it exists, because "holdout" is already true of every input.
 */
export interface Group {
  /** Exported as `KERNEL_GROUP`; `[A-Za-z0-9][A-Za-z0-9_.-]*`, unique in its cell. */
  name: string;
  /** What this data set must prove. Required: a group without one is a contract error. */
  intent: string;
  /** Optional integer the command may use to build the data. Exported as `KERNEL_GROUP_SEED`. */
  seed?: number;
}

/** A non-boundary cell is a data set, not a shape: three groups or it is refused. */
export const MIN_GROUPS_PER_CELL = 3;

/** What a cell with no groups exports, so the old one-shape command still runs. */
export const DEFAULT_GROUP = "default";

export interface CellInput {
  id: string;
  dtype: string;
  /** Exported to the commands as `KERNEL_<KEY>=<value>`. */
  vars?: Record<string, string>;
  boundary?: boolean;
  /** Required (>= MIN_GROUPS_PER_CELL) unless the cell is a boundary probe. */
  groups?: Group[];
}

export interface ContractInput {
  objective: string;
  checkCommand: string;
  benchmarkCommand: string;
  cells: CellInput[];
  tolerance: { rtol: number; atol: number };
  metricName?: string;
  direction?: "lower" | "higher";
  repeats?: number;
  warmup?: number;
  guardPct?: number;
  noiseFloorPct?: number;
  checksTimeoutSeconds?: number;
  scopeGlobs?: string[];
  testGlobs?: string[];
  basis?: Basis;
  harnessGlobs?: string[];
  referenceCommand?: string;
  /**
   * Measures the REFERENCE against itself and prints `max_diff=<number>`; run
   * once per dtype by `bash goal.checks.sh --calibrate`. Absent means the
   * precision gate has no ruler and stays unarmed.
   */
  calibrateCommand?: string;
  /** Wall-clock burn-in before the first measured window when pairing. Default 4000. */
  burnInMs?: number;
  /** The operator's clock lock, declared so the reading can say what it ran under. */
  clockLock?: { sm: number; mem?: number };
  generator?: string;
}

export interface Cell extends Required<Omit<CellInput, "boundary" | "vars" | "groups">> {
  vars: Record<string, string>;
  boundary: boolean;
  /** Empty only on a boundary cell; the scripts then iterate `default` once. */
  groups: Group[];
}

export interface KernelContract {
  schemaVersion: 2;
  objective: string;
  checkCommand: string;
  benchmarkCommand: string;
  cells: Cell[];
  tolerance: { rtol: number; atol: number };
  metricName: string;
  direction: "lower" | "higher";
  repeats: number;
  warmup: number;
  guardPct: number;
  noiseFloorPct: number;
  checksTimeoutSeconds: number;
  scopeGlobs: string[];
  testGlobs: string[];
  basis: Basis;
  harnessGlobs: string[];
  /** `null` when the task has no same-job reference; a self-reference is refused. */
  referenceCommand: string | null;
  /**
   * `null` when the task has no calibration: the check's `max_diff` then has no
   * ruler, so `kernel_candidate`'s precision gate is unarmed rather than
   * refusing every candidate against an invented `e_ref` of 0.
   */
  calibrateCommand: string | null;
  burnInMs: number;
  /** `null` when no lock was declared: an undeclared lock is invisible, not absent. */
  clockLock: { sm: number; mem: number | null } | null;
  generator: string;
}

export const DEFAULT_METRIC_NAME = "latency_us";

const ID_RULE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const VAR_KEY_RULE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const METRIC_RULE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const FORBIDDEN_IN_VALUE = /[|\n\r,]/;
/** A group `intent` is a sentence, so commas are fine; it travels in a `|`-separated row. */
const FORBIDDEN_IN_INTENT = /[|\n\r]/;

export interface NormalizeResult {
  contract?: KernelContract;
  errors: string[];
  /** Non-blocking findings, e.g. a harness file no glob covers. */
  warnings: string[];
}

export interface NormalizeOptions {
  /**
   * Task root. When given and the caller omitted `harnessGlobs`, the commands
   * are scanned for relative paths that exist on disk but no glob covers.
   */
  root?: string;
}

export function normalizeContract(input: ContractInput, options: NormalizeOptions = {}): NormalizeResult {
  const errors: string[] = [];

  if (!input.objective?.trim()) errors.push("objective is required");
  if (!input.checkCommand?.trim()) errors.push("checkCommand is required");
  if (!input.benchmarkCommand?.trim()) errors.push("benchmarkCommand is required");

  const metricName = input.metricName?.trim() || DEFAULT_METRIC_NAME;
  if (!METRIC_RULE.test(metricName)) {
    errors.push(`metricName "${metricName}" must match ${METRIC_RULE}`);
  }
  const direction = input.direction ?? "lower";
  if (direction !== "lower" && direction !== "higher") {
    errors.push(`direction must be "lower" or "higher"`);
  }

  const repeats = input.repeats ?? 5;
  if (!Number.isInteger(repeats) || repeats < 1 || repeats > 50) {
    errors.push("repeats must be an integer between 1 and 50");
  }
  const warmup = input.warmup ?? 1;
  if (!Number.isInteger(warmup) || warmup < 0 || warmup > 20) {
    errors.push("warmup must be an integer between 0 and 20");
  }
  const guardPct = input.guardPct ?? 5;
  if (!Number.isFinite(guardPct) || guardPct < 0 || guardPct > 100) {
    errors.push("guardPct must be between 0 and 100");
  }
  const noiseFloorPct = input.noiseFloorPct ?? 2;
  if (!Number.isFinite(noiseFloorPct) || noiseFloorPct < 0 || noiseFloorPct > 50) {
    errors.push("noiseFloorPct must be between 0 and 50");
  }
  const checksTimeoutSeconds = input.checksTimeoutSeconds ?? 900;
  if (!Number.isInteger(checksTimeoutSeconds) || checksTimeoutSeconds < 1) {
    errors.push("checksTimeoutSeconds must be a positive integer");
  }

  const tolerance = input.tolerance;
  if (!tolerance || !Number.isFinite(tolerance.rtol) || !Number.isFinite(tolerance.atol)) {
    errors.push("tolerance.rtol and tolerance.atol must be numbers");
  } else {
    if (tolerance.rtol < 0) errors.push("tolerance.rtol must be >= 0");
    if (tolerance.atol < 0) errors.push("tolerance.atol must be >= 0");
  }

  const cells: Cell[] = [];
  if (!Array.isArray(input.cells) || input.cells.length === 0) {
    errors.push("at least one matrix cell is required");
  } else {
    const seen = new Set<string>();
    for (const [index, cell] of input.cells.entries()) {
      const where = `cells[${index}]`;
      if (!cell.id || !ID_RULE.test(cell.id)) {
        errors.push(`${where}.id "${cell.id ?? ""}" must match ${ID_RULE}`);
      } else if (seen.has(cell.id.toLowerCase())) {
        errors.push(`${where}.id "${cell.id}" is duplicated`);
      } else {
        seen.add(cell.id.toLowerCase());
      }
      if (!cell.dtype?.trim()) errors.push(`${where}.dtype is required`);
      else if (FORBIDDEN_IN_VALUE.test(cell.dtype)) {
        errors.push(`${where}.dtype must not contain "|", ",", or a newline`);
      }
      const vars: Record<string, string> = {};
      for (const [key, value] of Object.entries(cell.vars ?? {})) {
        if (!VAR_KEY_RULE.test(key)) {
          errors.push(`${where}.vars.${key} must match ${VAR_KEY_RULE}`);
          continue;
        }
        if (value === undefined || value === null || String(value) === "") {
          errors.push(`${where}.vars.${key} is empty`);
          continue;
        }
        if (FORBIDDEN_IN_VALUE.test(String(value))) {
          errors.push(`${where}.vars.${key} must not contain "|", ",", or a newline`);
          continue;
        }
        vars[key.toUpperCase()] = String(value);
      }
      const boundary = cell.boundary === true;
      const groups = normalizeGroups(cell, where, errors);
      // A non-boundary cell is a claim that the kernel is correct, not that one
      // shape of one distribution is. Three data sets make the claim checkable.
      if (!boundary && groups.length < MIN_GROUPS_PER_CELL) {
        errors.push(
          `${where} (cell "${cell.id}") has ${groups.length} input group(s); a non-boundary cell needs at least ${MIN_GROUPS_PER_CELL} — name the data sets as { name, intent } (e.g. typical, zero_block, masked), or mark the cell boundary: true if it is a shape-extreme probe rather than a data set`,
        );
      }
      cells.push({
        id: cell.id,
        dtype: cell.dtype,
        vars,
        boundary,
        groups,
      });
    }
  }

  const scopeGlobs = cleanGlobs(input.scopeGlobs, "scopeGlobs", errors);
  const testGlobs = cleanGlobs(input.testGlobs, "testGlobs", errors);

  const basis = input.basis ?? "device";
  if (basis !== "device" && basis !== "e2e") {
    errors.push(`basis must be "device" or "e2e", got ${JSON.stringify(input.basis)}`);
  }

  const harnessGlobs =
    input.harnessGlobs === undefined
      ? [...DEFAULT_HARNESS_GLOBS]
      : cleanGlobs(input.harnessGlobs, "harnessGlobs", errors);
  if (input.harnessGlobs !== undefined && harnessGlobs.length === 0) {
    errors.push(
      `harnessGlobs must name at least one protected path; omit it to keep the default (${DEFAULT_HARNESS_GLOBS.join(", ")})`,
    );
  }

  const burnInMs = input.burnInMs ?? BURN_IN_MS_DEFAULT;
  if (!Number.isInteger(burnInMs) || burnInMs < 0 || burnInMs > BURN_IN_MS_MAX) {
    errors.push(`burnInMs must be an integer between 0 and ${BURN_IN_MS_MAX}`);
  }

  const clockLock = input.clockLock === undefined ? null : input.clockLock;
  if (clockLock !== null) {
    if (!Number.isFinite(clockLock.sm) || clockLock.sm < 100 || clockLock.sm > 5000) {
      errors.push("clockLock.sm must be a frequency in MHz between 100 and 5000");
    }
    if (clockLock.mem !== undefined && (!Number.isFinite(clockLock.mem) || clockLock.mem < 100 || clockLock.mem > 10000)) {
      errors.push("clockLock.mem must be a frequency in MHz between 100 and 10000");
    }
  }

  const benchmarkCommand = input.benchmarkCommand?.trim() ?? "";
  const referenceCommand = input.referenceCommand?.trim() || null;
  if (referenceCommand !== null && referenceCommand === benchmarkCommand) {
    errors.push(
      `referenceCommand and benchmarkCommand are the same command ("${referenceCommand}"); a self-reference is not a reference`,
    );
  }
  // Not the benchmark: a calibration measures the reference against itself and
  // prints an error, not a time. It may legitimately be the check command, so
  // equality with that one is fine.
  const calibrateCommand = input.calibrateCommand?.trim() || null;

  if (errors.length > 0) return { errors, warnings: [] };
  const contract: KernelContract = {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    objective: input.objective.trim(),
    checkCommand: input.checkCommand.trim(),
    benchmarkCommand: input.benchmarkCommand.trim(),
    cells,
    tolerance: { rtol: tolerance.rtol, atol: tolerance.atol },
    metricName,
    direction,
    repeats,
    warmup,
    guardPct,
    noiseFloorPct,
    checksTimeoutSeconds,
    scopeGlobs,
    testGlobs,
    basis,
    harnessGlobs,
    referenceCommand,
    calibrateCommand,
    burnInMs,
    clockLock: clockLock === null ? null : { sm: clockLock.sm, mem: clockLock.mem ?? null },
    generator: input.generator?.trim() || "pi-kernel-expert",
  };
  const warnings =
    input.harnessGlobs === undefined && options.root
      ? uncoveredHarnessWarnings(contract, options.root)
      : [];
  return { contract, errors: [], warnings };
}

/**
 * Cheap catch for "the comparator is writable": the default globs only cover
 * the generated scripts, so any other relative path a command invokes and that
 * exists on disk is named. A warning, never an error — the file may be a
 * vendored read-only helper the user trusts.
 */
export function uncoveredHarnessWarnings(contract: KernelContract, root: string): string[] {
  const warnings: string[] = [];
  const seen = new Set<string>();
  const commands: Array<[string, string]> = [
    ["benchmarkCommand", contract.benchmarkCommand],
    ["checkCommand", contract.checkCommand],
  ];
  for (const [field, command] of commands) {
    for (const token of commandTokens(command)) {
      if (seen.has(token)) continue;
      seen.add(token);
      const absolute = path.join(root, token);
      if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) continue;
      if (contract.harnessGlobs.some((glob) => matchesGlob(glob, token))) continue;
      warnings.push(
        `${token} (called by ${field}) exists but no harnessGlobs entry covers it; add it so a diff cannot edit that harness`,
      );
    }
  }
  return warnings;
}

/** Relative path-looking words in a command line; flags and shell syntax are skipped. */
function commandTokens(command: string): string[] {
  return command
    .split(/[\s|;]+/)
    .map((token) => token.replace(/^['"]|['"]$/g, ""))
    .filter((token) => token !== "")
    .filter((token) => !token.startsWith("-"))
    .filter((token) => !/[$`=()*<>]/.test(token))
    .filter((token) => !token.startsWith("/") && !token.endsWith("/"))
    .map((token) => token.replace(/^\.\//, ""));
}

function cleanGlobs(value: string[] | undefined, label: string, errors: string[]): string[] {
  if (value === undefined) return [];
  const cleaned: string[] = [];
  for (const glob of value) {
    if (typeof glob !== "string" || glob.trim() === "") {
      errors.push(`${label} entries must be non-empty strings`);
      continue;
    }
    cleaned.push(glob.trim());
  }
  return cleaned;
}

export function contractJson(contract: KernelContract): string {
  return `${JSON.stringify(contract, null, 2)}\n`;
}

export function contractSha(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function cellMetricName(contract: KernelContract, cell: Cell): string {
  const safe = cell.id.replace(/[^A-Za-z0-9]/g, "_");
  return `${contract.metricName}_${safe}`;
}

/**
 * Groups are structural: a group without an `intent` is a contract error, not a
 * warning, because an input the writer cannot justify is an input nobody can
 * judge a failure against. `groups` is never defaulted here — the point is that
 * the writer states the data sets; a boundary cell is the one place an empty
 * list is legal.
 */
function normalizeGroups(cell: CellInput, where: string, errors: string[]): Group[] {
  const raw = cell.groups as unknown;
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    errors.push(`${where}.groups must be an array of { name, intent, seed? }`);
    return [];
  }

  const groups: Group[] = [];
  const seen = new Set<string>();
  for (const [index, entry] of raw.entries()) {
    const at = `${where}.groups[${index}]`;
    const group = (entry ?? {}) as Partial<Group>;
    const name = typeof group.name === "string" ? group.name.trim() : "";
    if (name === "" || !ID_RULE.test(name)) {
      errors.push(`${at}.name "${name}" must match ${ID_RULE}`);
      continue;
    }
    if (seen.has(name.toLowerCase())) {
      errors.push(`${at}.name "${name}" is duplicated in cell "${cell.id}"; group names must be unique within a cell`);
      continue;
    }
    seen.add(name.toLowerCase());
    const intent = typeof group.intent === "string" ? group.intent.trim() : "";
    if (intent === "") {
      errors.push(
        `${at} (group "${name}" of cell "${cell.id}") has no intent: say what this data set must prove, or drop it`,
      );
      continue;
    }
    if (FORBIDDEN_IN_INTENT.test(intent)) {
      errors.push(`${at}.intent (group "${name}") must not contain "|" or a newline`);
      continue;
    }
    if (group.seed !== undefined && group.seed !== null) {
      if (!Number.isInteger(group.seed)) {
        errors.push(`${at}.seed (group "${name}") must be an integer, got ${JSON.stringify(group.seed)}`);
        continue;
      }
      groups.push({ name, intent, seed: group.seed });
      continue;
    }
    groups.push({ name, intent });
  }
  return groups;
}

export function groupMetricName(contract: KernelContract, cell: Cell, group: Group): string {
  const safeCell = cell.id.replace(/[^A-Za-z0-9]/g, "_");
  const safeGroup = group.name.replace(/[^A-Za-z0-9]/g, "_");
  return `${contract.metricName}_${safeCell}_${safeGroup}`;
}

/**
 * Two same-job ratios that disagree by more than this percentage represent no
 * single period, so the pair decides nothing. The same 5% band ForgeKernel
 * admits a paired re-measure with (`_PAIRED_SPREAD_MAX`), quoted relative to the
 * mid-point of the two ratios.
 */
export const PAIR_SPREAD_MAX_PCT = 5;

/** The reference is burned in until this much wall clock has passed (at least one run). */
export const BURN_IN_MS_DEFAULT = 4000;
export const BURN_IN_MS_MAX = 120000;

/** The burn-in cap: a slow kernel must not spend the run's budget warming up. */
/** A bench command is a process; 2000 runs covers a 2 ms command for the full 4 s. */
export const BURN_IN_MAX_RUNS = 2000;

/** Fewer usable ratios than this is one draw, not a pair. */
export const PAIR_MIN_RATIOS = 2;
