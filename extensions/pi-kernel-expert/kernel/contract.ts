import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { workspacePaths } from "../workspace/layout.ts";

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
      if (contract.harnessGlobs.some((glob) => globMatches(glob, token))) continue;
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

/** Enough glob for harness paths: `*`, `?`, and `**`. */
function globMatches(glob: string, relativePath: string): boolean {
  return globToRegExp(glob.replace(/^\.\//, "")).test(relativePath);
}

function globToRegExp(glob: string): RegExp {
  let source = "";
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index];
    if (char === "*") {
      if (glob[index + 1] === "*") {
        index += 1;
        if (glob[index + 1] === "/") {
          index += 1;
          source += "(?:.*/)?";
        } else {
          source += ".*";
        }
      } else {
        source += "[^/]*";
      }
      continue;
    }
    if (char === "?") {
      source += "[^/]";
      continue;
    }
    source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${source}$`);
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

export interface FreezeCriterion {
  id: string;
  statement: string;
  kind: "metric" | "command";
  blocking: boolean;
  metric?: { name: string; direction: "higher" | "lower"; unit?: string };
  check?: { command: string; expect: "exit0"; timeoutSeconds?: number };
}

export interface FreezePayload {
  objective: string;
  criteria: FreezeCriterion[];
  test_globs: string[];
  scope_globs: string[];
  basis: Basis;
  harness_globs: string[];
  /** Recorded even when there is none, so the payload always states the pairing. */
  reference_command: string | null;
  burn_in_ms: number;
  clock_lock: { sm: number; mem: number | null } | null;
}

/** Exactly one blocking metric criterion, as pi-goal requires. */
export function freezePayload(contract: KernelContract): FreezePayload {
  const groups = contract.cells.reduce((total, cell) => total + cell.groups.length, 0);
  return {
    objective: contract.objective,
    criteria: [
      {
        id: "M1",
        statement: `geomean speedup over the recorded baseline across ${contract.cells.length} matrix cell(s) (each cell is the geomean of its input group(s), so one group's regression moves the cell; ${groups} group(s) in the matrix)`,
        kind: "metric",
        blocking: true,
        metric: { name: "geomean_speedup", direction: "higher", unit: "x" },
      },
      {
        id: "C1",
        statement: "every matrix cell matches the reference on every input group, on two consecutive passes",
        kind: "command",
        blocking: true,
        check: {
          command: "bash goal.checks.sh",
          expect: "exit0",
          timeoutSeconds: contract.checksTimeoutSeconds,
        },
      },
    ],
    test_globs: contract.testGlobs,
    scope_globs: contract.scopeGlobs,
    basis: contract.basis,
    harness_globs: contract.harnessGlobs,
    reference_command: contract.referenceCommand,
    burn_in_ms: contract.burnInMs,
    clock_lock: contract.clockLock,
  };
}

export interface WriteResult {
  written: string[];
  sha: string;
  freeze: FreezePayload;
}

export type WriteOutcome = { ok: true; result: WriteResult } | { ok: false; errors: string[] };

export function writeContractFiles(options: {
  root: string;
  contract: KernelContract;
  force?: boolean;
}): WriteOutcome {
  // A contract that reached here without going through normalizeContract can
  // only be hand-assembled or carried over from before groups existed. This
  // build never produces one, so it refuses rather than writing a script that
  // silently measures one shape per cell: re-normalize, i.e. regenerate.
  const unnormalized = options.contract.cells.filter((cell) => !Array.isArray(cell.groups));
  if (unnormalized.length > 0) {
    return {
      ok: false,
      errors: unnormalized.map(
        (cell) => `cell "${cell.id}" has no groups array; this contract was not written by this build — regenerate with kernel_contract`,
      ),
    };
  }

  const paths = workspacePaths(options.root);
  const json = contractJson(options.contract);
  const sha = contractSha(json);

  const targets = [paths.contract, paths.benchmarkScript, paths.checksScript, paths.freezePayload];
  if (!options.force) {
    const existing = targets.filter((file) => fs.existsSync(file));
    if (existing.length > 0) {
      return {
        ok: false,
        errors: existing.map(
          (file) => `${file} already exists; pass force to regenerate (pi-goal protects these in sealed mode)`,
        ),
      };
    }
  }

  const freeze = freezePayload(options.contract);
  // Write every file to a sibling temp path first, then rename. A crash leaves
  // either the old artifact set or the new one, never a half-written contract
  // whose scripts disagree with its sha.
  try {
    writeFileAtomic(paths.benchmarkScript, renderBenchmarkScript(options.contract, sha), 0o755);
    writeFileAtomic(paths.checksScript, renderChecksScript(options.contract, sha), 0o755);
    writeFileAtomic(paths.freezePayload, `${JSON.stringify(freeze, null, 2)}\n`);
    writeFileAtomic(paths.contract, json);
  } catch (error) {
    return {
      ok: false,
      errors: [
        `could not write the contract artifacts: ${error instanceof Error ? error.message : String(error)}`,
        `check the workspace is writable at ${options.root}; nothing was committed to disk by this call`,
      ],
    };
  }

  return {
    ok: true,
    result: {
      written: targets.map((file) => file),
      sha,
      freeze,
    },
  };
}

