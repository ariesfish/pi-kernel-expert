import * as fs from "node:fs";
import * as path from "node:path";

import { workspacePaths } from "../workspace/layout.ts";
import {
  CONTRACT_SCHEMA_VERSION,
  contractJson,
  contractSha,
  type Basis,
  type KernelContract,
} from "./contract-model.ts";
import { renderBenchmarkScript, renderChecksScript } from "./contract-scripts.ts";

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

  return { ok: true, contract: parsed, sha: contractSha(text) };
}

function schemaRefusal(schemaVersion: unknown): string {
  if (schemaVersion === undefined || schemaVersion === 1) {
    return "kernel.contract.json is schema v1 (or unversioned); regenerate with kernel_contract";
  }
  return `kernel.contract.json is schema v${String(schemaVersion)}; this build reads v${CONTRACT_SCHEMA_VERSION}; regenerate with kernel_contract`;
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
