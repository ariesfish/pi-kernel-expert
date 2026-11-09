import type { ExecResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import { Type } from "typebox";

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
  | { script: "query.py"; args: string[] }
  | { script: "get_page.py"; args: string[] }
  | { error: string };

export function buildWikiInvocation(params: WikiParams): WikiInvocation {
  const hasQuery = typeof params.query === "string" && params.query.trim() !== "";
  const hasPage = typeof params.page === "string" && params.page.trim() !== "";

  if (hasQuery && hasPage) return { error: "pass either query or page, not both" };
  if (!hasQuery && !hasPage) return { error: "pass a query (search) or a page id (fetch one page)" };

  if (hasPage) {
    const args = [params.page!.trim()];
    if (params.follow_sources) args.push("--follow-sources");
    return { script: "get_page.py", args };
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
  return { script: "query.py", args };
}

export function formatWikiResult(options: {
  invocation: { script: string; args: string[] };
  result: ExecResult;
}): string {
  const command = ["python3", `scripts/${options.invocation.script}`, ...options.invocation.args].join(" ");
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
    parameters: Type.Object({
      query: Type.Optional(Type.String({ description: "Natural-language search, e.g. 'fuse gate-up dual GEMM on Blackwell'" })),
      page: Type.Optional(Type.String({ description: "Page id or path to fetch, e.g. kernel-flash-attention-4" })),
      tag: Type.Optional(Type.String()),
      type: Type.Optional(Type.String({ description: "page type: hardware, technique, pattern, kernel, language, migration, source-pr, ..." })),
      repo: Type.Optional(Type.String({ description: "upstream repository, e.g. cutlass" })),
      architecture: Type.Optional(Type.String({ description: "sm90, sm100, B200, H100, ..." })),
      symptom: Type.Optional(Type.String()),
      language: Type.Optional(Type.String({ description: "cuda-cpp, cute-dsl, ptx, triton" })),
      confidence: Type.Optional(Type.String()),
      limit: Type.Optional(Type.Number({ description: "1-50 results" })),
      compact: Type.Optional(Type.Boolean({ description: "Compact output. Default: true." })),
      paths_only: Type.Optional(Type.Boolean()),
      follow_sources: Type.Optional(Type.Boolean({ description: "With page: expand cited sources." })),
    }),
    async execute(
      _toolCallId,
      params,
      signal,
    ): Promise<{ content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> }> {
      const invocation = buildWikiInvocation(params as WikiParams);
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
      const result = await pi.exec(
        "python3",
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