function writeFileAtomic(file: string, contents: string, mode?: number): void {
  const temporary = path.join(
    path.dirname(file),
    `.${path.basename(file)}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 10)}`,
  );
  try {
    fs.writeFileSync(temporary, contents, mode === undefined ? undefined : { mode });
    if (mode !== undefined) fs.chmodSync(temporary, mode);
    fs.renameSync(temporary, file);
  } catch (error) {
    try {
      fs.unlinkSync(temporary);
    } catch {
      // the temp file may never have existed; the original error is the useful one
    }
    throw error;
  }
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
 * The cell table the generated scripts iterate: `id|dtype|rtol|atol|boundary|vars`
 * per cell, and `id|group|seed|intent` per group (the `.kernel/cells.tsv`
 * shape, embedded because the scripts run without a parser).
 */
export function cellRow(contract: KernelContract, cell: Cell): string {
  const vars = Object.entries(cell.vars)
    .map(([key, value]) => `${key}=${value}`)
    .join(",");
  return [cell.id, cell.dtype, String(contract.tolerance.rtol), String(contract.tolerance.atol), cell.boundary ? "1" : "0", vars].join("|");
}

export function groupRow(cell: Cell, group: Group): string {
  return [cell.id, group.name, group.seed === undefined ? "" : String(group.seed), group.intent].join("|");
}

/**
 * Single-quoted for shell: a group intent holds spaces and may hold an apostrophe.
 */
function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function cellsArray(contract: KernelContract): string {
  return contract.cells.map((cell) => shQuote(cellRow(contract, cell))).join(" ");
}

function groupsArray(contract: KernelContract): string {
  const rows: string[] = [];
  for (const cell of contract.cells) {
    for (const group of cell.groups) rows.push(shQuote(groupRow(cell, group)));
  }
  return rows.join(" ");
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

const HASH_FUNCTION = `hash_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    echo "no sha256 tool found (sha256sum or shasum)" >&2
    return 2
  fi
}`;

const EXPORTS = `  IFS='|' read -r cid dtype rtol atol boundary vars <<< "$entry"
  export KERNEL_CELL="$cid" KERNEL_DTYPE="$dtype" KERNEL_RTOL="$rtol" KERNEL_ATOL="$atol" KERNEL_BOUNDARY="$boundary"
  if [[ -n "$vars" ]]; then
    IFS=',' read -ra pairs <<< "$vars"
    for pair in "\${pairs[@]}"; do
      [[ -n "$pair" ]] || continue
      export "KERNEL_\${pair%%=*}=\${pair#*=}"
    done
  fi`;

/**
 * The per-group exports. `KERNEL_GROUP_SEED` and `KERNEL_GROUP_INTENT` are
 * empty rather than absent, so a command can rely on the variable existing.
 */
const GROUP_EXPORTS = `    export KERNEL_GROUP="$gname" KERNEL_GROUP_INTENT="$gintent" KERNEL_GROUP_SEED="$gseed"`;

/**
 * Fills G_NAMES/G_SEEDS/G_INTENTS for one cell. A cell with no groups still runs
 * once — as the group "default" — because a boundary probe is a shape, not a
 * data set, and its command was written before groups existed. G_FROM_CONTRACT
 * records which of the two happened so a failure line can say whether the data
 * or the shape is what broke.
 */
function groupSelect(contract: KernelContract): string {
  return `# CELL_GROUPS, not GROUPS: bash already owns GROUPS (the caller's gids).
CELL_GROUPS=(${groupsArray(contract)})
G_NAMES=()
G_SEEDS=()
G_INTENTS=()
G_INDEX=0
G_FROM_CONTRACT=0
select_groups() {
  local row gcid gname gseed gintent
  G_NAMES=(); G_SEEDS=(); G_INTENTS=(); G_INDEX=0; G_FROM_CONTRACT=1
  for row in \${CELL_GROUPS[@]+"\${CELL_GROUPS[@]}"}; do
    IFS='|' read -r gcid gname gseed gintent <<< "$row"
    [[ "$gcid" == "$1" ]] || continue
    G_NAMES+=("$gname"); G_SEEDS+=("$gseed"); G_INTENTS+=("$gintent")
  done
  if [[ \${#G_NAMES[@]} -eq 0 ]]; then
    G_NAMES=('${DEFAULT_GROUP}'); G_SEEDS=(''); G_INTENTS=(''); G_FROM_CONTRACT=0
  fi
}`;
}

export function renderBenchmarkScript(contract: KernelContract, sha: string): string {
  return `#!/usr/bin/env bash
# Generated by ${contract.generator}. Do not edit: regenerate with kernel_contract.
# Contract: kernel.contract.json (sha256 ${sha})
#
# One machine-readable reading block per run, and one METRIC line per
# (cell, group) plus a per-cell aggregate. Shell can time only its own wall
# clock (shellMs) and read GPU state from nvidia-smi; device and enqueue figures
# are recorded only when the bench command prints them (METRIC device_ms=,
# METRIC host_enqueue_ms=). A host-free basis (cuda_graph, cupti_kernel_span)
# needs a runner that clocks the device: that arrives with the runner, not here.
#
# When the contract names a referenceCommand, the reference rides this job:
# burn-in with the kernel under test, then four measured windows in the order
# ref, kernel, kernel, ref, two per-cell ratios and their spread. The guard and
# geomean_speedup below still read the cross-run baseline; the pair is what a
# keep rests on when it exists.
set -euo pipefail

CONTRACT_SHA=${shQuote(sha)}
METRIC_NAME=${shQuote(contract.metricName)}
DIRECTION=${shQuote(contract.direction)}
BASIS=${shQuote(contract.basis)}
REPEATS=${contract.repeats}
WARMUP=${contract.warmup}
GUARD_PCT=${shQuote(String(contract.guardPct))}
BENCH_CMD=${shQuote(contract.benchmarkCommand)}
BASELINE_FILE='.kernel/baseline.tsv'
# 1 only when the contract names a reference; 0 leaves every window as it was.
PAIRING_ENABLED=${contract.referenceCommand === null ? "0" : "1"}
REF_CMD=${shQuote(contract.referenceCommand ?? "")}
BURN_IN_MS=${contract.burnInMs}
CLOCK_LOCK_SM=${contract.clockLock === null ? "''" : contract.clockLock.sm}
CLOCK_LOCK_MEM=${contract.clockLock?.mem === null || contract.clockLock === null ? "''" : contract.clockLock.mem}
CLOCK_LOCK_DECLARED=${contract.clockLock === null ? "0" : "1"}
BURN_IN_MAX_RUNS=${BURN_IN_MAX_RUNS}
PAIR_MIN_RATIOS=${PAIR_MIN_RATIOS}
PAIR_SPREAD_MAX_PCT=${PAIR_SPREAD_MAX_PCT}
# The cell table: one row per cell, one row per group (see kernel_contract).
CELLS=(${cellsArray(contract)})
${groupSelect(contract)}
READING_START='=== KERNEL READING ==='
READING_END='=== END KERNEL READING ==='

hash_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    echo "no sha256 tool found (sha256sum or shasum)" >&2
    return 2
  fi
}

# --- reading block ---------------------------------------------------------
# Every value below is written with printf and escaped: a GPU name or a warning
# can contain spaces, quotes, or a newline, and JSON cannot.

STARTED_AT=''
START_MS=''
VISIBLE=''
NVIDIA_SMI_VERSION=''
GPU_AVAILABLE=''
GPU_ERROR=''
GPU_NAME=''
GPU_INDEX=''
GPU_SAMPLE_START=''
GPU_SAMPLE_LOADED=''
GPU_LOADED_SM=''
GPU_LOADED_MAX=''
GPU_LOADED_UTIL=''
GPU_SAMPLE_END=''
CELL_JSON=()
HOST_ENQUEUE_VALUES=()
DEVICE_VALUES=()
WARNINGS=()

# --- same-job pairing state ------------------------------------------------
# pairing is always written: absent is a legal, loudly labelled state (a
# task with no referenceCommand keeps its cross-run baseline). PAIR_RATIOS
# carries the two ratios of every cell, PAIR_SPREAD_PCT the worst per-cell
# spread — the worst, not an average: a cell whose two draws disagree is enough
# to say the pair covers no single period.
PAIRING_STATE='absent'
PAIR_RATIOS=()
PAIR_SPREAD_PCT=''
PAIR_FAILED_CELLS=0
BURN_IN_DONE=0

json_escape() {
  local s="$1"
  s=\${s//\\\\/\\\\\\\\}
  s=\${s//\\"/\\\\\\"}
  s=\${s//$'\\n'/\\\\n}
  s=\${s//$'\\r'/\\\\r}
  s=\${s//$'\\t'/\\\\t}
  printf '%s' "$s"
}

json_string() {
  printf '"%s"' "$(json_escape "$1")"
}

# Prints a JSON-safe rendering of a number, or fails: a bare "1." or "1e" is
# not JSON and must not reach the block.
json_number() {
  local v="$1"
  [[ "$v" =~ ^[+-]?([0-9]+([.][0-9]*)?|[.][0-9]+)([eE][+-]?[0-9]+)?$ ]] || return 1
  awk -v v="$v" 'BEGIN { printf "%.12g", v + 0 }'
}

now_ms() {
  local ns
  if [[ -n "\${EPOCHREALTIME:-}" ]]; then
    ns="\${EPOCHREALTIME//[.,]/}"
    printf '%s' $(( ns / 1000 ))
    return 0
  fi
  ns=$(date +%s%N 2>/dev/null || true)
  if [[ "$ns" =~ ^[0-9]{15,}$ ]]; then
    printf '%s' $(( ns / 1000000 ))
    return 0
  fi
  # Whole-second clock: the caller omits a zero delta rather than claim 0 ms.
  printf '%s' $(( $(date +%s) * 1000 ))
}

# Is this pid this script or one of its descendants? Called while no bench
# process is running, so anything else on the card is a foreign process.
is_own_process() {
  local p="$1" hops=0
  while [[ "$p" =~ ^[0-9]+$ ]] && [[ "$p" -gt 1 ]] && [[ $hops -lt 64 ]]; do
    [[ "$p" == "$$" ]] && return 0
    p=$(ps -o ppid= -p "$p" 2>/dev/null | tr -d '[:space:]' || true)
    hops=$(( hops + 1 ))
  done
  return 1
}

foreign_mib() {
  local first="$1" apps line pid mem total=0
  if [[ -n "$first" ]]; then
    apps=$(nvidia-smi -i "$first" --query-compute-apps=pid,used_memory --format=csv,noheader,nounits 2>/dev/null || true)
  else
    apps=$(nvidia-smi --query-compute-apps=pid,used_memory --format=csv,noheader,nounits 2>/dev/null || true)
  fi
  [[ -n "$apps" ]] || { printf '0'; return 0; }
  while IFS= read -r line; do
    [[ -n "$line" ]] || continue
    pid="\${line%%,*}"
    mem="\${line#*,}"
    pid=$(printf '%s' "$pid" | tr -d '[:space:]')
    mem=$(printf '%s' "$mem" | tr -d '[:space:]')
    [[ "$mem" =~ ^[0-9]+$ ]] || continue
    if is_own_process "$pid"; then continue; fi
    total=$(( total + mem ))
  done <<< "$apps"
  printf '%s' "$total"
}

# Sets the GPU_* globals and the sample for this phase. Never fails: a reading
# without GPU state still records the measurement, and says why it is missing.
gpu_probe() {
  local phase="$1" missing='' first='' row=''
  if ! command -v nvidia-smi >/dev/null 2>&1; then
    missing='nvidia-smi is not on PATH'
  else
    if [[ -n "\${CUDA_VISIBLE_DEVICES:-}" ]]; then
      first="\${CUDA_VISIBLE_DEVICES%%,*}"
    fi
    if [[ -n "$first" && "$first" =~ ^[0-9]+$ ]]; then
      row=$(nvidia-smi -i "$first" --query-gpu=index,name,clocks.sm,clocks.mem,utilization.gpu --format=csv,noheader,nounits 2>/dev/null | head -1 || true)
    else
      row=$(nvidia-smi --query-gpu=index,name,clocks.sm,clocks.mem,utilization.gpu --format=csv,noheader,nounits 2>/dev/null | head -1 || true)
    fi
    [[ -n "$row" ]] || missing='nvidia-smi returned no GPU state'
  fi

  if [[ -n "$missing" ]]; then
    GPU_AVAILABLE=0
    [[ -n "$GPU_ERROR" ]] || GPU_ERROR="$missing"
    if [[ "$phase" == 'start' ]]; then GPU_SAMPLE_START=''; else GPU_SAMPLE_END=''; fi
    return 0
  fi

  local idx name csm cmem util cmax foreign body sep n
  idx=$(printf '%s\\n' "$row" | awk -F',' '{ v=$1; gsub(/[[:space:]]/,"",v); print v }')
  name=$(printf '%s\\n' "$row" | awk -F',' '{ v=$2; for (i=3; i<=NF-3; i++) v=v","$i; sub(/^[[:space:]]+/,"",v); sub(/[[:space:]]+$/,"",v); print v }')
  csm=$(printf '%s\\n' "$row" | awk -F',' '{ v=$(NF-2); gsub(/[[:space:]]/,"",v); print v }')
  cmem=$(printf '%s\\n' "$row" | awk -F',' '{ v=$(NF-1); gsub(/[[:space:]]/,"",v); print v }')
  util=$(printf '%s\\n' "$row" | awk -F',' '{ v=$NF; gsub(/[[:space:]]/,"",v); print v }')
  # A separate, best-effort query: a driver that does not know clocks.max.sm must
  # not cost the whole sample, so its absence is a missing field, not an error.
  cmax=''
  if [[ -n "$first" && "$first" =~ ^[0-9]+$ ]]; then
    cmax=$(nvidia-smi -i "$first" --query-gpu=clocks.max.sm --format=csv,noheader,nounits 2>/dev/null | head -1 | tr -d '[:space:]' || true)
  else
    cmax=$(nvidia-smi --query-gpu=clocks.max.sm --format=csv,noheader,nounits 2>/dev/null | head -1 | tr -d '[:space:]' || true)
  fi
  foreign=$(foreign_mib "$first")

  GPU_AVAILABLE=1
  if [[ "$phase" == 'start' ]]; then
    if [[ -z "$GPU_NAME" ]]; then GPU_NAME="$name"; fi
    if [[ -z "$GPU_INDEX" ]]; then GPU_INDEX="$idx"; fi
  fi

  body=''
  sep=''
  if n=$(json_number "$csm"); then body="\${body}\${sep}\\"clocksSmMhz\\":\${n}"; sep=\',\'; fi
  if n=$(json_number "$cmem"); then body="\${body}\${sep}\\"clocksMemMhz\\":\${n}"; sep=\',\'; fi
  if n=$(json_number "$util"); then body="\${body}\${sep}\\"utilPct\\":\${n}"; sep=\',\'; fi
  if [[ "$foreign" =~ ^[0-9]+$ ]]; then body="\${body}\${sep}\\"foreignProcessMiB\\":\${foreign}"; sep=\',\'; fi
  if n=$(json_number "$cmax"); then body="\${body}\${sep}\\"clocksMaxSmMhz\\":\${n}"; sep=\',\'; fi

  case "$phase" in
    start)  GPU_SAMPLE_START="{\${body}}" ;;
    loaded) GPU_SAMPLE_LOADED="{\${body}}" ;;
    *)      GPU_SAMPLE_END="{\${body}}" ;;
  esac
  if [[ "$phase" == "loaded" ]]; then
    GPU_LOADED_SM="$csm"
    GPU_LOADED_MAX="$cmax"
    GPU_LOADED_UTIL="$util"
  fi
  return 0
}

smi_version() {
  command -v nvidia-smi >/dev/null 2>&1 || return 0
  NVIDIA_SMI_VERSION=$(nvidia-smi --version 2>/dev/null | head -1 | sed 's/[[:space:]]*$//' || true)
}

median_of() {
  [[ $# -gt 0 ]] || return 1
  printf '%s\\n' "$@" | sort -g | awk '{ a[NR]=$1 } END { if (NR==0) exit 1; if (NR%2) print a[(NR+1)/2]; else printf "%.10g\\n", (a[NR/2]+a[NR/2+1])/2 }'
}

# Median of the numbers one window collected, so there is one median in the file.
file_median() {
  local v
  local -a vals=()
  [[ -s "$1" ]] || return 1
  while IFS= read -r v; do
    [[ -n "$v" ]] || continue
    vals+=("$v")
  done < "$1"
  [[ \${#vals[@]} -gt 0 ]] || return 1
  median_of \${vals[@]+"\${vals[@]}"}
}

mean_of() {
  [[ $# -gt 0 ]] || return 1
  printf '%s\\n' "$@" | awk '{ s+=$1; n++ } END { if (n==0) exit 1; printf "%.10g\\n", s/n }'
}

geomean_file() {
  [[ -s "$1" ]] || return 1
  awk '{ if ($1 <= 0) bad=1; s+=log($1); n++ } END { if (bad || n==0) exit 1; printf "%.10g\\n", exp(s/n) }' "$1"
}

# One pair's ratio: ref/kernel when lower is better, kernel/ref when higher, so
# the number means the same thing as geomean_speedup — above 1 the kernel wins.
pair_ratio() {
  [[ $# -eq 2 ]] || return 1
  awk -v r="$1" -v k="$2" -v d="$DIRECTION" 'BEGIN { if (r <= 0 || k <= 0) exit 1; if (d == "lower") printf "%.10g\\n", r/k; else printf "%.10g\\n", k/r }'
}

# The first window of a job reads 3-5% fast (a cold boost) and later windows
# drift thermally, so the opening window must not land on one side of the pair.
# Burn in with the kernel under test until the clock has moved on: at least one
# run, at most BURN_IN_MAX_RUNS, and the numbers are thrown away.
burn_in() {
  local cid="$1" gname="$2" start runs now
  # 0 means no burn-in: the loop body would otherwise run once before the
  # deadline check, and "off" must not cost a run.
  [[ $BURN_IN_MS -le 0 ]] && return 0
  start=$(now_ms)
  runs=0
  while [[ $runs -lt $BURN_IN_MAX_RUNS ]]; do
    if ! eval "$BENCH_CMD" >/dev/null 2>&1; then
      WARNINGS+=("burn-in run $((runs+1)) failed in cell $cid group $gname; the measured windows decide on their own")
      break
    fi
    runs=$(( runs + 1 ))
    now=$(now_ms)
    [[ $(( now - start )) -ge $BURN_IN_MS ]] && break
  done
  # A cap that binds before the deadline means the bench is faster than 2000 runs
  # per burn-in: the windows may still carry a cold-start bias, and that is said.
  if [[ $(( now - start )) -lt $BURN_IN_MS ]]; then
    WARNINGS+=("burn-in stopped at the ${BURN_IN_MAX_RUNS}-run cap after $(( now - start )) ms of the \${BURN_IN_MS} ms wanted in cell $cid group $gname; the first window may still read fast")
  fi
  return 0
}

# One measured window: WARMUP untimed runs, then REPEATS timed runs, then the
# median of what they printed, left in the variable named by the last argument.
# The median is returned by name, not on stdout: a command substitution would run
# the window in a subshell and the device/enqueue figures it collects (they belong
# to this shell) would vanish with it. role is kernel for the side the reading's
# device and enqueue figures belong to: the reference's numbers must not enter
# the host-bound ratio, which is a claim about the kernel under test.
measure_window() {
  local cmd="$1" out="$2" role="$3" cid="$4" gname="$5" outvar="$6"
  local raw value reported median w r
  for ((w=0; w<WARMUP; w++)); do
    if ! eval "$cmd" >/dev/null 2>&1; then
      echo "benchmark failed during warmup in cell $cid group $gname (warmup $((w+1))/$WARMUP)" >&2
      return 1
    fi
  done
  : > "$out"
  for ((r=0; r<REPEATS; r++)); do
    if ! raw=$(eval "$cmd" 2>&1); then
      echo "benchmark failed in cell $cid group $gname:" >&2
      printf '%s\\n' "$raw" >&2
      return 1
    fi
    if [[ $raw =~ METRIC[[:space:]]+[A-Za-z0-9_.]+=([0-9.eE+-]+) ]]; then
      value="\${BASH_REMATCH[1]}"
    else
      value=$(printf '%s\\n' "$raw" | grep -oE '[-+]?[0-9]*\\.?[0-9]+([eE][-+]?[0-9]+)?' | tail -1 || true)
    fi
    if [[ -z "\${value:-}" ]]; then
      echo "benchmark in cell $cid group $gname printed no number" >&2
      printf '%s\\n' "$raw" >&2
      return 1
    fi
    printf '%s\\n' "$value" >> "$out"

    # Only the task can say how long the device ran and how long the host took
    # to enqueue; take its numbers as reported and median them over the run.
    if [[ "$role" == 'kernel' ]]; then
      reported=$(printf '%s\\n' "$raw" | grep -oE 'METRIC[[:space:]]+[A-Za-z0-9_.]+=[0-9.eE+-]+' || true)
      while IFS=' ' read -r tag pair; do
        [[ "$tag" == 'METRIC' ]] || continue
        case "\${pair%%=*}" in
          host_enqueue_ms) HOST_ENQUEUE_VALUES+=("\${pair#*=}") ;;
          device_ms) DEVICE_VALUES+=("\${pair#*=}") ;;
        esac
      done <<< "$reported"
    fi
  done
  median=$(file_median "$out") || return 1
  printf -v "$outvar" '%s' "$median"
}

emit_reading() {
  local finished end_ms delta shell_ms host_json device_json ratio_json verdict reason
  local gpu_json cells_json warnings_json tail_json pairing_json ratios r sep2 item sep w n

  finished=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  gpu_probe 'end'

  shell_ms=''
  if [[ -n "$START_MS" ]]; then
    end_ms=$(now_ms)
    delta=$(( end_ms - START_MS ))
    if [[ $delta -gt 0 ]]; then
      shell_ms=$(json_number "$delta" || true)
    else
      WARNINGS+=('the shell clock could not resolve the run; shellMs is omitted rather than recorded as 0')
    fi
  fi

  # host and device figures come from one place only: the task's own output.
  local host='' device=''
  host=$(median_of \${HOST_ENQUEUE_VALUES[@]+"\${HOST_ENQUEUE_VALUES[@]}"} || true)
  device=$(median_of \${DEVICE_VALUES[@]+"\${DEVICE_VALUES[@]}"} || true)
  host_json=''
  device_json=''
  if [[ -n "$host" ]] && host_json=$(json_number "$host"); then :; else host_json=''; fi
  if [[ -n "$device" ]] && device_json=$(json_number "$device"); then :; else device_json=''; fi

  ratio_json='null'
  verdict='unmeasured'
  reason=''
  if [[ -n "$host_json" && -n "$device_json" ]]; then
    ratio_json=$(awk -v h="$host_json" -v d="$device_json" 'BEGIN { if (d <= 0) exit 1; printf "%.12g", h / d }' || true)
    if [[ -n "$ratio_json" ]]; then
      verdict=$(awk -v r="$ratio_json" 'BEGIN { print (r >= 0.5) ? "host_bound" : "ok" }')
    else
      ratio_json='null'
      reason='the task reported device_ms <= 0, so an enqueue/device ratio is undefined'
    fi
  elif [[ -n "$device_json" ]]; then
    reason='the task reported device_ms but no host_enqueue_ms; the host share is unmeasured'
  elif [[ -n "$host_json" ]]; then
    reason='the task reported host_enqueue_ms but no device_ms; shell wall time is not the same origin and cannot form a ratio'
  else
    reason='the task reported neither device_ms nor host_enqueue_ms; shellMs is not device time'
  fi

  cells_json=''
  sep=''
  for item in \${CELL_JSON[@]+"\${CELL_JSON[@]}"}; do
    cells_json="\${cells_json}\${sep}\${item}"
    sep=','
  done

  if [[ -z "$GPU_AVAILABLE" ]]; then gpu_probe 'start'; fi
  if [[ "$GPU_AVAILABLE" == '0' ]]; then
    gpu_json="{\\"available\\":false,\\"error\\":$(json_string "\${GPU_ERROR:-nvidia-smi unavailable}")}"
    WARNINGS+=("no GPU state in this reading: \${GPU_ERROR:-nvidia-smi unavailable}")
  else
    gpu_json='{"available":true'
    if [[ -n "$GPU_NAME" ]]; then gpu_json="\${gpu_json},\\"name\\":$(json_string "$GPU_NAME")"; fi
    if [[ -n "$GPU_INDEX" ]] && w=$(json_number "$GPU_INDEX"); then gpu_json="\${gpu_json},\\"index\\":\${w}"; fi
    if [[ -n "$VISIBLE" ]]; then gpu_json="\${gpu_json},\\"visible\\":$(json_string "$VISIBLE")"; fi
    if [[ -n "$GPU_SAMPLE_START" ]]; then gpu_json="\${gpu_json},\\"start\\":\${GPU_SAMPLE_START}"; fi
    if [[ -n "$GPU_SAMPLE_LOADED" ]]; then gpu_json="\${gpu_json},\\"loaded\\":\${GPU_SAMPLE_LOADED}"; fi
    if [[ -n "$GPU_SAMPLE_END" ]]; then gpu_json="\${gpu_json},\\"end\\":\${GPU_SAMPLE_END}"; fi
    gpu_json="\${gpu_json}}"
    if [[ -z "$VISIBLE" ]]; then
      WARNINGS+=('CUDA_VISIBLE_DEVICES is unset: the card is whatever nvidia-smi reports first, not a claimed card')
    fi
    if [[ "$GPU_SAMPLE_START" == *'"foreignProcessMiB":0'* && "$GPU_SAMPLE_END" == *'"foreignProcessMiB":0'* ]]; then
      :
    elif [[ "$GPU_SAMPLE_START" == *foreignProcessMiB* || "$GPU_SAMPLE_END" == *foreignProcessMiB* ]]; then
      WARNINGS+=('another process held memory on this card during the run; the reading is contended')
    fi
  fi

  if [[ -z "$shell_ms" && "$verdict" != 'unmeasured' ]]; then
    WARNINGS+=("hostBoundRatio is computed from task-reported numbers only; it does not compare shellMs")
  fi

  tail_json=''
  if [[ -n "$shell_ms" ]]; then tail_json="\${tail_json},\\"shellMs\\":\${shell_ms}"; fi
  if [[ -n "$host_json" ]]; then tail_json="\${tail_json},\\"hostEnqueueMs\\":\${host_json}"; fi
  if [[ -n "$device_json" ]]; then tail_json="\${tail_json},\\"deviceMs\\":\${device_json}"; fi

  # The pairing claims. pairing is always written — absent says the contract
  # named no reference and the cross-run baseline is all this reading has. The
  # ratios and the spread appear only when a pair was actually taken, so a
  # reader never sees an empty array standing in for a measurement.
  pairing_json=",\\"pairing\\":$(json_string "$PAIRING_STATE")"
  if [[ \${#PAIR_RATIOS[@]} -gt 0 ]]; then
    ratios=''
    sep2=''
    for r in "\${PAIR_RATIOS[@]}"; do
      if n=$(json_number "$r"); then ratios="\${ratios}\${sep2}\${n}"; sep2=','; fi
    done
    if [[ -n "$ratios" ]]; then pairing_json="\${pairing_json},\\"pairRatios\\":[\${ratios}]"; fi
  fi
  if [[ -n "$PAIR_SPREAD_PCT" ]]; then
    if n=$(json_number "$PAIR_SPREAD_PCT"); then pairing_json="\${pairing_json},\\"pairSpreadPct\\":\${n}"; fi
  fi

  # Clock lock: a declared lock is recorded with what the loaded sample observed.
  # held is null when no lock was declared — an undeclared lock is invisible to
  # nvidia-smi, and claiming otherwise would be a fabricated pass.
  lock_json=\'\'
  if [[ "$CLOCK_LOCK_DECLARED" == \'1\' ]]; then
    lock_json="\\"clockLocked\\":{\\"declaredSmMhz\\":\${CLOCK_LOCK_SM}"
    if [[ -n "$CLOCK_LOCK_MEM" ]]; then lock_json="\${lock_json},\\"declaredMemMhz\\":\${CLOCK_LOCK_MEM}"; fi
    if [[ -n "$GPU_LOADED_SM" ]]; then
      observed="$GPU_LOADED_SM"
      lock_json="\${lock_json},\\"observedSmMhz\\":\${observed}"
      if awk -v o="$observed" -v d="$CLOCK_LOCK_SM" \'BEGIN { exit (o < d - 50 || o > d + 50) ? 1 : 0 }\'; then
        lock_json="\${lock_json},\\"held\\":true"
      else
        lock_json="\${lock_json},\\"held\\":false"
        WARNINGS+=("clock lock declared at \${CLOCK_LOCK_SM} MHz but the loaded sample read \${observed} MHz: the lock did not hold, so this reading\'s clocks are not the ones the contract names")
      fi
    fi
    lock_json="\${lock_json}}"
  fi

  # A busy card that sits far below its own max clock is either locked or capped.
  # Unnamed, it looks like ordinary load and the number is read as if unlocked.
  if [[ "$CLOCK_LOCK_DECLARED" != \'1\' && -n "$GPU_SAMPLE_LOADED" ]]; then
    loaded_sm="$GPU_LOADED_SM"
    loaded_max="$GPU_LOADED_MAX"
    loaded_util="$GPU_LOADED_UTIL"
    if [[ -n "$loaded_sm" && -n "$loaded_max" && -n "$loaded_util" ]] && awk -v u="$loaded_util" 'BEGIN { exit (u >= 50) ? 0 : 1 }'; then
      if awk -v o="$loaded_sm" -v m="$loaded_max" 'BEGIN { exit (o < 0.9 * m) ? 0 : 1 }'; then
        WARNINGS+=("the card was busy ($loaded_util %) at $loaded_sm MHz of its $loaded_max MHz max: a clock lock or a power/thermal cap is in force, and this reading's clocks are not the card's free-running ones")
      fi
    fi
  fi

  warnings_json=''
  sep=''
  for w in \${WARNINGS[@]+"\${WARNINGS[@]}"}; do
    warnings_json="\${warnings_json}\${sep}$(json_string "$w")"
    sep=','
  done

  printf '%s\\n' "$READING_START"
  printf '{"schemaVersion":1,"contractSha":%s,"basis":%s,"basisSource":%s,"gpu":%s,"cells":[%s]%s,"hostBoundRatio":%s,"hostBoundVerdict":%s' \\
    "$(json_string "$CONTRACT_SHA")" \\
    "$(json_string "$BASIS")" \\
    "$(json_string "$BASIS_SOURCE")" \\
    "$gpu_json" \\
    "$cells_json" \\
    "$tail_json" \\
    "$ratio_json" \\
    "$(json_string "$verdict")"
  if [[ -n "$reason" ]]; then printf ',"hostBoundReason":%s' "$(json_string "$reason")"; fi
  printf '%s' "$pairing_json"
  printf ',"startedAt":%s,"finishedAt":%s' "$(json_string "$STARTED_AT")" "$(json_string "$finished")"
  if [[ -n "$lock_json" ]]; then printf ',%s' "$lock_json"; fi
  printf ',"hostEnqueueSamples":%s,"deviceSamples":%s' "$HOST_ENQUEUE_SAMPLES" "$DEVICE_SAMPLES"
  if [[ -n "$NVIDIA_SMI_VERSION" ]]; then printf ',"nvidiaSmi":%s' "$(json_string "$NVIDIA_SMI_VERSION")"; fi
  printf ',"warnings":[%s]}\\n' "$warnings_json"
  printf '%s\\n' "$READING_END"
  return 0
}

# --- run -------------------------------------------------------------------

[[ -f kernel.contract.json ]] || { echo "kernel.contract.json is missing; run kernel_contract" >&2; exit 2; }
actual=$(hash_file kernel.contract.json) || exit 2
[[ "$actual" == "$CONTRACT_SHA" ]] || {
  echo "kernel.contract.json changed (expected $CONTRACT_SHA, got $actual); regenerate with kernel_contract" >&2
  exit 2
}

RESET=0
[[ "\${1:-}" == "--reset-baseline" ]] && RESET=1

baseline_run=0
if [[ $RESET -eq 1 || ! -f "$BASELINE_FILE" ]]; then
  baseline_run=1
fi

mkdir -p "$(dirname "$BASELINE_FILE")"
tmp=$(mktemp)
group_tmp=$(mktemp)
ratio_file=$(mktemp)
# The windows of the pair: one group's numbers each, and one file per cell and
# side so the cell aggregate is a geomean over its groups like every other one.
pair_win=$(mktemp)
ref1_cell=$(mktemp)
ref2_cell=$(mktemp)
k1_cell=$(mktemp)
k2_cell=$(mktemp)
trap 'rm -f "$tmp" "$group_tmp" "$ratio_file" "$pair_win" "$ref1_cell" "$ref2_cell" "$k1_cell" "$k2_cell"' EXIT
failures=0
new_baseline=()

# Median of the last window, by name: measure_window leaves it here.
W_MEDIAN=''

BASIS_SOURCE='shell-wall'
VISIBLE="\${CUDA_VISIBLE_DEVICES:-}"
STARTED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
START_MS=$(now_ms)
smi_version
gpu_probe 'start'

for entry in "\${CELLS[@]}"; do
${EXPORTS}
  safe=$(printf '%s' "$cid" | tr -c 'A-Za-z0-9' '_')
  select_groups "$cid"
  : > "$group_tmp"
  # A cell that loses one reference window loses its whole pair: an average over
  # one side would be a fabricated reading, so the kernel metrics stand alone.
  cell_ref_failed=0
  : > "$ref1_cell"
  : > "$ref2_cell"
  : > "$k1_cell"
  : > "$k2_cell"

  # Cells x groups: one measurement per data set. KERNEL_GROUP is exported per
  # group so the command can build that data set itself.
  for gname in "\${G_NAMES[@]}"; do
    gseed="\${G_SEEDS[$G_INDEX]}"
    gintent="\${G_INTENTS[$G_INDEX]}"
    G_INDEX=$(( G_INDEX + 1 ))
    gsafe=$(printf '%s' "$gname" | tr -c 'A-Za-z0-9' '_')
${GROUP_EXPORTS}

    # How many runs informed this group's number: one window normally, two when
    # a reference rides the run (the mean of the two kernel windows).
    gsamples=$REPEATS
    if [[ "$PAIRING_ENABLED" != '1' ]]; then
      # No reference in this contract: one window, exactly as before.
      measure_window "$BENCH_CMD" "$tmp" 'kernel' "$cid" "$gname" W_MEDIAN || exit 1
      gmedian="$W_MEDIAN"
    else
      gsamples=$(( REPEATS * 2 ))
      if [[ "$BURN_IN_DONE" == '0' ]]; then
        burn_in "$cid" "$gname"
        BURN_IN_DONE=1
      fi

      # ref, kernel, kernel, ref — four windows, in that order, per cell x group.
      ref1=''
      ref2=''
      if [[ "$cell_ref_failed" == '0' ]]; then
        if measure_window "$REF_CMD" "$pair_win" 'ref' "$cid" "$gname" W_MEDIAN; then
          ref1="$W_MEDIAN"
        else
          cell_ref_failed=1
          WARNINGS+=("reference window 1 failed in cell $cid group $gname; cell $cid takes no paired ratio")
        fi
      fi
      measure_window "$BENCH_CMD" "$tmp" 'kernel' "$cid" "$gname" W_MEDIAN || exit 1
      k1="$W_MEDIAN"
      measure_window "$BENCH_CMD" "$pair_win" 'kernel' "$cid" "$gname" W_MEDIAN || exit 1
      k2="$W_MEDIAN"
      # Both kernel windows count as this group's samples.
      cat "$pair_win" >> "$tmp"
      if [[ "$cell_ref_failed" == '0' ]]; then
        if measure_window "$REF_CMD" "$pair_win" 'ref' "$cid" "$gname" W_MEDIAN; then
          ref2="$W_MEDIAN"
        else
          cell_ref_failed=1
          WARNINGS+=("reference window 2 failed in cell $cid group $gname; no half pair is taken for cell $cid")
        fi
      fi

      # Each side keeps the mean of its two window medians (the kernel's mean is
      # what this cell reports; the reference's feeds the ratio).
      gmedian=$(mean_of "$k1" "$k2") || exit 1
      if [[ "$cell_ref_failed" == '0' ]]; then
        printf '%s\\n' "$ref1" >> "$ref1_cell"
        printf '%s\\n' "$ref2" >> "$ref2_cell"
        printf '%s\\n' "$k1" >> "$k1_cell"
        printf '%s\\n' "$k2" >> "$k2_cell"
      fi
    fi
    printf 'METRIC %s_%s_%s=%s\\n' "$METRIC_NAME" "$safe" "$gsafe" "$gmedian"

    gspread=''
    if [[ $REPEATS -ge 2 ]]; then
      gspread=$(awk -v m="$gmedian" 'NR==1 { lo=$1; hi=$1 } { if ($1<lo) lo=$1; if ($1>hi) hi=$1 } END { if (m > 0 && NR > 0) printf "%.12g", (hi-lo)/m*100 }' "$tmp")
    fi
    gmedian_json=$(json_number "$gmedian" || true)
    if [[ -z "$gmedian_json" ]]; then
      WARNINGS+=("cell $cid group $gname has no JSON-safe median (raw: $gmedian); the group is missing from this reading")
    else
      cell_json="{\\"id\\":$(json_string "$cid"),\\"group\\":$(json_string "$gname"),\\"metric\\":$(json_string "\${METRIC_NAME}_\${safe}_\${gsafe}"),\\"median\\":\${gmedian_json},\\"samples\\":\${gsamples}"
      if [[ -n "$gspread" ]] && spread_json=$(json_number "$gspread"); then
        cell_json="\${cell_json},\\"spreadPct\\":\${spread_json}"
      fi
      CELL_JSON+=("\${cell_json}}")
    fi
    printf '%s\\n' "$gmedian" >> "$group_tmp"
  done

  # The number the gate reads: the geomean over this cell's groups, so one group
  # getting much slower moves the cell instead of hiding behind a median (three
  # groups at 10/10/100 read as 21.5, not as 10). It is still the name
  # cellMetricName returns. A non-positive group value has no geomean, so the
  # cell refuses to produce one rather than round it to zero.
  cell_value=$(geomean_file "$group_tmp") || {
    echo "cell $cid has a non-positive group value; a geomean cannot be taken over $(tr '\\n' ' ' < "$group_tmp")" >&2
    exit 1
  }
  printf 'METRIC %s_%s=%s\\n' "$METRIC_NAME" "$safe" "$cell_value"

  # Two ratios per cell, one per pair: ref1/k1 and ref2/k2 (inverted when higher
  # is better). The aggregates over the cell's groups go in first, so a ratio is
  # a cell-level number like geomean_speedup, not a lucky group's.
  if [[ "$PAIRING_ENABLED" == '1' ]]; then
    if [[ "$cell_ref_failed" == '1' ]]; then
      PAIR_FAILED_CELLS=$(( PAIR_FAILED_CELLS + 1 ))
    else
      ref1c=$(geomean_file "$ref1_cell" || true)
      ref2c=$(geomean_file "$ref2_cell" || true)
      k1c=$(geomean_file "$k1_cell" || true)
      k2c=$(geomean_file "$k2_cell" || true)
      r1=''
      r2=''
      if [[ -n "$ref1c" && -n "$k1c" && -n "$ref2c" && -n "$k2c" ]]; then
        r1=$(pair_ratio "$ref1c" "$k1c" || true)
        r2=$(pair_ratio "$ref2c" "$k2c" || true)
      fi
      if [[ -z "$r1" || -z "$r2" ]]; then
        PAIR_FAILED_CELLS=$(( PAIR_FAILED_CELLS + 1 ))
        WARNINGS+=("cell $cid has no paired ratio: a reference or kernel aggregate was not positive")
      else
        PAIR_RATIOS+=("$r1" "$r2")
        # Spread relative to the mid-point of the two ratios, not to the smaller
        # one: the mean is symmetric in the two draws and does not blow the
        # percentage up when the faster ratio happens to be the denominator.
        # (ForgeKernel divides by the min; that is stricter by at most a factor
        # of two at a disagreement where both already refuse the pair.)
        spread=$(awk -v a="$r1" -v b="$r2" 'BEGIN { m=(a+b)/2; if (m <= 0) exit 1; d=(a>b)?a-b:b-a; printf "%.10g", d/m*100 }' || true)
        if [[ -n "$spread" ]]; then
          PAIR_SPREAD_PCT=$(awk -v cur="\${PAIR_SPREAD_PCT:-0}" -v s="$spread" 'BEGIN { printf "%.10g", (s>cur)?s:cur }')
          if awk -v s="$spread" -v lim="$PAIR_SPREAD_MAX_PCT" 'BEGIN { exit (s > lim) ? 0 : 1 }'; then
            WARNINGS+=("cell $cid's two paired ratios ($r1, $r2) spread \${spread}% (> \${PAIR_SPREAD_MAX_PCT}%): they represent no single period, so the pair is inadmissible")
          fi
        fi
      fi
    fi
  fi

  if [[ $baseline_run -eq 1 ]]; then
    new_baseline+=("$cid|$cell_value")
    continue
  fi

  base=$(awk -F'\\t' -v c="$cid" '$1==c {print $3}' "$BASELINE_FILE" | head -1)
  if [[ -z "$base" ]]; then
    echo "baseline has no value for cell $cid; rerun with --reset-baseline" >&2
    exit 1
  fi
  ratio=$(awk -v b="$base" -v c="$cell_value" -v d="$DIRECTION" 'BEGIN { if (c<=0 || b<=0) exit 1; if (d=="lower") printf "%.10g\\n", b/c; else printf "%.10g\\n", c/b }')
  printf '%s\\n' "$ratio" >> "$ratio_file"
  if awk -v r="$ratio" -v g="$GUARD_PCT" 'BEGIN { exit (r < 1 - g/100) ? 1 : 0 }'; then
    :
  else
    echo "guard: cell $cid regressed (ratio $ratio < 1 - $GUARD_PCT/100)" >&2
    failures=$((failures+1))
  fi
done

# Sampled after the last measured window: start is taken before any work and
# therefore always shows the parked clock, so the block needs one sample taken
# while the card was busy to say what it actually ran at.
gpu_probe 'loaded'

if [[ \${#DEVICE_VALUES[@]} -gt 0 || \${#HOST_ENQUEUE_VALUES[@]} -gt 0 ]]; then
  BASIS_SOURCE='task-reported'
fi
HOST_ENQUEUE_SAMPLES=$(printf '%s' "\${#HOST_ENQUEUE_VALUES[@]}")
DEVICE_SAMPLES=$(printf '%s' "\${#DEVICE_VALUES[@]}")

# --- pairing admission ------------------------------------------------------
# mirrored only when every cell mirrored and gave two ratios that agree inside
# the band. Otherwise the block says inadmissible and names why: a pair that
# decides nothing must not print a speedup a reader could quote. The cross-run
# geomean_speedup and the guard below are untouched by any of this.
if [[ "$PAIRING_ENABLED" == '1' ]]; then
  pair_count=\${#PAIR_RATIOS[@]}
  pair_reason=''
  if [[ "$PAIR_FAILED_CELLS" -gt 0 ]]; then
    pair_reason="$PAIR_FAILED_CELLS cell(s) lost a reference window"
  elif [[ "$pair_count" -lt "$PAIR_MIN_RATIOS" ]]; then
    pair_reason="$pair_count usable paired ratio(s), at least $PAIR_MIN_RATIOS are needed"
  elif awk -v s="\${PAIR_SPREAD_PCT:-0}" -v lim="$PAIR_SPREAD_MAX_PCT" 'BEGIN { exit (s > lim) ? 0 : 1 }'; then
    pair_reason="the two ratios spread \${PAIR_SPREAD_PCT}% (> \${PAIR_SPREAD_MAX_PCT}%)"
  fi
  if [[ -z "$pair_reason" ]]; then
    PAIRING_STATE='mirrored'
    paired=$(printf '%s\\n' "\${PAIR_RATIOS[@]}" | awk '{ s+=log($1); n++ } END { if (n==0) exit 1; printf "%.10g\\n", exp(s/n) }')
    printf 'METRIC paired_speedup=%s\\n' "$paired"
  else
    PAIRING_STATE='inadmissible'
    case "$pair_reason" in
      *spread*) ;; # the cell-level warning already names the spread and its numbers
      *) WARNINGS+=("pairing is inadmissible: $pair_reason") ;;
    esac
  fi
fi

if [[ $baseline_run -eq 1 ]]; then
  {
    printf '# cell\\tmetric\\tvalue\\tdirection\\n'
    for item in "\${new_baseline[@]}"; do
      printf '%s\\t%s\\t%s\\t%s\\n' "\${item%%|*}" "$METRIC_NAME" "\${item#*|}" "$DIRECTION"
    done
  } > "$BASELINE_FILE"
  printf 'METRIC geomean_speedup=1\\n'
  echo "baseline recorded in $BASELINE_FILE"
  WARNINGS+=('baseline run: geomean_speedup is 1 by construction, not a comparison')
  emit_reading
  exit 0
fi

geomean=$(awk '{ s+=log($1); n++ } END { if (n==0) exit 1; printf "%.10g\\n", exp(s/n) }' "$ratio_file")
printf 'METRIC geomean_speedup=%s\\n' "$geomean"
emit_reading
[[ $failures -eq 0 ]] || {
  echo "guard failed: $failures cell(s) regressed beyond \${GUARD_PCT}%" >&2
  exit 1
}
`;
}

export function renderChecksScript(contract: KernelContract, sha: string): string {
  return `#!/usr/bin/env bash
# Generated by ${contract.generator}. Do not edit: regenerate with kernel_contract.
# Contract: kernel.contract.json (sha256 ${sha})
#
# Two modes, one artifact:
#
#   bash goal.checks.sh               every cell x group, two passes. Each pass may
#                                    print max_diff=<number>; the worst of the two
#                                    becomes one row of .kernel/precision.tsv.
#   bash goal.checks.sh --calibrate   the REFERENCE measured against itself, once
#                                    per dtype, into .kernel/calibration.json.
#
# The calibration rides this script instead of a third generated file because it
# needs exactly what the checks already have — the cell table, the per-cell
# exports, the dtype per cell, and the contract-sha guard. A separate
# goal.calibrate.sh would be a second protected artifact that pi-goal's sealed
# set, DEFAULT_HARNESS_GLOBS and every contract written before it do not know
# about, and the two scripts would drift.
set -euo pipefail

CONTRACT_SHA=${shQuote(sha)}
CHECK_CMD=${shQuote(contract.checkCommand)}
# Empty when the contract names no calibration; --calibrate then refuses by name.
CALIBRATE_CMD=${shQuote(contract.calibrateCommand ?? "")}
PRECISION_FILE='.kernel/precision.tsv'
CALIBRATION_FILE='.kernel/calibration.json'
# The number a check prints for the precision gate; the last one on its output wins.
MAX_DIFF_RE='max_diff=[-+]?[0-9]*\\.?[0-9]+([eE][-+]?[0-9]+)?'
# JSON has no ".5" and no "1."; a value that fails this is recorded as null.
JSON_NUMBER_RE='^-?(0|[1-9][0-9]*)([.][0-9]+)?([eE][-+]?[0-9]+)?$'
# The cell table: one row per cell, one row per group (see kernel_contract).
CELLS=(${cellsArray(contract)})
${groupSelect(contract)}

${HASH_FUNCTION}

json_escape() {
  local s="$1"
  s=\${s//\\\\/\\\\\\\\}
  s=\${s//\\"/\\\\\\"}
  s=\${s//$'\\n'/\\\\n}
  s=\${s//$'\\r'/\\\\r}
  s=\${s//$'\\t'/\\\\t}
  printf '%s' "$s"
}

[[ -f kernel.contract.json ]] || { echo "kernel.contract.json is missing; run kernel_contract" >&2; exit 2; }
actual=$(hash_file kernel.contract.json) || exit 2
[[ "$actual" == "$CONTRACT_SHA" ]] || {
  echo "kernel.contract.json changed (expected $CONTRACT_SHA, got $actual); regenerate with kernel_contract" >&2
  exit 2
}

# --- calibration: the reference's own error is the ruler --------------------
# Run once per dtype, before any candidate is judged: precision.tsv alone cannot
# say whether a max_diff is the reference's noise or the candidate's regression.
# A dtype whose command fails or prints no max_diff gets a null entry, and the
# gate then reports that dtype as unmeasured instead of inventing an e_ref of 0.
if [[ "\${1:-}" == '--calibrate' ]]; then
  [[ -n "$CALIBRATE_CMD" ]] || {
    echo "this contract names no calibrateCommand, so there is nothing to calibrate; add one with kernel_contract — it must measure the reference against itself and print max_diff=<number>" >&2
    exit 2
  }
  mkdir -p "$(dirname "$CALIBRATION_FILE")"
  entries=''
  entry_sep=''
  seen=()
  unmeasured_dtypes=()
  for entry in "\${CELLS[@]}"; do
${EXPORTS}
    # One calibration per dtype: a second cell of the same dtype would only
    # overwrite the same ruler with a different shape's noise.
    already=0
    for name in \${seen[@]+"\${seen[@]}"}; do
      if [[ "$name" == "$dtype" ]]; then already=1; fi
    done
    if [[ $already -eq 1 ]]; then continue; fi
    seen+=("$dtype")

    value='null'
    if out=$(eval "$CALIBRATE_CMD" 2>&1); then
      got=$(printf '%s\\n' "$out" | grep -oE "$MAX_DIFF_RE" | tail -1 || true)
      raw="\${got#max_diff=}"
      if [[ -n "$got" ]] && [[ "$raw" =~ $JSON_NUMBER_RE ]]; then
        value="$raw"
      else
        unmeasured_dtypes+=("$dtype")
        echo "calibration of dtype $dtype printed no usable max_diff (\${got:-nothing}); its entry is null and that dtype stays unmeasured" >&2
      fi
    else
      unmeasured_dtypes+=("$dtype")
      echo "calibration of dtype $dtype failed; its entry is null and that dtype stays unmeasured:" >&2
      printf '%s\\n' "$out" | tail -20 >&2
    fi
    echo "CALIBRATION dtype=$dtype max_diff=$value"
    entries="\${entries}\${entry_sep}{\\"dtype\\":\\"$(json_escape "$dtype")\\",\\"maxDiff\\":\${value}}"
    entry_sep=','
  done
  printf '{"schemaVersion":1,"contractSha":"%s","measuredAt":"%s","entries":[%s]}\\n' \\
    "$CONTRACT_SHA" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$entries" > "$CALIBRATION_FILE"
  echo "calibration recorded in $CALIBRATION_FILE for \${#seen[@]} dtype(s)"
  if [[ \${#unmeasured_dtypes[@]} -gt 0 ]]; then
    echo "unmeasured dtype(s): \${unmeasured_dtypes[*]}; a keep on one of them is refused as unmeasured until it is calibrated" >&2
  fi
  exit 0
fi

failures=0
pair_count=0
# One row per cell x group, rewritten every run: a stale row is worse than a
# missing one, because it would be compared as this candidate's error.
mkdir -p "$(dirname "$PRECISION_FILE")"
printf '# cell\\tgroup\\tmax_diff\\n' > "$PRECISION_FILE"
for entry in "\${CELLS[@]}"; do
${EXPORTS}
  boundary_note=""
  [[ "$boundary" == "1" ]] && boundary_note=" (boundary cell)"
  select_groups "$cid"

  # Cells x groups: correctness is a claim about data sets, not about a shape.
  # A cell with no groups keeps its old line, so a boundary probe still says
  # FAIL cell <id> ...; only a data failure carries "group <name>".
  for gname in "\${G_NAMES[@]}"; do
    gseed="\${G_SEEDS[$G_INDEX]}"
    gintent="\${G_INTENTS[$G_INDEX]}"
    G_INDEX=$(( G_INDEX + 1 ))
${GROUP_EXPORTS}
    pair_count=$(( pair_count + 1 ))
    group_note=""
    [[ "$G_FROM_CONTRACT" == "1" ]] && group_note=" group $gname"

    # The worst of the two passes is this row's error. A FAILING pass still
    # prints a max_diff, and that number is the one a reader wants, so it is
    # recorded before the pair stops: the second pass of a failed pair buys
    # nothing. Only a run that prints no number at all makes the row n/a — a
    # non-numeric check is not evidence of precision, so it is never read as 0.
    max_diff=''
    for pass in 1 2; do
      rc=0
      out=$(eval "$CHECK_CMD" 2>&1) || rc=$?
      got=$(printf '%s\\n' "$out" | grep -oE "$MAX_DIFF_RE" | tail -1 || true)
      if [[ -n "$got" ]]; then
        value="\${got#max_diff=}"
        if [[ -z "$max_diff" ]]; then
          max_diff="$value"
        elif awk -v a="$max_diff" -v b="$value" 'BEGIN { exit (b > a) ? 0 : 1 }'; then
          max_diff="$value"
        fi
      fi
      if [[ $rc -ne 0 ]]; then
        echo "FAIL cell $cid$group_note$boundary_note pass $pass:" >&2
        printf '%s\\n' "$out" | tail -20 >&2
        failures=$((failures+1))
        break
      fi
    done
    if [[ -z "$max_diff" ]]; then
      printf '%s\\t%s\\tn/a\\n' "$cid" "$gname" >> "$PRECISION_FILE"
      echo "note: cell $cid group $gname printed no max_diff; its precision row is n/a and is not compared — a non-numeric check is not evidence of precision" >&2
    else
      printf '%s\\t%s\\t%s\\n' "$cid" "$gname" "$max_diff" >> "$PRECISION_FILE"
    fi
  done
done

[[ $failures -eq 0 ]] || {
  echo "checks failed: $failures cell/group pair(s); a pair that passes once and fails twice may be order-dependent" >&2
  exit 1
}
echo "checks ok: \${#CELLS[@]} cell(s), 2 passes each, $pair_count cell x group pair(s)"
echo "precision: one max_diff row per cell x group in $PRECISION_FILE (n/a where the check printed none)"
`;
}
