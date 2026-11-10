import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { arr, obj, oneOf, opt, str, type Static } from "@earendil-works/pi-schema";
import * as fs from "node:fs";
import * as path from "node:path";

import { readContract } from "../kernel/candidates.ts";
import {
  CONFIDENCE_VALUES,
  ENTRY_TYPES,
  formatEntryProblems,
  prefillFromWorkspace,
  readCandidateEntryIds,
  renderEntry,
  validateEntry,
  wikiCandidatesDir,
  type Confidence,
  type EntryType,
  type WikiEntryModel,
  type WikiEntryProblem,
  type WorkspacePrefill,
} from "../kernel/wiki-entry.ts";
import { readCorpusIndex } from "../kernel/corpus-index.ts";
import { agentLayout } from "../support/paths.ts";

/** Directories whose files an entry may not name — the task's own source and docs. */
const LEAK_SCAN_DIRS = ["docs", "src", "kernels", "tests"];

export interface WikiCandidateRequest {
  id: string;
  title: string;
  type: EntryType;
  mechanism: string;
  trigger: string;
  cost?: string;
  conditions: string;
  gotchas: string;
  negative?: string;
  /** The commands and raw numbers; required when confidence is verified. */
  reproduce?: string;
  tags?: string[];
  sources?: string[];
  confidence?: Confidence;
  /** Only needed when the workspace has no readable profile to derive it from. */
  architectures?: string[];
}

export interface WikiCandidateOptions extends WikiCandidateRequest {
  workspace: string;
  /** The fetched corpus. Default: `agentLayout().kernelWikiDir`. Never written. */
  corpusDir?: string;
}

export interface WikiCandidateNotes {
  /** `corpus-absent: …` when the cached corpus could not be read. */
  corpus: string;
  /** What the workspace supplied, and what it could not. */
  prefilled: string[];
  /** What a reviewer should still fix. */
  weak: string[];
}

export type WikiCandidateOutcome =
  | {
      ok: true;
      path: string;
      entry: WikiEntryModel;
      text: string;
      prefill: WorkspacePrefill;
      notes: WikiCandidateNotes;
    }
  | {
      ok: false;
      errors: string[];
      problems: WikiEntryProblem[];
      prefill: WorkspacePrefill;
      notes: WikiCandidateNotes;
    };

/**
 * Validate, then write `.kernel/wiki-candidates/<id>.md`. The corpus is read
 * (for `entry-id-taken`) and never written: publishing is a human `cp`.
 */
