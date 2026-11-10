import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { bool, num, obj, opt, str, type Static } from "@earendil-works/pi-schema";
import * as path from "node:path";

import { isSafeRunId, readContract } from "../kernel/candidates.ts";
import { diffFingerprint } from "../kernel/diff.ts";
import { formatProfileOutcome, runProfile } from "../kernel/profile.ts";
import { packageRootFrom } from "../support/paths.ts";

const PACKAGE_ROOT = packageRootFrom(import.meta.url);
const HELPERS_DIR = path.join(PACKAGE_ROOT, "skills", "ncu-report-skill", "helpers");

const ParamsSchema = obj({
  workspace: opt(str({ description: "Task workspace. Default: current directory." })),
  run_id: opt(str({ description: "Directory under profile/. Default: timestamp." })),
  tag: opt(str({ description: "Analysis tag. Default: full." })),
  report: opt(str({ description: "Attach an existing .ncu-rep/.ncu-repz instead of collecting." })),
  command: opt(str({ description: "Command to profile when collecting, run through bash -lc." })),
  kernel: opt(str({ description: "ncu -k regex selecting the kernel." })),
  launch_count: opt(num({ description: "ncu -c launch count. Default: 1." })),
  binary: opt(str({ description: "Profiled binary for inline-aware stall attribution." })),
  reuse_analysis: opt(bool({ description: "Skip the helpers and parse an existing analysis/ directory." })),
});
type Params = Static<typeof ParamsSchema>;

function defaultRunId(now = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return [
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`,
    `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`,
  ].join("-");
}

export function registerProfileTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "kernel_profile",
    label: "Profile Kernel",
    description:
      "Collect one Nsight Compute report (or attach an existing one), run the vendored helpers, and write profile/<run>/summary.json bound to the current contract hash and diff hash: GPU identity, clock state, ncu version, present metrics (absent ones listed, never zeroed), top rules with estimated speedup, and top stall lines.",
    promptSnippet: "Profile a kernel with ncu and write an evidence summary",
    promptGuidelines: [
      "Profile the real code with line info; read the ncu-report-skill for collection choices and the six analysis dimensions.",
      "One run directory per collection; never reuse or overwrite an existing profile/<run>.",
      "Cite metric names that exist in summary.json. An absent metric is a finding, not zero.",
      "Profile after the change and before committing it: the summary is bound to the diff hash, so any later edit makes it stale.",
      "The summary records measurements; the diagnosis and the ranked fixes belong in the run report and the candidate description.",
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
      const loaded = readContract(workspace);
      if (!loaded.ok) {
        return {
          content: [{ type: "text" as const, text: loaded.reason }],
          details: {},
        };
      }

      const fingerprint = await diffFingerprint({
        exec: pi,
        root: workspace,
        scopeGlobs: loaded.contract.scopeGlobs,
        signal,
      });
      if (!fingerprint.ok) {
        return {
          content: [{ type: "text" as const, text: `Cannot fingerprint the tree: ${fingerprint.reason}` }],
          details: {},
        };
      }

      const runId = params.run_id?.trim() || defaultRunId();
      if (!isSafeRunId(runId)) {
        return {
          content: [{ type: "text" as const, text: `run_id "${runId}" must be a plain directory name.` }],
          details: {},
        };
      }
      const outcome = await runProfile({
        workspace,
        runId,
        tag: params.tag?.trim() || "full",
        helpersDir: HELPERS_DIR,
        contractSha: loaded.sha,
        diffHash: fingerprint.value.hash,
        gitHead: fingerprint.value.head,
        reportPath: params.report,
        command: params.command,
        kernel: params.kernel,
        launchCount: params.launch_count,
        binary: params.binary,
        reuseAnalysis: params.reuse_analysis === true,
        exec: pi,
        signal,
      });

      return {
        content: [{ type: "text" as const, text: formatProfileOutcome(outcome) }],
        details: outcome.ok
          ? { summary: outcome.summary, summaryPath: outcome.summaryPath, runDir: outcome.runDir }
          : { errors: outcome.errors },
      };
    },
  });
}
