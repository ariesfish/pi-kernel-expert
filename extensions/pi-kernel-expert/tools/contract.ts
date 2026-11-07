import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as path from "node:path";
import { Type } from "typebox";

import {
  normalizeContract,
  writeContractFiles,
  type ContractInput,
} from "../kernel/contract.ts";
import { readPackageVersion } from "../support/knowledge.ts";
import { packageRootFrom } from "../support/paths.ts";
import {
  formatWorkspaceIssues,
  validateWorkspace,
} from "../workspace/layout.ts";

const PACKAGE_ROOT = packageRootFrom(import.meta.url);
const GENERATOR = `pi-kernel-expert ${readPackageVersion(PACKAGE_ROOT)}`;

const CellSchema = Type.Object({
  id: Type.String({ description: "Stable cell id, e.g. m1024_n4096_k4096" }),
  dtype: Type.String({ description: "Exported as KERNEL_DTYPE, e.g. bf16, fp8_e4m3" }),
  vars: Type.Optional(
    Type.Record(Type.String(), Type.String(), {
      description: "Extra variables exported as KERNEL_<KEY>, e.g. { M: '1024', N: '4096' }",
    }),
  ),
  boundary: Type.Optional(
    Type.Boolean({ description: "Mark an edge-case cell so failures name it as a boundary." }),
  ),
});

export function registerContractTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "kernel_contract",
    label: "Generate Kernel Contract",
    description:
      "Freeze a kernel task's shape matrix into executable artifacts: kernel.contract.json, goal.sh (per-cell METRIC lines, median of repeats, geomean speedup, per-cell regression guard), goal.checks.sh (per-cell reference comparison, two passes), and kernel-freeze.json (the pi-goal freeze_criteria payload). Refuses incomplete drafts and existing artifacts without force.",
    promptSnippet: "Generate goal.sh, goal.checks.sh, and the freeze payload",
    promptGuidelines: [
      "Call kernel_contract only after docs/draft.md and docs/plan.md hold real content.",
      "The check command must exit non-zero on a correctness mismatch; the benchmark command must print one number (or a METRIC line).",
      "The benchmark's first run records .kernel/baseline.tsv and reports geomean_speedup=1; later runs compare against it.",
      "Pass the returned payload to freeze_criteria, and use metric_name geomean_speedup with direction higher.",
      "goal.sh and goal.checks.sh are protected by pi-goal in sealed mode; regenerating needs force and /goal allow-benchmark.",
    ],
    parameters: Type.Object({
      objective: Type.String({ description: "One sentence: what this task optimizes." }),
      workspace: Type.Optional(Type.String({ description: "Task workspace. Default: current directory." })),
      check_command: Type.String({
        description: "Per-cell correctness command; env carries KERNEL_CELL, KERNEL_DTYPE, KERNEL_RTOL, KERNEL_ATOL and the cell vars. Exit 0 = correct.",
      }),
      benchmark_command: Type.String({
        description: "Per-cell benchmark command; prints one number or a METRIC line. Same env as the check command.",
      }),
      cells: Type.Array(CellSchema, { minItems: 1 }),
      rtol: Type.Number({ description: "Relative tolerance recorded in the contract and exported as KERNEL_RTOL." }),
      atol: Type.Number({ description: "Absolute tolerance, exported as KERNEL_ATOL." }),
      metric_name: Type.Optional(Type.String({ description: "Underlying metric name. Default: latency_us." })),
      direction: Type.Optional(
        Type.Union([Type.Literal("lower"), Type.Literal("higher")], {
          description: "Is the underlying metric better lower or higher? Default: lower.",
        }),
      ),
      repeats: Type.Optional(Type.Number({ description: "Measured repetitions per cell. Default: 5." })),
      warmup: Type.Optional(Type.Number({ description: "Discarded warmup runs per cell. Default: 1." })),
      guard_pct: Type.Optional(
        Type.Number({ description: "Fail the benchmark when a cell regresses by more than this percent. Default: 5." }),
      ),
      checks_timeout_seconds: Type.Optional(Type.Number({ description: "Timeout for the check criterion. Default: 900." })),
      scope_globs: Type.Optional(Type.Array(Type.String())),
      test_globs: Type.Optional(Type.Array(Type.String())),
      force: Type.Optional(
        Type.Boolean({ description: "Regenerate even when artifacts exist. Requires /goal allow-benchmark in sealed mode." }),
      ),
    }),
    async execute(
      _toolCallId,
      params,
      _signal,
      _onUpdate,
      ctx,
    ): Promise<{ content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> }> {
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
        checksTimeoutSeconds: params.checks_timeout_seconds,
        scopeGlobs: params.scope_globs,
        testGlobs: params.test_globs,
        generator: GENERATOR,
      };

      const normalized = normalizeContract(input);
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
      const text = [
        `Contract frozen for ${normalized.contract.cells.length} cell(s).`,
        `kernel.contract.json sha256 ${sha}`,
        "",
        "written:",
        ...files.map((file) => `- ${path.relative(root, file)}`),
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
        details: { sha, written: files, freeze },
      };
    },
  });
}
