import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { bool, map, num, obj, oneOf, opt, str, type Static } from "@earendil-works/pi-schema";
import * as path from "node:path";

import { formatCandidateOutcome, recordCandidate } from "../kernel/candidates.ts";

const ParamsSchema = obj({
  workspace: opt(str({ description: "Task workspace. Default: current directory." })),
  decision: oneOf(["keep", "reject"]),
  description: str({ description: "What the candidate tried, one or two sentences." }),
  metrics: opt(
    map(num(), {
      description: "Metric values from the run: geomean_speedup and every <metric>_<cell>.",
    }),
  ),
  profile_run: opt(str({ description: "profile/<run_id> holding summary.json." })),
  bottleneck_claim: opt(str({ description: "The diagnosed limiter, e.g. latency-bound on L1." })),
  bottleneck_metric: opt(
    str({ description: "A metric name present in the profile summary that supports the claim." }),
  ),
  reason: opt(str({ description: "Required for reject." })),
  milestone_decision: opt(
    str({
      description:
        "The docs/milestone.md decision this change implements: `D0.3`, or a `+` joined bundle. Required on a keep when a milestone exists; a bundle the plan recorded as a dead end needs precondition.",
    }),
  ),
  milestone_sha: opt(
    str({
      description:
        "The milestone sha you read, as a guard: if docs/milestone.md has moved since, the keep is refused as milestone-stale.",
    }),
  ),
  precondition: opt(
    str({
      description:
        "What is different about a combination the plan already killed. Recorded with the candidate; without it a dead-ended bundle is refused.",
    }),
  ),
  reading: opt(
    str({
      description:
        "The evidence this keep rests on: goal.sh's stdout, the \"=== KERNEL READING ===\" block alone, the block's JSON, or a path to a log holding one. Missing = refused (basis-missing).",
    }),
  ),
  wiki: opt(
    obj(
      {
        id: opt(str({ description: "The kernel_wiki_candidate id this keep produced." })),
        none: opt(bool({ description: "True when the keep proved no transferable mechanism." })),
        declined: opt(str({ description: "Why no entry was written; required when declining." })),
      },
      {
        description:
          "The page this promotion left behind. A keep with profile evidence and a bottleneck claim that omits this warns, never refuses.",
      },
    ),
  ),
  commit: opt(str({ description: "Commit sha once pi-goal's log_goal keeps the change." })),
  force_with_reason: opt(
    str({ description: "Keep below the noise floor, with the reason recorded." }),
  ),
});
type Params = Static<typeof ParamsSchema>;

export function registerCandidateTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "kernel_candidate",
    label: "Record Kernel Candidate",
    description:
      "Append a candidate to candidates.jsonl with its parent, diff hash, contract hash, per-cell metrics, the reading block it rests on, profile pointer, bottleneck claim, decision, and reason. Refuses a keep by naming every rule it breaks — the reading has no basis, the reading is host-bound or unmeasured, the diff edits a harnessGlobs path, a cell x group or a cell aggregate has no reading, the claimed cell value is not the reading's own, the candidate's max_diff is past 3x the reference's own error plus the dtype floor (.kernel/precision.tsv vs .kernel/calibration.json), a profile is stale — and prints all of them in one block, each with the side it is charged to and the fix. It also refuses a keep whose decision the plan does not have (decision-missing, decision-unknown), one whose milestone sha moved (milestone-stale), and one that retries a recorded dead-end bundle without a precondition.",
    promptSnippet: "Record a candidate decision with its evidence",
    promptGuidelines: [
      "Record every attempted candidate, kept or rejected. A rejection without a reason is not recorded.",
      "Pass reading: the stdout of goal.sh (or a path to the log). Without it the keep has no basis and is refused.",
      "Pass wiki: { id } after kernel_wiki_candidate, or { none: true } when the keep proved nothing that transfers. A keep with profile evidence and a bottleneck claim that omits it warns.",
      "Profile after the change and record the candidate before log_goal commits it; the diff hash binds the evidence.",
      "A bottleneck claim must name a metric that exists in the profile summary; absence is reported, never inferred.",
      "force_with_reason only accepts a run-level defect (missing basis, host-bound or unmeasured reading, an unmeasured cell/group, an uncalibrated reference). It never accepts an edited harness, a stale profile, or a measured precision regression.",
      "Name the decision a keep implements: milestone_decision takes an id from docs/milestone.md (`D0.3`, or `D0.1+D0.2`). A keep that names no decision is refused once the plan exists, and an id the plan does not have is refused always — force_with_reason cannot buy attribution.",
      "A combination the plan recorded as a dead end is refused unless precondition says what changed. A different precondition is the reason a killed idea becomes worth retrying; a smaller bundle is not.",
      "pi-goal's log_goal is still the thing that commits a keep; this ledger is the lineage on top of it.",
    ],
    parameters: ParamsSchema,
    async execute(
      _toolCallId,
      rawParams,
      signal,
      _onUpdate,
      ctx,
    ): Promise<{ content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> }> {
      const params = rawParams as Params;
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
        reading: params.reading,
        wiki: params.wiki,
        milestoneDecision: params.milestone_decision,
        milestoneSha: params.milestone_sha,
        precondition: params.precondition,
        forceWithReason: params.force_with_reason,
        exec: pi,
        signal,
      });

      return {
        content: [{ type: "text" as const, text: formatCandidateOutcome(outcome) }],
        details: outcome.ok
          ? {
              record: outcome.record,
              benchmarkCsv: outcome.benchmarkCsv?.path ?? null,
              refusals: [],
            }
          : { errors: outcome.errors, refusals: outcome.refusals },
      };
    },
  });
}
