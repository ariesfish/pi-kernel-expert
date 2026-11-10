import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { arr, bool, map, num, obj, oneOf, opt, str, type Static } from "@earendil-works/pi-schema";
import * as fs from "node:fs";
import * as path from "node:path";

import {
  normalizeContract,
  writeContractFiles,
  type ContractInput,
} from "../kernel/contract.ts";
import { isPlaceholder, parseMilestone } from "../kernel/milestone.ts";
import { readPackageVersion } from "../support/knowledge.ts";
import { packageRootFrom } from "../support/paths.ts";
import {
  formatWorkspaceIssues,
  validateWorkspace,
} from "../workspace/layout.ts";

const PACKAGE_ROOT = packageRootFrom(import.meta.url);
const GENERATOR = `pi-kernel-expert ${readPackageVersion(PACKAGE_ROOT)}`;

const GroupSchema = obj({
  name: str({
    description: 'Data set name, exported as KERNEL_GROUP, e.g. typical, zero_block. [A-Za-z0-9][A-Za-z0-9_.-]*, unique in the cell.',
  }),
  intent: str({
    description: "What this data set must prove, in one sentence. Required: a group without an intent is refused.",
  }),
  seed: opt(num({ description: "Integer seed the command may use to build the data. Exported as KERNEL_GROUP_SEED." })),
});

const CellSchema = obj({
  id: str({ description: "Stable cell id, e.g. m1024_n4096_k4096" }),
  dtype: str({ description: "Exported as KERNEL_DTYPE, e.g. bf16, fp8_e4m3" }),
  vars: opt(
    map(str(), {
      description: "Extra variables exported as KERNEL_<KEY>, e.g. { M: '1024', N: '4096' }",
    }),
  ),
  boundary: opt(
    bool({ description: "Mark an edge-case cell so failures name it as a boundary; a boundary cell may carry 0 groups." }),
  ),
  groups: opt(
    arr(GroupSchema, {
      description:
        "The data sets this cell is judged on. Required (>= 3) unless boundary is true; each group runs the check and the benchmark and reports its own METRIC line.",
    }),
  ),
});

const ParamsSchema = obj({
  objective: str({ description: "One sentence: what this task optimizes." }),
  workspace: opt(str({ description: "Task workspace. Default: current directory." })),
  check_command: str({
    description:
      "Per-cell, per-group correctness command; env carries KERNEL_CELL, KERNEL_GROUP, KERNEL_GROUP_INTENT, KERNEL_GROUP_SEED, KERNEL_DTYPE, KERNEL_RTOL, KERNEL_ATOL and the cell vars. Exit 0 = correct.",
  }),
  benchmark_command: str({
    description: "Per-cell benchmark command; prints one number or a METRIC line. Same env as the check command.",
  }),
  cells: arr(CellSchema, { minItems: 1 }),
  rtol: num({ description: "Relative tolerance recorded in the contract and exported as KERNEL_RTOL." }),
  atol: num({ description: "Absolute tolerance, exported as KERNEL_ATOL." }),
  metric_name: opt(str({ description: "Underlying metric name. Default: latency_us." })),
  direction: opt(
    oneOf(["lower", "higher"], {
      description: "Is the underlying metric better lower or higher? Default: lower.",
    }),
  ),
  repeats: opt(num({ description: "Measured repetitions per cell. Default: 5." })),
  warmup: opt(num({ description: "Discarded warmup runs per cell. Default: 1." })),
  guard_pct: opt(
    num({ description: "Fail the benchmark when a cell regresses by more than this percent. Default: 5." }),
  ),
  noise_floor_pct: opt(
    num({ description: "A keep below this geomean improvement is refused. Default: 2." }),
  ),
  checks_timeout_seconds: opt(num({ description: "Timeout for the check criterion. Default: 900." })),
  scope_globs: opt(arr(str())),
  test_globs: opt(arr(str())),
  basis: opt(
    oneOf(["device", "e2e"], {
      description:
        'What the benchmark times: "device" (kernel device time) or "e2e" (whole host call). Default: device.',
    }),
  ),
  harness_globs: opt(
    arr(str(), {
      description:
        'Paths a diff may not touch (the comparator, the bench harness). Default: ["goal.sh", "goal.checks.sh"] — add the comparator or it stays writable.',
    }),
  ),
  reference_command: opt(
    str({
      description:
        "Shell command for the same-job reference implementation, measured in the same run. Must differ from benchmark_command.",
    }),
  ),
  calibrate_command: opt(
    str({
      description:
        "Shell command that measures the REFERENCE against itself and prints max_diff=<number>; bash goal.checks.sh --calibrate runs it once per dtype into .kernel/calibration.json. Without it the precision gate has no ruler and stays unarmed.",
    }),
  ),
  clock_lock_sm: opt(
    num({
      description:
        "The SM clock you locked this card to, in MHz. Recorded with the loaded sample and checked against it: a lock that did not hold is reported, not assumed.",
    }),
  ),
  clock_lock_mem: opt(
    num({ description: "The memory clock you locked, in MHz. Recorded beside clock_lock_sm." }),
  ),
  burn_in_ms: opt(
    num({
      description:
        "Wall-clock burn-in before the first measured window when pairing, in ms (0 disables it). Default: 4000. The first window of a job reads 3-5% fast, so a burn-in keeps that bias off one side.",
    }),
  ),
  force: opt(
    bool({ description: "Regenerate even when artifacts exist. Requires /goal allow-benchmark in sealed mode." }),
  ),
});
type Params = Static<typeof ParamsSchema>;

