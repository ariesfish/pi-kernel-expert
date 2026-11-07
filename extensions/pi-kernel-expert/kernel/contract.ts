import { createHash } from "node:crypto";
import * as fs from "node:fs";

import { workspacePaths } from "../workspace/layout.ts";

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
  checksTimeoutSeconds?: number;
  scopeGlobs?: string[];
  testGlobs?: string[];
  generator?: string;
}

export interface Cell extends Required<Omit<CellInput, "boundary" | "vars">> {
  vars: Record<string, string>;
  boundary: boolean;
}

export interface KernelContract {
  version: 1;
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
  checksTimeoutSeconds: number;
  scopeGlobs: string[];
  testGlobs: string[];
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
}

export function normalizeContract(input: ContractInput): NormalizeResult {
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

  if (errors.length > 0) return { errors };
  return {
    contract: {
      version: 1,
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
      checksTimeoutSeconds,
      scopeGlobs,
      testGlobs,
      generator: input.generator?.trim() || "pi-kernel-expert",
    },
    errors: [],
  };
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
  fs.writeFileSync(paths.contract, json);
  fs.writeFileSync(paths.benchmarkScript, renderBenchmarkScript(options.contract, sha));
  fs.writeFileSync(paths.checksScript, renderChecksScript(options.contract, sha));
  fs.writeFileSync(paths.freezePayload, `${JSON.stringify(freeze, null, 2)}\n`);
  for (const script of [paths.benchmarkScript, paths.checksScript]) {
    fs.chmodSync(script, 0o755);
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
set -euo pipefail

CONTRACT_SHA=${shQuote(sha)}
METRIC_NAME=${shQuote(contract.metricName)}
DIRECTION=${shQuote(contract.direction)}
REPEATS=${contract.repeats}
WARMUP=${contract.warmup}
GUARD_PCT=${shQuote(String(contract.guardPct))}
BENCH_CMD=${shQuote(contract.benchmarkCommand)}
BASELINE_FILE='.kernel/baseline.tsv'
CELLS=(${cellsArray(contract)})

${HASH_FUNCTION}

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

for entry in "\${CELLS[@]}"; do
${EXPORTS}

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
  done

  median=$(sort -g "$tmp" | awk '{ a[NR]=$1 } END { if (NR==0) exit 1; if (NR%2) print a[(NR+1)/2]; else printf "%.10g\\n", (a[NR/2]+a[NR/2+1])/2 }')
  safe=$(printf '%s' "$cid" | tr -c 'A-Za-z0-9' '_')
  printf 'METRIC %s_%s=%s\\n' "$METRIC_NAME" "$safe" "$median"

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

if [[ $baseline_run -eq 1 ]]; then
  {
    printf '# cell\\tmetric\\tvalue\\tdirection\\n'
    for item in "\${new_baseline[@]}"; do
      printf '%s\\t%s\\t%s\\t%s\\n' "\${item%%|*}" "$METRIC_NAME" "\${item#*|}" "$DIRECTION"
    done
  } > "$BASELINE_FILE"
  printf 'METRIC geomean_speedup=1\\n'
  echo "baseline recorded in $BASELINE_FILE"
  exit 0
fi

geomean=$(awk '{ s+=log($1); n++ } END { if (n==0) exit 1; printf "%.10g\\n", exp(s/n) }' "$ratio_file")
printf 'METRIC geomean_speedup=%s\\n' "$geomean"
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
