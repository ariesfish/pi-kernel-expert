import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import {
  formatKnowledgeReport,
  inspectKnowledge,
  knowledgeSummary,
} from "../support/knowledge.ts";
import { agentLayout, packageRootFrom } from "../support/paths.ts";

const PACKAGE_ROOT = packageRootFrom(import.meta.url);

export function registerStatusCommand(pi: ExtensionAPI): void {
  pi.registerCommand("kernel-expert", {
    description:
      "Show pi-kernel-expert status: loop engine, vendored ncu skill, KernelWiki cache",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const report = inspectKnowledge({ packageRoot: PACKAGE_ROOT, layout: agentLayout() });
      ctx.ui.notify(formatKnowledgeReport(report), "info");
    },
  });
}

export function statusLine(): string {
  const report = inspectKnowledge({ packageRoot: PACKAGE_ROOT, layout: agentLayout() });
  return knowledgeSummary(report);
}
