import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { fetchPinnedCorpus, formatFetchResult } from "../knowledge/fetch.ts";
import { KERNEL_WIKI_PIN, agentLayout } from "../support/paths.ts";

export function registerBootstrapTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "kernel_bootstrap",
    label: "Bootstrap kernel-wiki",
    description:
      "Fetch the pinned kernel-wiki corpus into the pi agent cache, verify its revision, and report whether it is ready to register. Refuses to overwrite an existing tree at a different revision.",
    promptSnippet: "Fetch the pinned kernel-wiki corpus",
    promptGuidelines: [
      "Call kernel_bootstrap when a kernel task needs Blackwell/Hopper reference material and the kernel-wiki corpus is not cached.",
      "After an install, ask the human to run /reload so the fetched skill is registered.",
      "A refused fetch is a finding: report the reason and the current revision, never retry with a different revision.",
    ],
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, signal) {
      const layout = agentLayout();
      const result = await fetchPinnedCorpus({
        pin: KERNEL_WIKI_PIN,
        targetDir: layout.kernelWikiDir,
        exec: pi,
        signal,
      });
      return {
        content: [{ type: "text" as const, text: formatFetchResult(result) }],
        details: {
          state: result.state,
          revision: result.revision,
          path: result.path,
        },
      };
    },
  });
}
