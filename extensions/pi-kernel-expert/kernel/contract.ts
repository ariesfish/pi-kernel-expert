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
export const DEFAULT_HARNESS_GLOBS = ["goal.sh", "goal.checks.sh"] as const;

export interface CellInput {
  id: string;
  dtype: string;
  /** Exported to the commands as `KERNEL_<KEY>=<value>`. */
  vars?: Record<string, string>;
  boundary?: boolean;
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
  generator?: string;
}

export interface Cell extends Required<Omit<CellInput, "boundary" | "vars">> {
  vars: Record<string, string>;
  boundary: boolean;
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
  generator: string;
}

export const DEFAULT_METRIC_NAME = "latency_us";

const ID_RULE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const VAR_KEY_RULE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const METRIC_RULE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const FORBIDDEN_IN_VALUE = /[|\n\r,]/;

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
      cells.push({
        id: cell.id,
        dtype: cell.dtype,
        vars,
        boundary: cell.boundary === true,
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

  const benchmarkCommand = input.benchmarkCommand?.trim() ?? "";
  const referenceCommand = input.referenceCommand?.trim() || null;
  if (referenceCommand !== null && referenceCommand === benchmarkCommand) {
    errors.push(
      `referenceCommand and benchmarkCommand are the same command ("${referenceCommand}"); a self-reference is not a reference`,
    );
  }

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
}

/** Exactly one blocking metric criterion, as pi-goal requires. */
export function freezePayload(contract: KernelContract): FreezePayload {
  return {
    objective: contract.objective,
    criteria: [
      {
        id: "M1",
        statement: `geomean speedup over the recorded baseline across ${contract.cells.length} matrix cell(s)`,
        kind: "metric",
        blocking: true,
        metric: { name: "geomean_speedup", direction: "higher", unit: "x" },
      },
      {
        id: "C1",
        statement: "every matrix cell matches the reference on two consecutive passes",
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

function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function cellsArray(contract: KernelContract): string {
  return contract.cells
    .map((cell) => {
      const vars = Object.entries(cell.vars)
        .map(([key, value]) => `${key}=${value}`)
        .join(",");
      return shQuote(
        [cell.id, cell.dtype, String(contract.tolerance.rtol), String(contract.tolerance.atol), cell.boundary ? "1" : "0", vars].join("|"),
      );
    })
    .join(" ");
}

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

export function renderBenchmarkScript(contract: KernelContract, sha: string): string {
  return `#!/usr/bin/env bash
# Generated by ${contract.generator}. Do not edit: regenerate with kernel_contract.
# Contract: kernel.contract.json (sha256 ${sha})
#
# One machine-readable reading block per run. Shell can time only its own wall
# clock (shellMs) and read GPU state from nvidia-smi; device and enqueue figures
# are recorded only when the bench command prints them (METRIC device_ms=,
# METRIC host_enqueue_ms=). A host-free basis (cuda_graph, cupti_kernel_span)
# needs a runner that clocks the device: that arrives with the runner, not here.
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
CELLS=(${cellsArray(contract)})
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
GPU_SAMPLE_END=''
CELL_JSON=()
HOST_ENQUEUE_VALUES=()
DEVICE_VALUES=()
WARNINGS=()

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

  local idx name csm cmem util foreign body sep n
  idx=$(printf '%s\\n' "$row" | awk -F',' '{ v=$1; gsub(/[[:space:]]/,"",v); print v }')
  name=$(printf '%s\\n' "$row" | awk -F',' '{ v=$2; for (i=3; i<=NF-3; i++) v=v","$i; sub(/^[[:space:]]+/,"",v); sub(/[[:space:]]+$/,"",v); print v }')
  csm=$(printf '%s\\n' "$row" | awk -F',' '{ v=$(NF-2); gsub(/[[:space:]]/,"",v); print v }')
  cmem=$(printf '%s\\n' "$row" | awk -F',' '{ v=$(NF-1); gsub(/[[:space:]]/,"",v); print v }')
  util=$(printf '%s\\n' "$row" | awk -F',' '{ v=$NF; gsub(/[[:space:]]/,"",v); print v }')
  foreign=$(foreign_mib "$first")

  GPU_AVAILABLE=1
  if [[ "$phase" == 'start' ]]; then
    if [[ -z "$GPU_NAME" ]]; then GPU_NAME="$name"; fi
    if [[ -z "$GPU_INDEX" ]]; then GPU_INDEX="$idx"; fi
  fi

  body=''
  sep=''
  if n=$(json_number "$csm"); then body="\${body}\${sep}\\"clocksSmMhz\\":\${n}"; sep=','; fi
  if n=$(json_number "$cmem"); then body="\${body}\${sep}\\"clocksMemMhz\\":\${n}"; sep=','; fi
  if n=$(json_number "$util"); then body="\${body}\${sep}\\"utilPct\\":\${n}"; sep=','; fi
  if [[ "$foreign" =~ ^[0-9]+$ ]]; then body="\${body}\${sep}\\"foreignProcessMiB\\":\${foreign}"; sep=','; fi

  if [[ "$phase" == 'start' ]]; then
    GPU_SAMPLE_START="{\${body}}"
  else
    GPU_SAMPLE_END="{\${body}}"
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

emit_reading() {
  local finished end_ms delta shell_ms host_json device_json ratio_json verdict reason
  local gpu_json cells_json warnings_json tail_json item sep w

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
  printf ',"startedAt":%s,"finishedAt":%s' "$(json_string "$STARTED_AT")" "$(json_string "$finished")"
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
ratio_file=$(mktemp)
trap 'rm -f "$tmp" "$ratio_file"' EXIT
failures=0
new_baseline=()

BASIS_SOURCE='shell-wall'
VISIBLE="\${CUDA_VISIBLE_DEVICES:-}"
STARTED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
START_MS=$(now_ms)
smi_version
gpu_probe 'start'

for entry in "\${CELLS[@]}"; do
  IFS='|' read -r cid dtype rtol atol boundary vars <<< "$entry"
  export KERNEL_CELL="$cid" KERNEL_DTYPE="$dtype" KERNEL_RTOL="$rtol" KERNEL_ATOL="$atol" KERNEL_BOUNDARY="$boundary"
  if [[ -n "$vars" ]]; then
    IFS=',' read -ra pairs <<< "$vars"
    for pair in "\${pairs[@]}"; do
      [[ -n "$pair" ]] || continue
      export "KERNEL_\${pair%%=*}=\${pair#*=}"
    done
  fi

  for ((w=0; w<WARMUP; w++)); do
    if ! eval "$BENCH_CMD" >/dev/null 2>&1; then
      echo "benchmark failed during warmup in cell $cid (warmup $((w+1))/$WARMUP)" >&2
      exit 1
    fi
  done

  : > "$tmp"
  for ((r=0; r<REPEATS; r++)); do
    if ! raw=$(eval "$BENCH_CMD" 2>&1); then
      echo "benchmark failed in cell $cid:" >&2
      printf '%s\\n' "$raw" >&2
      exit 1
    fi
    if [[ $raw =~ METRIC[[:space:]]+[A-Za-z0-9_.]+=([0-9.eE+-]+) ]]; then
      value="\${BASH_REMATCH[1]}"
    else
      value=$(printf '%s\\n' "$raw" | grep -oE '[-+]?[0-9]*\\.?[0-9]+([eE][-+]?[0-9]+)?' | tail -1 || true)
    fi
    [[ -n "\${value:-}" ]] || {
      echo "benchmark in cell $cid printed no number" >&2
      printf '%s\\n' "$raw" >&2
      exit 1
    }
    printf '%s\\n' "$value" >> "$tmp"

    # Only the task can say how long the device ran and how long the host took
    # to enqueue; take its numbers as reported and median them over the run.
    reported=$(printf '%s\\n' "$raw" | grep -oE 'METRIC[[:space:]]+[A-Za-z0-9_.]+=[0-9.eE+-]+' || true)
    while IFS=' ' read -r tag pair; do
      [[ "$tag" == 'METRIC' ]] || continue
      case "\${pair%%=*}" in
        host_enqueue_ms) HOST_ENQUEUE_VALUES+=("\${pair#*=}") ;;
        device_ms) DEVICE_VALUES+=("\${pair#*=}") ;;
      esac
    done <<< "$reported"
  done

  median=$(sort -g "$tmp" | awk '{ a[NR]=$1 } END { if (NR==0) exit 1; if (NR%2) print a[(NR+1)/2]; else printf "%.10g\\n", (a[NR/2]+a[NR/2+1])/2 }')
  safe=$(printf '%s' "$cid" | tr -c 'A-Za-z0-9' '_')
  printf 'METRIC %s_%s=%s\\n' "$METRIC_NAME" "$safe" "$median"

  spread=''
  if [[ $REPEATS -ge 2 ]]; then
    spread=$(awk -v m="$median" 'NR==1 { lo=$1; hi=$1 } { if ($1<lo) lo=$1; if ($1>hi) hi=$1 } END { if (m > 0 && NR > 0) printf "%.12g", (hi-lo)/m*100 }' "$tmp")
  fi
  median_json=$(json_number "$median" || true)
  if [[ -z "$median_json" ]]; then
    WARNINGS+=("cell $cid has no JSON-safe median (raw: $median); the cell is missing from this reading")
  else
    cell_json="{\\"id\\":$(json_string "$cid"),\\"metric\\":$(json_string "\${METRIC_NAME}_\${safe}"),\\"median\\":\${median_json},\\"samples\\":\${REPEATS}"
    if [[ -n "$spread" ]] && spread_json=$(json_number "$spread"); then
      cell_json="\${cell_json},\\"spreadPct\\":\${spread_json}"
    fi
    CELL_JSON+=("\${cell_json}}")
  fi

  if [[ $baseline_run -eq 1 ]]; then
    new_baseline+=("$cid|$median")
    continue
  fi

  base=$(awk -F'\\t' -v c="$cid" '$1==c {print $3}' "$BASELINE_FILE" | head -1)
  if [[ -z "$base" ]]; then
    echo "baseline has no value for cell $cid; rerun with --reset-baseline" >&2
    exit 1
  fi
  ratio=$(awk -v b="$base" -v c="$median" -v d="$DIRECTION" 'BEGIN { if (c<=0 || b<=0) exit 1; if (d=="lower") printf "%.10g\\n", b/c; else printf "%.10g\\n", c/b }')
  printf '%s\\n' "$ratio" >> "$ratio_file"
  if awk -v r="$ratio" -v g="$GUARD_PCT" 'BEGIN { exit (r < 1 - g/100) ? 1 : 0 }'; then
    :
  else
    echo "guard: cell $cid regressed (ratio $ratio < 1 - $GUARD_PCT/100)" >&2
    failures=$((failures+1))
  fi
done

if [[ \${#DEVICE_VALUES[@]} -gt 0 || \${#HOST_ENQUEUE_VALUES[@]} -gt 0 ]]; then
  BASIS_SOURCE='task-reported'
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
set -euo pipefail

CONTRACT_SHA=${shQuote(sha)}
CHECK_CMD=${shQuote(contract.checkCommand)}
CELLS=(${cellsArray(contract)})

${HASH_FUNCTION}

[[ -f kernel.contract.json ]] || { echo "kernel.contract.json is missing; run kernel_contract" >&2; exit 2; }
actual=$(hash_file kernel.contract.json) || exit 2
[[ "$actual" == "$CONTRACT_SHA" ]] || {
  echo "kernel.contract.json changed (expected $CONTRACT_SHA, got $actual); regenerate with kernel_contract" >&2
  exit 2
}

failures=0
for entry in "\${CELLS[@]}"; do
${EXPORTS}
  boundary_note=""
  [[ "$boundary" == "1" ]] && boundary_note=" (boundary cell)"

  for pass in 1 2; do
    if ! out=$(eval "$CHECK_CMD" 2>&1); then
      echo "FAIL cell $cid$boundary_note pass $pass:" >&2
      printf '%s\\n' "$out" | tail -20 >&2
      failures=$((failures+1))
      break
    fi
  done
done

[[ $failures -eq 0 ]] || {
  echo "checks failed: $failures cell(s); a cell that passes once and fails twice may be order-dependent" >&2
  exit 1
}
echo "checks ok: \${#CELLS[@]} cell(s), 2 passes each"
`;
}
