import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import { Type } from "typebox";

import { agentLayout } from "../support/paths.ts";
import { type CorpusIndex, readCorpusIndex } from "../kernel/corpus-index.ts";
import type { KernelContract } from "../kernel/contract.ts";
import { kbCitationCheck } from "./kb.ts";
import {
  MILESTONE_LOCK_RELATIVE_PATH,
  type MilestoneLock,
  deadEndRow,
  formatMilestoneLock,
  m0ContractBlock,
  milestoneSha,
  parseMilestoneLock,
} from "../kernel/milestone-lock.ts";
import {
  MILESTONE_RELATIVE_PATH,
  type MilestoneModel,
  formatMilestoneProblems,
  formatMilestoneSummary,
  isPlaceholder,
  parseMilestone,
  renderMilestone,
  validateMilestone,
} from "../kernel/milestone.ts";

/** A reason short enough to be a shrug is not a reason. */
const MIN_UNLOCK_REASON = 16;

type ToolResult = { content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> };

function refusal(rule: string, text: string, details: Record<string, unknown> = {}): ToolResult {
  return {
    content: [{ type: "text" as const, text: `${rule}: ${text}` }],
    details: { ok: false, refusals: [{ rule, text }], ...details },
  };
}

/** The runs under `profile/` that hold a summary: a pointer resolves to one of these. */
function readProfileRunIds(workspace: string): string[] {
  const dir = path.join(workspace, "profile");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(dir, entry.name, "summary.json")))
    .map((entry) => entry.name)
    .sort();
}

/** The workspace contract as written; `null` when absent or unreadable. */
function readWorkspaceContract(workspace: string): KernelContract | null {
  const file = path.join(workspace, "kernel.contract.json");
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as KernelContract;
  } catch {
    return null;
  }
}

/**
 * The pinned corpus, or `null` when it is not cached. `null` is passed on as a
 * fact — "the corpus was looked for and is not there" — so a citation can be
 * reported as unresolved-by-absence rather than quietly accepted.
 */
function readCorpus(): CorpusIndex | null {
  try {
    return readCorpusIndex(agentLayout().kernelWikiDir, "");
  } catch {
    return null;
  }
}

/**
 * Open a diagnosis citation against the workspace. This is where the rule stops
 * being shape and starts being checkable: a file that is not there, a line past
 * the end, an anchor that does not appear. A citation nobody can follow is worse
 * than none, because it reads like evidence.
 */
function citationResolver(workspace: string) {
  return (ref: { raw: string; path: string; line: number | null; anchor: string | null }): string | null => {
    const target = path.resolve(workspace, ref.path);
    const relative = path.relative(workspace, target);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      return `${ref.path} is outside the workspace`;
    }
    let text: string;
    try {
      text = fs.readFileSync(target, "utf8");
    } catch {
      return `there is no ${ref.path} in this workspace`;
    }
    if (ref.line !== null) {
      const lines = text.split("\n");
      // A trailing newline makes split() one longer than the last addressable line.
      const count = lines.length > 1 && lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;
      if (ref.line < 1 || ref.line > count) {
        return `${ref.path} has ${count} line(s); line ${ref.line} is past the end`;
      }
      if (lines[ref.line - 1].trim() === "") {
        return `${ref.path}:${ref.line} is blank`;
      }
      return null;
    }
    if (!text.includes(ref.anchor ?? "")) {
      return `${ref.path} contains no ${JSON.stringify(ref.anchor)}`;
    }
    return null;
  };
}

/** A lock file that exists but does not parse is a bypass, not an unlocked milestone. */
function readLock(file: string): { lock: MilestoneLock | null; broken: boolean } {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return { lock: null, broken: false };
  }
  const lock = parseMilestoneLock(text);
  return { lock, broken: lock === null };
}

/** The line after which an unlock's row belongs: the last non-blank line of `## 4. Dead Ends`. */
function deadEndInsertion(model: MilestoneModel, label: string): number | string {
  const section = model.sections.find((entry) => /dead\s*end/i.test(entry.title));
  if (!section) {
    return `no ## 4. Dead Ends section in ${label}, and an unlock is recorded there or not at all. Add the section (the seven-section format needs it) and unlock again.`;
  }
  let last = section.start;
  for (let index = section.start + 1; index < section.end; index += 1) {
    if (model.lines[index].trim() !== "") last = index;
  }
  return last + 1;
}

