import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as path from "node:path";
import { Type } from "typebox";

import { cite, readKbTree, validateIndexes } from "../kernel/kb.ts";
import { lintKb, readReferenceTokens } from "../kernel/kb-lint.ts";

export function registerKbTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "kernel_kb",
    label: "Cite, lint or index the local KB",
    description:
      "The workspace's own knowledge base, `kb/<arch>/<entry>.md`, with a symptom index per arch. `cite` emits `KB:<entry>` only for an entry that claims a run — certification source, a MEASURED <gpu> <date> status, a certification boundary, and a fenced command — and otherwise refuses, naming what is missing: a transcribed recipe is not a price. `lint` runs five rules (upstream reference tokens, line references a reader cannot open, session narrative, a missing arch index, a claim that outruns its evidence) and fails closed when there is no kb/ tree. `index` validates the symptom ledger — every entry has exactly one row, every row points at an entry, statuses agree — and never generates it, because the symptom phrase is the judgment.",
    promptSnippet: "Cite a KB entry as a price, lint the kb/ tree, or validate its index",
    promptGuidelines: [
      "`cite` before writing `[PRICED: <delta>, KB:<entry>]`. A price a gate line cites has to be a measurement somebody made on a card at a time; an UNVERIFIED entry is a direction.",
      "An entry grows a certification header (source, covers, uncertified) and a `## Certification boundary` section even when the boundary is `we never ran this on sm120` — the boundary is what makes the claim usable.",
      "Statuses are three: `MEASURED <gpu> <yyyy-mm-dd>`, `UNVERIFIED — <what is missing>`, `TODO`. Only the first can be cited.",
      "`lint` before adding an entry: an exact upstream symbol is a retrieval key into pretraining memory, and a line reference nobody can open is a claim nobody can check.",
      "The index is a symptom ledger, not a table of contents: the row's first column is an observable a reader has just seen (`a_reg` is 0 while the budget is the constraint), never a topic.",
    ],
    parameters: Type.Object({
      action: Type.Union([Type.Literal("cite"), Type.Literal("lint"), Type.Literal("index")], {
        description: "What to do.",
      }),
      entry: Type.Optional(Type.String({ description: "For `cite`: the entry id." })),
      workspace: Type.Optional(Type.String({ description: "Task workspace. Default: current directory." })),
    }),
    async execute(
      _toolCallId,
      params,
      _signal,
      _onUpdate,
      ctx,
    ): Promise<{ content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> }> {
      const workspace = params.workspace ? path.resolve(ctx.cwd, params.workspace) : ctx.cwd;
      const tree = readKbTree(workspace);

      if (params.action === "cite") {
        const id = (params.entry ?? "").trim();
        if (id === "") {
          return {
            content: [{ type: "text" as const, text: "kernel_kb cite needs an entry id: the token it emits is KB:<id>." }],
            details: { ok: false, refusals: [{ rule: "kb-entry-required" }] },
          };
        }
        const result = cite(tree, id);
        if (!result.ok) {
          return {
            content: [{ type: "text" as const, text: [`${result.rule}: ${result.reason}`, `Fix: ${result.fix}`].join("\n") }],
            details: { ok: false, refusals: [result] },
          };
        }
        return {
          content: [
            {
              type: "text" as const,
              text: [
                `${result.token}`,
                `${result.entry.path} — ${result.entry.statusRaw}`,
                `Cite it as \`[PRICED: <delta>, ${result.token}]\` on a \`[VERIFY: sass-derived]\` gate line, where <delta> is the entry's own measured footprint, not the number you are hoping for.`,
              ].join("\n"),
            },
          ],
          details: { ok: true, token: result.token, entry: result.entry.path },
        };
      }

      if (params.action === "lint") {
        const report = lintKb(workspace, tree, { referenceTokens: readReferenceTokens(workspace) });
        const header = [report.findings.length === 0 ? "lint clean." : `lint: ${report.findings.length} finding(s).`];
        header.push(`scanned ${report.scanned.length} file(s)${report.scanned.length === 0 ? " — nothing was scanned, which is a finding, not a pass" : `: ${report.scanned.join(", ")}`}`);
        for (const finding of report.findings) {
          header.push(`${finding.rule} ${finding.where}: ${finding.why}`);
          header.push(`  Fix: ${finding.fix}`);
        }
        return {
          content: [{ type: "text" as const, text: header.join("\n") }],
          details: { ok: report.findings.length === 0, findings: report.findings, scanned: report.scanned },
        };
      }

      const problems =
        tree === null
          ? [{ rule: "kb-absent", what: `there is no kb/ tree in ${workspace}`, fix: "create kb/<arch>/index.md" }]
          : validateIndexes(tree);
      if (problems.length === 0 && tree !== null) {
        const covered = tree.indexes.map((index) => `${index.arch}: ${index.rows.length} row(s)`).join(", ");
        return {
          content: [{ type: "text" as const, text: `index valid: ${tree.entries.length} entry(ies), ${covered || "no index"}.` }],
          details: { ok: true, entries: tree.entries.length, indexes: tree.indexes.length },
        };
      }
      return {
        content: [
          {
            type: "text" as const,
            text: [
              `index: ${problems.length} problem(s).`,
              ...problems.flatMap((problem) => [`${problem.rule}: ${problem.what}`, `  Fix: ${problem.fix}`]),
            ].join("\n"),
          },
        ],
        details: { ok: false, findings: problems },
      };
    },
  });
}

/** Used by the plan module's `[PRICED:]` resolver: the same predicate, one home. */
export function kbCitationCheck(workspace: string, id: string): string | null {
  const result = cite(readKbTree(workspace), id);
  return result.ok ? null : result.reason;
}