export function writeWikiCandidate(options: WikiCandidateOptions): WikiCandidateOutcome {
  const workspace = options.workspace;
  const prefill = prefillFromWorkspace({ workspace, sources: options.sources });

  const entry: WikiEntryModel = {
    id: options.id.trim(),
    title: options.title.trim(),
    type: options.type,
    architectures: supplied(options.architectures).length > 0 ? supplied(options.architectures) : prefill.architectures,
    tags: supplied(options.tags),
    confidence: options.confidence ?? prefill.confidence,
    sources: prefill.sources,
    mechanism: options.mechanism.trim(),
    trigger: options.trigger.trim(),
    cost: (options.cost ?? "").trim(),
    conditions: options.conditions.trim(),
    gotchas: options.gotchas.trim(),
    negative: (options.negative ?? "").trim(),
    reproduce: (options.reproduce ?? "").trim(),
  };

  const corpusPageIds = readCorpusPageIds(options.corpusDir ?? agentLayout().kernelWikiDir);
  const contractOutcome = readContract(workspace);
  const contract = contractOutcome.ok ? contractOutcome.contract : null;

  const problems = validateEntry(entry, {
    contract,
    candidateIds: prefill.candidateIds,
    profileRunIds: prefill.profileRunIds,
    contractSha: contractOutcome.ok ? contractOutcome.sha : null,
    workspaceFiles: workspaceFiles(workspace),
    corpusPageIds,
    wikiCandidateIds: readCandidateEntryIds(workspace),
  });

  const notes = buildNotes(entry, prefill, corpusPageIds);

  if (problems.length > 0) {
    return {
      ok: false,
      errors: formatEntryProblems(problems).split("\n"),
      problems,
      prefill,
      notes,
    };
  }

  const dir = wikiCandidatesDir(workspace);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${entry.id}.md`);
  const text = renderEntry(entry);
  fs.writeFileSync(file, text);

  return { ok: true, path: file, entry, text, prefill, notes };
}

export function formatWikiCandidateOutcome(outcome: WikiCandidateOutcome): string {
  const lines: string[] = [];

  if (!outcome.ok) {
    lines.push(`${outcome.errors.length} refusal(s); nothing was written:`);
    lines.push(...outcome.errors);
    lines.push("");
    lines.push(`corpus: ${outcome.notes.corpus}`);
    if (outcome.notes.weak.length > 0) {
      lines.push("weak:");
      for (const note of outcome.notes.weak) lines.push(`  - ${note}`);
    }
    lines.push(
      "Fix every refusal in one pass, then call kernel_wiki_candidate again; the corpus is never written by this tool.",
    );
    return lines.join("\n");
  }

  const { entry } = outcome;
  lines.push(`wrote ${outcome.path}`);
  lines.push(
    `${entry.id} | type ${entry.type} | confidence ${entry.confidence} | architectures ${entry.architectures.join(", ") || "(none)"}`,
  );
  lines.push(`sources: ${entry.sources.join(", ") || "(none)"}`);
  if (outcome.notes.prefilled.length > 0) {
    lines.push("pre-filled:");
    for (const note of outcome.notes.prefilled) lines.push(`  - ${note}`);
  }
  if (outcome.notes.weak.length > 0) {
    lines.push("weak:");
    for (const note of outcome.notes.weak) lines.push(`  - ${note}`);
  }
  lines.push(`corpus: ${outcome.notes.corpus}`);
  lines.push(
    `publish (human step, never this tool): cp ${path.join(wikiCandidatesDir("."), `${entry.id}.md`)} into kernel-wiki/wiki/<type>/, run uv run scripts/generate-indices.py, commit, bump KERNEL_WIKI_PIN`,
  );
  return lines.join("\n");
}

/** Trimmed, non-empty, de-duplicated: a list a frontmatter can carry. */
function supplied(values: readonly string[] | undefined): string[] {
  const out: string[] = [];
  for (const value of values ?? []) {
    const text = value.trim();
    if (text !== "" && !out.includes(text)) out.push(text);
  }
  return out;
}

function buildNotes(
  entry: WikiEntryModel,
  prefill: WorkspacePrefill,
  corpusPageIds: string[] | null,
): WikiCandidateNotes {
  const prefilled: string[] = [];
  const weak: string[] = [];

  if (entry.architectures.length > 0) {
    const from = prefill.profileRunId === null ? "the supplied architectures" : `profile/${prefill.profileRunId}`;
    const gpu = prefill.gpuName === null ? "" : ` (gpu "${prefill.gpuName}")`;
    prefilled.push(`architectures ${entry.architectures.join(", ")} from ${from}${gpu}`);
  }
  if (entry.sources.length > 0) prefilled.push(`sources ${entry.sources.join(", ")}`);
  prefilled.push(`confidence ${entry.confidence}${prefill.profileCited ? " (a profile run is cited)" : ""}`);

  if (prefill.unresolvedSources.length > 0) {
    weak.push(
      `sources ${prefill.unresolvedSources.join(", ")} do not resolve here (no such candidate id in candidates.jsonl, no such profile/<run>); a reviewer cannot check them`,
    );
  }
  if (!prefill.profileCited) weak.push("confidence inferred: no profile cited, so the entry claims no measurement");
  if (entry.cost.trim() === "") weak.push("Measured footprint and cost is empty: this entry carries no number of its own");
  if (entry.negative.trim() === "") weak.push("Negative readings is empty: say so explicitly if nothing was tried and rejected");
  if (prefill.architectures.length === 0 && entry.architectures.length > 0) {
    weak.push(`architectures came from the caller, not from a reading: ${prefill.architectureReason ?? "no profile"}`);
  }

  const corpus =
    corpusPageIds === null
      ? "corpus-absent: no cached kernel-wiki, so entry-id-taken could not run — this id was validated by shape only, and publish time is the first place a duplicate shows"
      : `${corpusPageIds.length} page id(s) checked in the cached corpus: "${entry.id}" is free`;

  return { corpus, prefilled, weak };
}

/**
 * The page ids of the cached corpus, or `null` when it is not cached. `null` is a
 * declared degradation: the entry is still validated, and the report says which
 * check did not run. One reader answers both this and the milestone's "does this
 * citation resolve?", so the two cannot disagree about what the corpus holds.
 */
export function readCorpusPageIds(corpusDir: string): string[] | null {
  const index = readCorpusIndex(corpusDir);
  return index === null ? null : index.pages.map((page) => page.id);
}

/**
 * The names an entry must not use: this task's own files. Root-level files
 * travel whole (`goal.sh`, `kernel.cu`); files in `docs/`, `src/`, `kernels/`
 * and `tests/` travel as a relative path, because their basenames are too
 * generic to refuse on their own.
 */
function workspaceFiles(workspace: string): string[] {
  const files: string[] = [];
  let rootEntries: fs.Dirent[];
  try {
    rootEntries = fs.readdirSync(workspace, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of rootEntries) {
    if (entry.isFile()) files.push(entry.name);
  }
  for (const dirName of LEAK_SCAN_DIRS) {
    const dir = path.join(workspace, dirName);
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) continue;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isFile()) files.push(path.join(dirName, entry.name));
    }
  }
  return files;
}

const ParamsSchema = obj({
  workspace: opt(str({ description: "Task workspace. Default: current directory." })),
  id: str({ description: "kebab-case page id, e.g. double-buffer-smem-tile. Frozen once published." }),
  title: str({ description: "One sentence naming what the change does." }),
  type: oneOf(ENTRY_TYPES),
  mechanism: str({ description: "## Mechanism — what runs differently and why the bottleneck goes." }),
  trigger: str({ description: "## Trigger — the observable that makes this mechanism due." }),
  cost: opt(str({ description: "## Measured footprint and cost — registers, smem, extra passes, time." })),
  conditions: str({ description: "## Load-bearing conditions — what must hold for the win to survive." }),
  gotchas: str({ description: "## Gotchas — what bit this run." }),
  negative: opt(str({ description: "## Negative readings — the hypothesis a measurement killed, with the numbers that killed it." })),
  reproduce: opt(
    str({
      description:
        "## Reproduce — a fenced block with the exact build and run commands and the raw numbers they printed. Required when confidence is verified: a reader cannot re-run a claim they cannot see.",
    }),
  ),
  tags: opt(arr(str(), { description: "Optional tags, e.g. ['tile-scheduling']." })),
  sources: opt(
    arr(str(), {
      description: "Candidate ids or `profile/<run>` pointers this entry rests on. Pre-filled from the workspace.",
    }),
  ),
  confidence: opt(oneOf(CONFIDENCE_VALUES)),
  architectures: opt(arr(str(), { description: "Only when no profile exists: ['sm90'] / ['sm100']." })),
});
type Params = Static<typeof ParamsSchema>;

export function registerWikiCandidateTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "kernel_wiki_candidate",
    label: "Write kernel-wiki Candidate Entry",
    description:
      "Turn a promotion into a validated kernel-wiki page in the workspace: `.kernel/wiki-candidates/<id>.md`, with kernel-wiki's own frontmatter (id, title, type, architectures, tags, confidence, sources) and six sections (Mechanism, Trigger, Measured footprint and cost, Load-bearing conditions, Gotchas, Negative readings). Pre-fills architectures from the newest profile/<run>/summary.json's GPU (H100/H200 → sm90, B200/GB200 → sm100) and sources from the cited candidate id and profile run; you supply type, mechanism, trigger, conditions and gotchas. Refuses an empty or placeholder section, a category trigger, `verified` with no resolvable source, a leftover template sentence, an id already in the cached corpus, an id already used in .kernel/wiki-candidates/, a body naming this task's cells, harness commands or files (outside a fenced code block), and an entry with no architecture. Never writes the corpus: publishing is a human cp plus a pin bump.",
    promptSnippet: "Write a validated kernel-wiki candidate entry for this promotion",
    promptGuidelines: [
      "Call this when a keep proves a transferable mechanism, not for a bare tuning win; `candidate: none` is a legitimate answer to a keep with no mechanism.",
      "The tool pre-fills architectures, sources and confidence. Do not pass them unless the workspace has no profile; passing architectures is the only way to proceed without one, and the entry then says the architecture came from you.",
      "Trigger must be an observable (a number or an event on the reference). `when needed`, `as needed`, `optimize`, `tune` and the rest of the milestone's phrase list are refused.",
      "Never name this task's contract cells, goal.sh, goal.checks.sh, or a workspace file in the body: the corpus is shared and the next operator cannot resolve them. A fenced code block is the allow-list.",
      "Negative readings is where a hypothesis a measurement killed goes, with the numbers that killed it; it may be empty, and a reviewer will ask why.",
      "CHECK EVERY NUMBER against the commands you actually ran, before writing the page. The validator cannot tell a measured number from a plausible one: a plausible sentence in Measured footprint or Negative readings is the one defect this tool cannot catch, and it is the one this corpus exists to prevent. Re-read both sections against the session's command history.",
      "Pass reproduce: the exact build and run commands plus their raw output (a number on a line the command did not produce). A verified entry is refused without it, because a source token that resolves only inside your workspace is a claim about evidence, not evidence.",
      "Publishing is manual by design: cp into kernel-wiki/wiki/<type>/, run `uv run scripts/generate-indices.py`, commit, bump KERNEL_WIKI_PIN.",
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
      const workspace = params.workspace ? path.resolve(ctx.cwd, params.workspace) : ctx.cwd;
      const outcome = writeWikiCandidate({
        workspace,
        id: params.id,
        title: params.title,
        type: params.type as EntryType,
        mechanism: params.mechanism,
        trigger: params.trigger,
        cost: params.cost,
        conditions: params.conditions,
        gotchas: params.gotchas,
        negative: params.negative,
        reproduce: params.reproduce,
        tags: params.tags,
        sources: params.sources,
        confidence: params.confidence as Confidence | undefined,
        architectures: params.architectures,
      });

      return {
        content: [{ type: "text" as const, text: formatWikiCandidateOutcome(outcome) }],
        details: outcome.ok
          ? {
              path: outcome.path,
              entry: outcome.entry,
              corpus: outcome.notes.corpus,
              prefilled: outcome.notes.prefilled,
              weak: outcome.notes.weak,
            }
          : { errors: outcome.errors, refusals: outcome.problems, corpus: outcome.notes.corpus },
      };
    },
  });
}