export function registerMilestoneTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "kernel_milestone",
    label: "Validate Kernel Milestone",
    description:
      "Read docs/milestone.md and validate it as an addressable plan: the seven sections, the phases M0..Mk and their order, every decision's five-tuple (Action, Purpose, Trigger, Cost, Depends on) with its ⇐/⊗/⇒ edges, the typed gate lines under each ### M<k> Gate, and the dead-end rows. Reports every refusal in one pass, each starting with the rule id and the row it is charged to (route-missing-key, route-dangling-dep, route-id-is-gate, route-placeholder, gate-verify-none, gate-sass-unpriced, gate-no-mechanism-line, trigger-is-category, phase-order, m0-thawed, diagnosis-missing-field, diagnosis-class, diagnosis-decision, diagnosis-measurement, diagnosis-citation), with the fix. With lock: true it freezes the ### M0 Contract block in .kernel/milestone.lock.json; with unlock: true and a reason it thaws the block and appends that reason to ## 4. Dead Ends. Never writes the milestone except to record an unlock.",
    promptSnippet: "Validate docs/milestone.md, freeze its M0 contract, or record an unlock",
    promptGuidelines: [
      "Write the milestone yourself; this tool validates it and freezes it. It never repairs or generates the plan.",
      "A decision is `#### D<m>.<n> <name>` plus exactly five `- Key: value` lines: Action, Purpose, Trigger, Cost, Depends on. `Depends on` uses ⇐ upstream, ⊗ companion, ⇒ downstream, comma separated, or `none`.",
      "A trigger is an observable, never a category: `waves/SM < 1 on the reference` passes, `optimize` and `when needed` are refused.",
      "Every gate line under `### M<k> Gate` carries one [VERIFY: ncu-direct | ncu-derived | sass-derived | correctness | mechanism] plus its pointer; `[VERIFY: none]` is refused, and `sass-derived` needs `[PRICED: <delta>, <source>]` on the same line.",
      "`### M0 Contract` holds one `- <item>: <value>` line per frozen choice (tile, smem, warp roles, register budget, issue order, accumulator precision). Lock it once the block is right: `lock: true`. After that the block is byte-identical or the file is refused as m0-thawed, and the ways out are restoring the block or `unlock: true` with a reason, which lands in Dead Ends as a diagnosis.",
      "At a plateau, write a `### Diagnosis <id>` block instead of another candidate: four lines — `class` (missing-decision, wrong-decision, measurement-defect, environment), `decision` (the id to add or change), `measurement` (the cheapest test that tells the causes apart), `abandon` (what to stop doing), and `citations` (at least three `path:line` or `path#anchor` references the claims rest on — they are opened, and a file that is not there or a line past the end is refused). `measurement` must carry one command in backticks plus the outcomes it separates. Add `- self-diagnosis: <why>` when no reviewer was available. The block is validated by shape and never gates.",
      "Fix every refusal in one edit: the validator reports all of them at once, so re-running after each single fix spends the loop learning nothing.",
    ],
    parameters: Type.Object({
      path: Type.Optional(
        Type.String({ description: `Milestone file. Default: ${MILESTONE_RELATIVE_PATH} under the workspace.` }),
      ),
      workspace: Type.Optional(Type.String({ description: "Task workspace. Default: current directory." })),
      lock: Type.Optional(
        Type.Boolean({
          description:
            "Freeze the ### M0 Contract block in .kernel/milestone.lock.json. Refused when the file has refusals, or when a lock exists and the block has changed.",
        }),
      ),
      unlock: Type.Optional(
        Type.Boolean({
          description:
            "Thaw a frozen M0 block. Requires reason; the reason is appended to ## 4. Dead Ends and the lock is removed.",
        }),
      ),
      reason: Type.Optional(
        Type.String({
          description: `Why M0 may change, in one sentence. Required by unlock, at least ${MIN_UNLOCK_REASON} characters, recorded verbatim.`,
        }),
      ),
    }),
    async execute(
      _toolCallId,
      params,
      _signal,
      _onUpdate,
      ctx,
    ): Promise<ToolResult> {
      const workspace = params.workspace ? path.resolve(ctx.cwd, params.workspace) : ctx.cwd;
      const file = params.path ? path.resolve(workspace, params.path) : path.join(workspace, MILESTONE_RELATIVE_PATH);
      const label = path.relative(workspace, file) || file;
      const lockFile = path.join(workspace, MILESTONE_LOCK_RELATIVE_PATH);

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

      if (params.lock && params.unlock) {
        return refusal("lock-and-unlock", "lock and unlock are opposite acts; ask for one of them.");
      }

      const { lock, broken } = readLock(lockFile);
      if (broken) {
        return refusal(
          "lock-unreadable",
          `${MILESTONE_LOCK_RELATIVE_PATH} exists but is not a lock this tool wrote, so the freeze cannot be checked and an edit would pass as unlocked. Restore the file from git, or delete it deliberately if the freeze was meant to be dropped (and record why in ## 4. Dead Ends).`,
          { path: file, lockFile },
        );
      }

      if (params.unlock) {
        if (!lock) {
          return refusal("no-lock", `${label} is not locked, so there is nothing to unlock (no ${MILESTONE_LOCK_RELATIVE_PATH}).`);
        }
        const reason = (params.reason ?? "").trim();
        if (reason === "" || isPlaceholder(reason) || reason.length < MIN_UNLOCK_REASON) {
          return refusal(
            "unlock-reason",
            `unlock needs a reason of at least ${MIN_UNLOCK_REASON} characters saying what changed and why M0 may move now. Got ${JSON.stringify(params.reason ?? "")}. The reason is appended to ## 4. Dead Ends: a thaw nobody can read later is indistinguishable from an accident.`,
            { path: file },
          );
        }
        const insertion = deadEndInsertion(model, label);
        if (typeof insertion === "string") return refusal("no-dead-ends", insertion, { path: file });

        const row = deadEndRow(reason, lock.m0ContractSha);
        const lines = [...model.lines];
        lines.splice(insertion, 0, row);
        fs.writeFileSync(file, lines.join("\n"), "utf8");
        fs.rmSync(lockFile);
        return {
          content: [
            {
              type: "text" as const,
              text: [
                `${label} — unlocked. The M0 freeze at ${lock.m0ContractSha.slice(0, 12)} is gone and the block may change.`,
                `Recorded in ## 4. Dead Ends: ${row}`,
                `Re-lock with lock: true once the new block holds; until then every candidate's milestoneSha points at a plan with no freeze.`,
              ].join("\n"),
            },
          ],
          details: { path: file, ok: true, refusals: [], unlocked: { reason, at: lock.lockedAt, sha: lock.m0ContractSha } },
        };
      }

      const corpus = readCorpus();
      const problems = validateMilestone(model, {
        lock,
        contract: readWorkspaceContract(workspace) ?? null,
        profileRunIds: readProfileRunIds(workspace),
        corpus,
        citationResolver: citationResolver(workspace),
        kbResolver: (id) => kbCitationCheck(workspace, id),
      });
      const refusals = problems.filter((problem) => problem.severity === "refusal");
      const warnings = problems.filter((problem) => problem.severity === "warning");
      const warningBlock =
        warnings.length === 0
          ? []
          : [`${warnings.length} warning(s), recorded and not refused:`, formatMilestoneProblems(warnings)];

      if (refusals.length > 0 || parseProblems.length > 0) {
        const all = refusals.length > 0 ? refusals : parseProblems;
        return {
          content: [
            {
              type: "text" as const,
              text: [
                `${label} — refused: ${all.length} problem(s), each with the rule, the row, and the fix:`,
                formatMilestoneProblems(all),
                ...warningBlock,
              ].join("\n"),
            },
          ],
          details: { path: file, refusals: all, warnings, ok: false, corpus: corpus === null ? null : corpus.pages.length },
        };
      }

      if (params.lock) {
        const block = m0ContractBlock(model);
        if (!block) {
          return refusal(
            "m0-contract-missing",
            `there is no ### M0 Contract block in ${label}, so there is nothing to freeze. Add it above ### M0 Architecture with one \`- <item>: <value>\` line per choice (tile, smem, warp roles, register budget, issue order, accumulator precision), then lock again.`,
            { path: file },
          );
        }
        const blockText = block.lines.join("\n");
        const next: MilestoneLock = {
          version: 1,
          milestoneSha: milestoneSha(text),
          m0ContractSha: milestoneSha(blockText),
          lockedAt: new Date().toISOString(),
          m0Contract: blockText,
        };
        fs.mkdirSync(path.dirname(lockFile), { recursive: true });
        fs.writeFileSync(lockFile, formatMilestoneLock(next), "utf8");
        const relocked = lock ? ` The earlier freeze (${lock.m0ContractSha.slice(0, 12)}) was byte-identical, so nothing was thawed; the milestone sha moved to ${next.milestoneSha.slice(0, 12)}.` : "";
        return {
          content: [
            {
              type: "text" as const,
              text: [
                `${label} — locked: M0 Contract frozen at ${next.m0ContractSha.slice(0, 12)} (${block.items.length} items: ${block.items.map((item) => item.key).join(", ")}).${relocked}`,
                `File sha ${next.milestoneSha.slice(0, 12)}, recorded in ${MILESTONE_LOCK_RELATIVE_PATH}. An edit inside the block is now refused as m0-thawed; changing M0 on purpose needs unlock: true with a reason, which lands in Dead Ends.`,
              ].join("\n"),
            },
          ],
          details: { path: file, ok: true, refusals: [], lock: next, items: block.items },
        };
      }

      const lockNote = lock
        ? `M0 Contract frozen at ${lock.m0ContractSha.slice(0, 12)} since ${lock.lockedAt}; unchanged.`
        : `No M0 lock (${MILESTONE_LOCK_RELATIVE_PATH} absent): the block may still change. Lock it with lock: true.`;
      return {
        content: [
          {
            type: "text" as const,
            text: [`${label} — clean.`, lockNote, ...warningBlock, formatMilestoneSummary(model)].join("\n"),
          },
        ],
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
          diagnoses: model.diagnoses.map((entry) => ({
            id: entry.id,
            class: entry.rows.find((row) => row.key.toLowerCase() === "class")?.value ?? null,
            decision: entry.rows.find((row) => row.key.toLowerCase() === "decision")?.value ?? null,
          })),
          warnings,
          corpus: corpus === null ? null : corpus.pages.length,
          lock: lock ? { sha: lock.m0ContractSha, lockedAt: lock.lockedAt } : null,
        },
      };
    },
  });
}
