import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { obj, opt, str, type Static } from "@earendil-works/pi-schema";
import * as fs from "node:fs";
import * as path from "node:path";

import { formatWorkspaceIssues, initWorkspace, validateWorkspace, workspacePaths } from "../workspace/layout.ts";

const ParamsSchema = obj({
  workspace: opt(str({ description: "Task workspace. Default: current directory." })),
});
type Params = Static<typeof ParamsSchema>;

function resolveWorkspace(cwd: string, workspace?: string): string {
  return workspace ? path.resolve(cwd, workspace) : cwd;
}

export function registerInitTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "kernel_init",
    label: "Initialize Kernel Task",
    description:
      "Create a kernel task workspace: docs/draft.md, docs/plan.md, profile/, runs/, candidates.jsonl, and .kernel/. Never overwrites existing files. Validates the KDA draft/plan headings.",
    promptSnippet: "Create the kernel task workspace",
    promptGuidelines: [
      "Call kernel_init once per task, before kernel_contract.",
      "Fill docs/draft.md and docs/plan.md with real content; kernel_contract refuses placeholders and empty sections.",
      "Write the draft before proposing implementation. A task with no measured baseline gets no candidates.",
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
      const root = resolveWorkspace(ctx.cwd, params.workspace);
      const result = initWorkspace(root);
      const validation = validateWorkspace(root);
      const paths = workspacePaths(root);

      const lines = [
        `Kernel task workspace: ${root}`,
        result.created.length > 0 ? `created: ${result.created.join(", ")}` : "created: nothing",
        result.existing.length > 0 ? `kept existing: ${result.existing.join(", ")}` : "kept existing: none",
        `contract will live at ${paths.contract}`,
      ];

      if (!validation.ok) {
        lines.push(
          "",
          "Draft/plan sections still need real content before a contract can be frozen:",
          formatWorkspaceIssues(validation),
        );
      } else {
        lines.push("", "Draft and plan look complete enough to freeze a contract.");
      }

      const git = await pi.exec("git", ["rev-parse", "--show-toplevel"], { cwd: root, timeout: 15_000 });
      if (git.code !== 0) {
        lines.push("", "warning: not a git repository. pi-goal needs git to commit keeps and revert rejects.");
      }

      if (fs.existsSync(paths.baseline)) {
        lines.push("", `baseline already recorded at ${paths.baseline}; goal.sh will compare against it.`);
      }

      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
        details: { root, created: result.created, existing: result.existing, workspaceReady: validation.ok },
      };
    },
  });
}
