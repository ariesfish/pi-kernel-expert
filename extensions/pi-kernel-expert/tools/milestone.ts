import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import { Type } from "typebox";

import {
  MILESTONE_RELATIVE_PATH,
  formatMilestoneProblems,
  formatMilestoneSummary,
  parseMilestone,
  renderMilestone,
  validateMilestone,
} from "../kernel/milestone.ts";

export function registerMilestoneTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "kernel_milestone",
    label: "Validate Kernel Milestone",
    description:
      "Read docs/milestone.md and validate it as an addressable plan: the seven sections, the phases M0..Mk and their order, every decision's five-tuple (Action, Purpose, Trigger, Cost, Depends on) with its ⇐/⊗/⇒ edges, the typed gate lines under each ### M<k> Gate, and the dead-end rows. Reports every refusal in one pass, each starting with the rule id and the row it is charged to (route-missing-key, route-dangling-dep, route-id-is-gate, route-placeholder, gate-verify-none, gate-sass-unpriced, gate-no-mechanism-line, trigger-is-category, phase-order), with the fix. Never writes the file.",
    promptSnippet: "Validate docs/milestone.md and list its phases, decisions and gate lines",
    promptGuidelines: [
      "Write the milestone yourself; this tool validates it. It never edits, repairs, or generates the plan.",
      "A decision is `#### D<m>.<n> <name>` plus exactly five `- Key: value` lines: Action, Purpose, Trigger, Cost, Depends on. `Depends on` uses ⇐ upstream, ⊗ companion, ⇒ downstream, comma separated, or `none`.",
      "A trigger is an observable, never a category: `waves/SM < 1 on the reference` passes, `optimize` and `when needed` are refused.",
      "Every gate line under `### M<k> Gate` carries one [VERIFY: ncu-direct | ncu-derived | sass-derived | correctness | mechanism] plus its pointer; `[VERIFY: none]` is refused, and `sass-derived` needs `[PRICED: <delta>, <source>]` on the same line.",
      "Fix every refusal in one edit: the validator reports all of them at once, so re-running after each single fix spends the loop learning nothing.",
    ],
    parameters: Type.Object({
      path: Type.Optional(
        Type.String({ description: `Milestone file. Default: ${MILESTONE_RELATIVE_PATH} under the workspace.` }),
      ),
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
      const file = params.path ? path.resolve(workspace, params.path) : path.join(workspace, MILESTONE_RELATIVE_PATH);
      const label = path.relative(workspace, file) || file;

      let text: string;
      try {
        text = fs.readFileSync(file, "utf8");
      } catch {
        return {
          content: [
            {
              type: "text" as const,
              text: `No milestone at ${label}. The plan is ${MILESTONE_RELATIVE_PATH}: write it before validating; this tool reads, it never writes.`,
            },
          ],
          details: { path: file, refusals: [] },
        };
      }

      const { model, problems: parseProblems } = parseMilestone(text);
      if (renderMilestone(model) !== text) {
        // Unreachable unless the model stopped being a view over the file; refuse
        // loudly rather than hand back a summary of a document nobody wrote.
        return {
          content: [{ type: "text" as const, text: `Cannot read ${label} losslessly; the model does not round-trip.` }],
          details: { path: file, refusals: [] },
        };
      }

      const problems = validateMilestone(model, {});
      if (problems.length > 0 || parseProblems.length > 0) {
        const all = problems.length > 0 ? problems : parseProblems;
        return {
          content: [
            {
              type: "text" as const,
              text: [
                `${label} — refused: ${all.length} problem(s), each with the rule, the row, and the fix:`,
                formatMilestoneProblems(all),
              ].join("\n"),
            },
          ],
          details: { path: file, refusals: all, ok: false },
        };
      }

      return {
        content: [{ type: "text" as const, text: [`${label} — clean.`, formatMilestoneSummary(model)].join("\n") }],
        details: {
          path: file,
          ok: true,
          refusals: [],
          phases: model.phases.map((phase) => ({ id: phase.id, name: phase.name, kind: phase.kind })),
          decisions: model.decisions.map((decision) => ({ id: decision.id, name: decision.name, phase: decision.phase })),
          gates: model.gates.map((gate) => ({
            phase: gate.phase,
            lines: gate.lines.map((line) => ({ row: line.row, verify: line.verify, pointer: line.pointer })),
          })),
          deadEnds: model.deadEnds.length,
        },
      };
    },
  });
}
