import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as path from "node:path";
import { Type } from "typebox";

import { formatCandidateOutcome, recordCandidate } from "../kernel/candidates.ts";

export function registerCandidateTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "kernel_candidate",
    label: "Record Kernel Candidate",
    description:
      "Append a candidate to candidates.jsonl with its parent, diff hash, contract hash, per-cell metrics, profile pointer, bottleneck claim, decision, and reason. Refuses a keep below the contract's noise floor, a keep missing any matrix cell, a stale profile, or a bottleneck metric that is not in the report.",
    promptSnippet: "Record a candidate decision with its evidence",
    promptGuidelines: [
      "Record every attempted candidate, kept or rejected. A rejection without a reason is not recorded.",
      "Profile after the change and record the candidate before log_goal commits it; the diff hash binds the evidence.",
      "A bottleneck claim must name a metric that exists in the profile summary; absence is reported, never inferred.",
      "pi-goal's log_goal is still the thing that commits a keep; this ledger is the lineage on top of it.",
    ],
    parameters: Type.Object({
      workspace: Type.Optional(Type.String({ description: "Task workspace. Default: current directory." })),
      decision: Type.Union([Type.Literal("keep"), Type.Literal("reject")]),
      description: Type.String({ description: "What the candidate tried, one or two sentences." }),
      metrics: Type.Optional(
        Type.Record(Type.String(), Type.Number(), {
          description: "Metric values from the run: geomean_speedup and every <metric>_<cell>.",
        }),
      ),
      profile_run: Type.Optional(Type.String({ description: "profile/<run_id> holding summary.json." })),
      bottleneck_claim: Type.Optional(Type.String({ description: "The diagnosed limiter, e.g. latency-bound on L1." })),
      bottleneck_metric: Type.Optional(
        Type.String({ description: "A metric name present in the profile summary that supports the claim." }),
      ),
      reason: Type.Optional(Type.String({ description: "Required for reject." })),
      commit: Type.Optional(Type.String({ description: "Commit sha once pi-goal's log_goal keeps the change." })),
      force_with_reason: Type.Optional(
        Type.String({ description: "Keep below the noise floor, with the reason recorded." }),
      ),
    }),
    async execute(
      _toolCallId,
      params,
      signal,
      _onUpdate,
      ctx,
    ): Promise<{ content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> }> {
      const workspace = params.workspace ? path.resolve(ctx.cwd, params.workspace) : ctx.cwd;
      const outcome = await recordCandidate({
        workspace,
        decision: params.decision,
        description: params.description,
        metrics: params.metrics,
        profileRun: params.profile_run,
        bottleneck:
          params.bottleneck_claim || params.bottleneck_metric
            ? { claim: params.bottleneck_claim ?? "", metric: params.bottleneck_metric ?? "" }
            : undefined,
        reason: params.reason,
        commit: params.commit,
        forceWithReason: params.force_with_reason,
        exec: pi,
        signal,
      });

      return {
        content: [{ type: "text" as const, text: formatCandidateOutcome(outcome) }],
        details: outcome.ok
          ? { record: outcome.record, benchmarkCsv: outcome.benchmarkCsv?.path ?? null }
          : { errors: outcome.errors },
      };
    },
  });
}