/**
 * The contract is the shape matrix; the milestone is the plan that says which
 * decisions the loop will take. Freezing one without the other is legal — plenty
 * of tasks are a single obvious change — so this warns and never refuses. What
 * it will not do is stay silent: a contract with no addressable plan is a loop
 * that records keeps nothing points at.
 */
function milestoneWarnings(root: string): string[] {
  const file = path.join(root, "docs", "milestone.md");
  if (!fs.existsSync(file)) {
    return [
      "no docs/milestone.md: the contract is frozen but the plan is not addressable, so keeps cannot name a decision. kernel_init writes the template; kernel_milestone validates it and freezes M0.",
    ];
  }
  const { model } = parseMilestone(fs.readFileSync(file, "utf8"));
  if (model.decisions.length === 0) {
    return ["docs/milestone.md has no decision rows: a milestone with no decisions is a plan nobody can act on. Write #### D<m>.<n> rows, then kernel_milestone."];
  }
  const placeholders = model.decisions.filter(
    (decision) => isPlaceholder(decision.name) || decision.rows.some((row) => isPlaceholder(row.value)),
  );
  if (placeholders.length === model.decisions.length) {
    return [
      `docs/milestone.md is still kernel_init's template (${placeholders.length} placeholder decision(s) named ${placeholders.map((decision) => decision.id).join(", ")}): fill it before a keep is recorded, or the keep will name no decision.`,
    ];
  }
  return [];
}

