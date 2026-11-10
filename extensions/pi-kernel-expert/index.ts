/**
 * pi-kernel-expert — pi extension.
 *
 * This file is the composition root. Kernel work runs on pi-goal's
 * frozen-contract loop: this package contributes knowledge, evidence, and the
 * generated scripts that make kernel criteria executable. It deliberately owns
 * no phase machine and no gate of its own.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { planKernelWikiRegistration } from "./knowledge/registration.ts";
import { agentLayout } from "./support/paths.ts";
import { registerBootstrapTool } from "./tools/bootstrap.ts";
import { registerCandidateTool } from "./tools/candidate.ts";
import { registerContractTool } from "./tools/contract.ts";
import { registerInitTool } from "./tools/init.ts";
import { registerMilestoneTool } from "./tools/milestone.ts";
import { registerKbTool } from "./tools/kb.ts";
import { registerSassTool } from "./tools/sass.ts";
import { registerProfileTool } from "./tools/profile.ts";
import { registerStatusCommand } from "./tools/status.ts";
import { registerWikiCandidateTool } from "./tools/wiki-candidate.ts";
import { registerWikiTool } from "./tools/wiki.ts";

export default function kernelExpertExtension(pi: ExtensionAPI): void {
  registerStatusCommand(pi);
  registerBootstrapTool(pi);
  registerWikiTool(pi);
  registerWikiCandidateTool(pi);
  registerInitTool(pi);
  registerContractTool(pi);
  registerProfileTool(pi);
  registerCandidateTool(pi);
  registerMilestoneTool(pi);
  registerSassTool(pi);
  registerKbTool(pi);

  pi.on("resources_discover", async (event, ctx) => {
    const plan = planKernelWikiRegistration({ cwd: event.cwd, layout: agentLayout() });
    if (plan.conflict && ctx.hasUI) {
      ctx.ui.notify(
        `KernelWiki is already installed at ${plan.conflict.path} (${plan.conflict.label}); pi-kernel-expert will not register its cached copy.`,
        "warning",
      );
    }
    return plan.skillPaths.length > 0 ? { skillPaths: plan.skillPaths } : {};
  });
}
