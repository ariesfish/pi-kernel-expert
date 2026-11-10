import type { ExecResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { bool, num, obj, opt, str } from "@earendil-works/pi-schema";
import * as fs from "node:fs";
import * as path from "node:path";

import { agentLayout } from "../support/paths.ts";

const MAX_OUTPUT_CHARS = 12_000;

export interface WikiParams {
  query?: string;
  page?: string;
  tag?: string;
  type?: string;
  repo?: string;
  architecture?: string;
  symptom?: string;
  language?: string;
  confidence?: string;
  limit?: number;
  compact?: boolean;
  paths_only?: boolean;
  follow_sources?: boolean;
}

export type WikiInvocation =
  | { script: "query.mjs"; args: string[] }
  | { script: "get_page.mjs"; args: string[] }
  | { error: string };

const ParamsSchema = obj({
  query: opt(str({ description: "Natural-language search, e.g. 'fuse gate-up dual GEMM on Blackwell'" })),
  page: opt(str({ description: "Page id or path to fetch, e.g. kernel-flash-attention-4" })),
  tag: opt(str()),
  type: opt(str({ description: "page type: hardware, technique, pattern, kernel, language, migration, source-pr, ..." })),
  repo: opt(str({ description: "upstream repository, e.g. cutlass" })),
  architecture: opt(str({ description: "sm90, sm100, B200, H100, ..." })),
  symptom: opt(str()),
  language: opt(str({ description: "cuda-cpp, cute-dsl, ptx, triton" })),
  confidence: opt(str()),
  limit: opt(num({ description: "1-50 results" })),
  compact: opt(bool({ description: "Compact output. Default: true." })),
  paths_only: opt(bool()),
  follow_sources: opt(bool({ description: "With page: expand cited sources." })),
});

export function buildWikiInvocation(params: WikiParams): WikiInvocation {
  const hasQuery = typeof params.query === "string" && params.query.trim() !== "";
  const hasPage = typeof params.page === "string" && params.page.trim() !== "";

  if (hasQuery && hasPage) return { error: "pass either query or page, not both" };
  if (!hasQuery && !hasPage) return { error: "pass a query (search) or a page id (fetch one page)" };

  if (hasPage) {
    const args = [params.page!.trim()];
    if (params.follow_sources) args.push("--follow-sources");
    return { script: "get_page.mjs", args };
  }

  const args: string[] = [params.query!.trim()];
  const filters: Array<[string, string | undefined]> = [
    ["--tag", params.tag],
    ["--type", params.type],
    ["--repo", params.repo],
    ["--architecture", params.architecture],
    ["--symptom", params.symptom],
    ["--language", params.language],
    ["--confidence", params.confidence],
  ];
  for (const [flag, value] of filters) {
    const trimmed = value?.trim();
    if (trimmed) args.push(flag, trimmed);
  }
  if (params.limit !== undefined) {
    if (!Number.isInteger(params.limit) || params.limit < 1 || params.limit > 50) {
      return { error: "limit must be an integer between 1 and 50" };
    }
    args.push("--limit", String(params.limit));
  }
  if (params.paths_only) args.push("--paths-only");
  if (params.compact !== false) args.push("--compact");
  return { script: "query.mjs", args };
}

export function formatWikiResult(options: {
  invocation: { script: string; args: string[] };
  result: ExecResult;
}): string {
  const command = ["node", `scripts/${options.invocation.script}`, ...options.invocation.args].join(" ");
  const body = options.result.stdout.trim();
  const capped =
    body.length > MAX_OUTPUT_CHARS
      ? `${body.slice(0, MAX_OUTPUT_CHARS)}\n… output truncated at ${MAX_OUTPUT_CHARS} chars`
      : body;
  const lines = [`$ ${command}`];
  if (options.result.code === 0 && capped) lines.push(capped);
  if (options.result.code !== 0) {
    lines.push(`exit code ${options.result.code}${options.result.killed ? " (killed)" : ""}`);
    const error = [options.result.stderr, capped].filter(Boolean).join("\n").trim();
    if (error) lines.push(error.slice(-2000));
    lines.push("The corpus is present but this query failed; report the command and the error.");
  }
  if (options.result.code === 0 && !capped) lines.push("(no matches)");
  return lines.join("\n");
}

export function registerWikiTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "kernel_wiki",
    label: "Query kernel-wiki",
    description:
      "Query the cached kernel-wiki corpus: natural-language search with filters, or fetch one page by id. Returns page ids, paths, and confidence labels to cite in a plan or diagnosis.",
    promptSnippet: "Query the kernel-wiki kernel knowledge base",
    promptGuidelines: [
      "Cite the page id and its confidence label; never present an inferred or experimental page as verified.",
      "One query per bottleneck or technique question; do not read the whole corpus into context.",
      "A measurement never comes from this tool; measurements come from the target machine only.",
    ],
    parameters: ParamsSchema,
    async execute(
      _toolCallId,
      rawParams,
      signal,
    ): Promise<{ content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> }> {
      const params = rawParams as WikiParams;
      const invocation = buildWikiInvocation(params);
      if ("error" in invocation) {
        return { content: [{ type: "text" as const, text: invocation.error }], details: {} };
      }

      const layout = agentLayout();
      const wikiDir = layout.kernelWikiDir;
      if (!fs.existsSync(path.join(wikiDir, "SKILL.md"))) {
        return {
          content: [{
            type: "text" as const,
            text: `kernel-wiki is not cached at ${wikiDir}. Run kernel_bootstrap, then /reload.`,
          }],
          details: {},
        };
      }
      // Use the interpreter running pi, not whatever `node` PATH resolves to.
      const result = await pi.exec(
        process.execPath,
        [`scripts/${invocation.script}`, ...invocation.args],
        { cwd: wikiDir, timeout: 120_000, signal },
      );
      return {
        content: [{ type: "text" as const, text: formatWikiResult({ invocation, result }) }],
        details: { script: invocation.script, exit: result.code },
      };
    },
  });
}