export function registerContractTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "kernel_contract",
    label: "Generate Kernel Contract",
    description:
      "Freeze a kernel task's shape matrix and its input groups into executable artifacts: kernel.contract.json, goal.sh (one METRIC line per cell x group plus a per-cell median, geomean speedup, per-cell regression guard), goal.checks.sh (per cell x group reference comparison, two passes, plus --calibrate for the precision ruler), and kernel-freeze.json (the pi-goal freeze_criteria payload). Refuses incomplete drafts, a non-boundary cell with fewer than 3 groups, a group without an intent, and existing artifacts without force.",
    promptSnippet: "Generate goal.sh, goal.checks.sh, and the freeze payload",
    promptGuidelines: [
      "Call kernel_contract only after docs/draft.md and docs/plan.md hold real content.",
      "A shape is not a data set: give every non-boundary cell at least 3 groups, each with a name and an intent saying what it must prove.",
      "The check command must exit non-zero on a correctness mismatch; the benchmark command must print one number (or a METRIC line).",
      "The benchmark's first run records .kernel/baseline.tsv and reports geomean_speedup=1; later runs compare against it.",
      "Pass the returned payload to freeze_criteria, and use metric_name geomean_speedup with direction higher.",
      "goal.sh and goal.checks.sh are protected by pi-goal in sealed mode; regenerating needs force and /goal allow-benchmark.",
      "If the check or benchmark command runs a file of your own (a .py comparator, a bench harness), add it to harness_globs: the default only protects the two generated scripts.",
      "Have the check command print max_diff=<relative error> and pass calibrate_command (the reference measured against itself); then `bash goal.checks.sh --calibrate` records the ruler and kernel_candidate refuses a keep past 3x the reference's own error plus the dtype floor.",
      "Set basis to e2e only when the command times the whole host call; a device-basis number and an e2e-basis number are never comparable.",
    ],
    parameters: ParamsSchema,
    async execute(
      _toolCallId,
      rawParams,
      _signal,
      _onUpdate,
      ctx,
    ): Promise<{ content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> }> {
      const params = rawParams as Params;
      const root = params.workspace ? path.resolve(ctx.cwd, params.workspace) : ctx.cwd;
      const validation = validateWorkspace(root);
      if (!validation.ok) {
        return {
          content: [
            {
              type: "text" as const,
              text: [
                "Contract not generated: the plan draft is not ready.",
                formatWorkspaceIssues(validation),
                "Fill the named sections in docs/draft.md and docs/plan.md, then call kernel_contract again.",
              ].join("\n"),
            },
          ],
          details: { errors: ["workspace-incomplete"] },
        };
      }

      const input: ContractInput = {
        objective: params.objective,
        checkCommand: params.check_command,
        benchmarkCommand: params.benchmark_command,
        cells: params.cells,
        tolerance: { rtol: params.rtol, atol: params.atol },
        metricName: params.metric_name,
        direction: params.direction,
        repeats: params.repeats,
        warmup: params.warmup,
        guardPct: params.guard_pct,
        noiseFloorPct: params.noise_floor_pct,
        checksTimeoutSeconds: params.checks_timeout_seconds,
        scopeGlobs: params.scope_globs,
        testGlobs: params.test_globs,
        basis: params.basis,
        harnessGlobs: params.harness_globs,
        referenceCommand: params.reference_command,
        calibrateCommand: params.calibrate_command,
        burnInMs: params.burn_in_ms,
        clockLock:
          params.clock_lock_sm === undefined
            ? undefined
            : { sm: params.clock_lock_sm, mem: params.clock_lock_mem },
        generator: GENERATOR,
      };

      const normalized = normalizeContract(input, { root });
      if (!normalized.contract) {
        return {
          content: [
            {
              type: "text" as const,
              text: ["Contract not generated:", ...normalized.errors.map((error) => `- ${error}`)].join("\n"),
            },
          ],
          details: { errors: normalized.errors },
        };
      }

      const written = writeContractFiles({ root, contract: normalized.contract, force: params.force === true });
      if (!written.ok) {
        return {
          content: [
            {
              type: "text" as const,
              text: [
                "Contract not generated:",
                ...written.errors.map((error) => `- ${error}`),
                "Regenerating replaces the scripts the gate depends on; confirm before forcing.",
              ].join("\n"),
            },
          ],
          details: { errors: written.errors },
        };
      }

      const { sha, freeze, written: files } = written.result;
      const warnings = [...normalized.warnings, ...milestoneWarnings(root)];
      const contract = normalized.contract;
      const groupCount = contract.cells.reduce((total, cell) => total + cell.groups.length, 0);
      const groupSummary = contract.cells
        .map((cell) => `${cell.id}=${cell.groups.length === 0 ? "default" : cell.groups.map((group) => group.name).join(",")}`)
        .join("  ");
      const text = [
        `Contract frozen for ${contract.cells.length} cell(s), ${groupCount} input group(s).`,
        `kernel.contract.json sha256 ${sha}`,
        `groups ${groupSummary}`,
        `basis ${contract.basis}  harness ${contract.harnessGlobs.join(", ")}`,
        contract.referenceCommand
          ? `reference ${contract.referenceCommand}`
          : "reference none (a cross-run baseline stays legal, labelled `pairing: absent`)",
        contract.calibrateCommand
          ? `calibration ${contract.calibrateCommand} (run: bash goal.checks.sh --calibrate)`
          : "calibration none (the check's max_diff has no ruler, so the precision gate stays unarmed)",
        "",
        "written:",
        ...files.map((file) => `- ${path.relative(root, file)}`),
        ...(warnings.length > 0 ? ["", "warnings:", ...warnings.map((warning) => `- ${warning}`)] : []),
        "",
        "Next:",
        "1. Pass kernel-freeze.json to freeze_criteria (one human confirmation).",
        "2. Use metric_name geomean_speedup with direction higher for init_goal/experiments.",
        "3. Run goal.sh once to record the baseline; it reports geomean_speedup=1 and writes .kernel/baseline.tsv.",
        "4. Later runs compare per cell, refuse a regression beyond the guard, and emit the geomean.",
        "",
        "freeze_criteria payload:",
        JSON.stringify(freeze, null, 2),
      ].join("\n");

      return {
        content: [{ type: "text" as const, text }],
        details: { sha, written: files, freeze, warnings, groupCount },
      };
    },
  });
}
