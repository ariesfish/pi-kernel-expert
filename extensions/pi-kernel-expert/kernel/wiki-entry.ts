/**
 * The candidate entry a promotion leaves behind, in kernel-wiki's own shape.
 *
 * Four parts, each with one job:
 *
 * - **`prefillFromWorkspace` reads the record.** `architectures` comes from the
 *   newest `profile/<run>/summary.json` (`gpu.name` → an sm target), and
 *   `sources` from the profile run that supplied it plus whatever the caller
 *   cited. Facts the workspace already holds are never asked of the caller.
 * - **`validateEntry` refuses what the record cannot supply.** `mechanism`,
 *   `trigger`, `conditions` and `gotchas` are judgment; a trigger that is a
 *   category is refused with the milestone's own phrase list rather than a
 *   second copy of it; a `verified` entry needs a source that resolves here; and
 *   an entry may not name this task's cells, commands, or files, because the
 *   next operator cannot resolve them.
 * - **`renderEntry` / `parseEntry` round-trip.** A candidate file is a page
 *   waiting to be `cp`-ed into the corpus, so the schema is kernel-wiki's
 *   frontmatter plus six fixed sections and nothing else. The parser is total
 *   (an unknown heading's body is dropped, an unknown `type:` is kept verbatim
 *   for the validator to refuse) so a malformed file yields refusals instead of
 *   a crash.
 * - **Nothing here writes.** The tool writes `.kernel/wiki-candidates/<id>.md`;
 *   the corpus is read, at most, to answer `entry-id-taken`.
 *
 * The refusal message is `${rule} ${section-or-id}: ${what} Fix: ${fix}`, the
 * same shape `milestone.ts` and `refusals.ts` use, so one line is one edit.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { workspacePaths } from "../workspace/layout.ts";
import type { KernelContract } from "./contract.ts";
import { TRIGGER_CATEGORIES } from "./milestone.ts";

/** Where a candidate file lands, relative to the task workspace. */
export const WIKI_CANDIDATES_RELATIVE_DIR = path.join(".kernel", "wiki-candidates");

export function wikiCandidatesDir(workspace: string): string {
  return path.join(workspace, WIKI_CANDIDATES_RELATIVE_DIR);
}

/** kernel-wiki's page types; the corpus groups pages by them under `wiki/`. */
export const ENTRY_TYPES = ["technique", "pattern", "hardware", "migration"] as const;
export type EntryType = (typeof ENTRY_TYPES)[number];

/**
 * Measurement status, not source trust: `verified` means *this workspace*
 * measured it and can show the run.
 */
export const CONFIDENCE_VALUES = ["verified", "source-reported", "inferred", "experimental"] as const;
export type Confidence = (typeof CONFIDENCE_VALUES)[number];

export type EntryField = "mechanism" | "trigger" | "cost" | "conditions" | "gotchas" | "negative" | "reproduce";

export interface EntrySectionSpec {
  key: EntryField;
  heading: string;
  /**
   * The four sections only the agent can write. `cost` and `negative` are
   * optional: a promotion with no profile has no footprint to report, and
   * "nothing was tried and rejected" is a legitimate empty answer.
   */
  required: boolean;
}

/** The six sections, in the order a reviewer reads them and a render emits them. */
export const ENTRY_SECTIONS: readonly EntrySectionSpec[] = [
  { key: "mechanism", heading: "Mechanism", required: true },
  { key: "trigger", heading: "Trigger", required: true },
  { key: "cost", heading: "Measured footprint and cost", required: false },
  { key: "conditions", heading: "Load-bearing conditions", required: true },
  { key: "gotchas", heading: "Gotchas", required: true },
  { key: "negative", heading: "Negative readings", required: false },
  { key: "reproduce", heading: "Reproduce", required: false },
];

/** The entry, as a value. Field order is the frontmatter order. */
export interface WikiEntryModel {
  id: string;
  title: string;
  /** One of `ENTRY_TYPES`; parse keeps what the file said so the validator can name it. */
  type: EntryType;
  architectures: string[];
  tags: string[];
  confidence: Confidence;
  sources: string[];
  mechanism: string;
  trigger: string;
  cost: string;
  conditions: string;
  gotchas: string;
  negative: string;
  /**
   * The commands and the raw numbers behind this page. Required for `verified`:
   * a citation a reader cannot resolve — a contract sha in someone's workspace, a
   * candidate id in a ledger nobody has — is a claim about evidence, not evidence.
   * A stranger with the same hardware can re-run a command block; nothing else
   * in the entry is checkable.
   */
  reproduce: string;
}

/**
 * What a template writer leaves behind. A body that still holds one of these is
 * a form nobody filled, and copying a form into a page is how the corpus fills
 * with entries that say nothing.
 */
export const ENTRY_TEMPLATE_SENTENCES = [
  "one sentence: the mechanism that produces the win",
  "the observable that makes this mechanism due",
  "what it costs: time, registers, smem, an extra pass",
  "what must hold for the mechanism to keep its win",
  "what bites the next operator who applies it",
  "what variation was tried and rejected, and why",
] as const;

export const ENTRY_RULE_IDS = [
  "entry-missing-section",
  "entry-trigger-category",
  "entry-unverified-source",
  "entry-placeholder",
  "entry-id-taken",
  "entry-reference-leak",
  "entry-id-shape",
  // Not in the spec's seven: a frontmatter value the corpus cannot index, and a
  // page with no architecture, which is a page nobody can find.
  "entry-frontmatter",
  "entry-architectures-missing",
  "entry-unreproducible",
] as const;

export type EntryRuleId = (typeof ENTRY_RULE_IDS)[number];

export interface WikiEntryProblem {
  rule: EntryRuleId;
  /** The section heading the refusal is charged to, or the entry id. */
  section: string;
  what: string;
  fix: string;
  /** `${rule} ${section}: ${what} Fix: ${fix}` — one line, one edit. */
  message: string;
}

/**
 * What a refusal may consult. Everything is plain data so the rules stay pure:
 * the tool reads `candidates.jsonl`, `profile/`, the workspace tree and the
 * cached corpus, and hands the answers in.
 */
export interface EntryContext {
  contract?: KernelContract | null;
  /** Candidate ids in `candidates.jsonl`. */
  candidateIds?: readonly string[];
  /** `profile/<run>` directories that exist. */
  profileRunIds?: readonly string[];
  /** The current `kernel.contract.json` sha256, so a reading can cite itself. */
  contractSha?: string | null;
  /** Workspace-relative file paths an entry must not name. */
  workspaceFiles?: readonly string[];
  /** Page ids in the cached corpus; `null` when the corpus is not cached. */
  corpusPageIds?: readonly string[] | null;
  /** Ids already used by another file in `.kernel/wiki-candidates/`. */
  wikiCandidateIds?: readonly string[];
}

// ---- gpu → architecture ---------------------------------------------------

/**
 * The cards this build can name an sm target for. A name it cannot map leaves
 * `architectures: []` rather than a guess: `sm90` in a frontmatter is a claim
 * about which hardware a page was measured on.
 */
const GPU_ARCHITECTURES: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bH200\b/i, "sm90"],
  [/\bH100\b/i, "sm90"],
  [/\bGB200\b/i, "sm100"],
  [/\bB200\b/i, "sm100"],
];

export function architectureForGpu(name: string | null | undefined): string | null {
  const text = typeof name === "string" ? name.trim() : "";
  if (text === "") return null;
  for (const [pattern, architecture] of GPU_ARCHITECTURES) {
    if (pattern.test(text)) return architecture;
  }
  return null;
}

// ---- render / parse -------------------------------------------------------

export function renderEntry(entry: WikiEntryModel): string {
  const lines: string[] = [
    "---",
    `id: ${entry.id}`,
    `title: ${quote(entry.title)}`,
    `type: ${entry.type}`,
    `architectures: ${renderList(entry.architectures)}`,
    `tags: ${renderList(entry.tags)}`,
    `confidence: ${entry.confidence}`,
    `sources: ${renderList(entry.sources)}`,
    "---",
    "",
  ];
  for (const section of ENTRY_SECTIONS) {
    lines.push(`## ${section.heading}`, "");
    const body = entry[section.key].trim();
    if (body !== "") lines.push(body, "");
  }
  return `${lines.join("\n").replace(/\n+$/, "")}\n`;
}

/**
 * Total by design: a file the parser cannot structure yields empty sections and
 * verbatim scalar values, so the refusals come from `validateEntry` and not from
 * a thrown parse.
 */
export function parseEntry(text: string): WikiEntryModel {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const front = new Map<string, string>();
  let index = 0;

  if (lines[0]?.trim() === "---") {
    index = 1;
    while (index < lines.length && lines[index].trim() !== "---") {
      const line = lines[index];
      const split = line.indexOf(":");
      if (split > 0) front.set(line.slice(0, split).trim().toLowerCase(), line.slice(split + 1).trim());
      index += 1;
    }
    if (index < lines.length) index += 1;
  }

  const bodies = new Map<EntryField, string[]>();
  let current: EntryField | null = null;
  for (; index < lines.length; index += 1) {
    const heading = /^##(?!#)\s+(.*)$/.exec(lines[index]);
    if (heading) {
      const section = ENTRY_SECTIONS.find((spec) => normalizeHeading(spec.heading) === normalizeHeading(heading[1]));
      current = section ? section.key : null;
      if (section) bodies.set(section.key, []);
      continue;
    }
    if (current) bodies.get(current)!.push(lines[index]);
  }

  const body = (key: EntryField): string => (bodies.get(key) ?? []).join("\n").trim();

  return {
    id: front.get("id") ?? "",
    title: unquote(front.get("title") ?? ""),
    type: (front.get("type") ?? "") as EntryType,
    architectures: parseList(front.get("architectures") ?? ""),
    tags: parseList(front.get("tags") ?? ""),
    confidence: (front.get("confidence") ?? "") as Confidence,
    sources: parseList(front.get("sources") ?? ""),
    mechanism: body("mechanism"),
    trigger: body("trigger"),
    cost: body("cost"),
    conditions: body("conditions"),
    gotchas: body("gotchas"),
    negative: body("negative"),
    reproduce: body("reproduce"),
  };
}

function quote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function unquote(value: string): string {
  const text = value.trim();
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
    return text.slice(1, -1).replace(/\\(["\\])/g, "$1");
  }
  return text;
}

function renderList(values: readonly string[]): string {
  return `[${values.map((value) => value.trim()).filter((value) => value !== "").join(", ")}]`;
}

function parseList(value: string): string[] {
  const text = value.trim();
  const inner = text.startsWith("[") && text.endsWith("]") ? text.slice(1, -1) : text;
  return inner
    .split(",")
    .map((item) => unquote(item))
    .map((item) => item.trim())
    .filter((item) => item !== "");
}

function normalizeHeading(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

// ---- validation -----------------------------------------------------------

/**
 * Every refusal, in rule order, collected in one pass: fixing one and
 * re-running to discover the next is how a loop spends an hour learning
 * nothing.
 */
export function validateEntry(entry: WikiEntryModel, ctx: EntryContext = {}): WikiEntryProblem[] {
  return [
    ...idShape(entry, ctx),
    ...idTaken(entry, ctx),
    ...missingSections(entry),
    ...placeholders(entry),
    ...categoryTrigger(entry),
    ...architectures(entry),
    ...unverifiedSource(entry, ctx),
    ...unreproducible(entry),
    ...referenceLeak(entry, ctx),
  ];
}

/** 7. An id is a citation contract: kebab-case, and never a second file in this workspace. */
function idShape(entry: WikiEntryModel, ctx: EntryContext): WikiEntryProblem[] {
  const problems: WikiEntryProblem[] = [];
  const shown = entry.id.trim() === "" ? "(empty)" : entry.id;
  if (!KEBAB.test(entry.id)) {
    problems.push(
      makeProblem(
        "entry-id-shape",
        shown,
        `the id ${JSON.stringify(entry.id)} is not kebab-case; page ids are frozen because they are the citation contract, and a rename breaks every citation.`,
        `write it as lower-case words joined by single hyphens, e.g. "double-buffer-smem-tile"`,
      ),
    );
    return problems;
  }
  const taken = (ctx.wikiCandidateIds ?? []).some((id) => id === entry.id);
  if (taken) {
    problems.push(
      makeProblem(
        "entry-id-shape",
        entry.id,
        `the id "${entry.id}" is already used by ${WIKI_CANDIDATES_RELATIVE_DIR}/${entry.id}.md; one workspace yields one candidate per mechanism, and a second file under the same id is the same mechanism measured twice.`,
        `extend the existing entry instead of writing a second one, or give this mechanism its own id if it is a different mechanism`,
      ),
    );
  }
  return problems;
}

/** 5. The corpus is the dedup key. Absent corpus is a declared degradation, not a pass. */
function idTaken(entry: WikiEntryModel, ctx: EntryContext): WikiEntryProblem[] {
  const pageIds = ctx.corpusPageIds;
  if (pageIds === null || pageIds === undefined) return [];
  if (!pageIds.includes(entry.id)) return [];
  return [
    makeProblem(
      "entry-id-taken",
      entry.id,
      `the cached corpus already has a page with id "${entry.id}"; a second page under one id is the ambiguity ids exist to prevent.`,
      `extend that page in kernel-wiki instead, or pick an id that names the mechanism more precisely`,
    ),
  ];
}

/** 1. Four sections are judgment. Nothing in the workspace can pre-fill them. */
function missingSections(entry: WikiEntryModel): WikiEntryProblem[] {
  const problems: WikiEntryProblem[] = [];
  const targets: Array<{ label: string; body: string; fix: string }> = [
    {
      label: "Title",
      body: entry.title.trim(),
      fix: `write one sentence naming what changes, e.g. "Prefetching the next smem tile hides the load behind the mma issue"`,
    },
    ...ENTRY_SECTIONS.filter((section) => section.required).map((section) => ({
      label: section.heading,
      body: entry[section.key].trim(),
      fix: MISSING_FIX[section.key] ?? `write what ${section.heading} stands for in the words of this mechanism`,
    })),
  ];

  for (const target of targets) {
    if (target.body === "") {
      problems.push(
        makeProblem(
          "entry-missing-section",
          target.label,
          `the section is empty; the tool can pre-fill what the workspace measured, but not what the mechanism is.`,
          target.fix,
        ),
      );
      continue;
    }
    const whole = PLACEHOLDER_ONLY.exec(target.body);
    if (whole) {
      problems.push(
        makeProblem(
          "entry-missing-section",
          target.label,
          `the section still holds the placeholder "${whole[0]}" and nothing else.`,
          target.fix,
        ),
      );
    }
  }
  return problems;
}

const MISSING_FIX: Partial<Record<EntryField, string>> = {
  mechanism:
    "say what the hardware or the algorithm does differently and why that removes the bottleneck, e.g. \"keeps the tile in registers so the inner loop issues one LDG per 128 B\"",
  trigger:
    "name an observable, e.g. \"waves/SM < 1 on the reference\" or \"sm__throughput above 70% with DRAM below 20%\" — never a category like \"when needed\"",
  conditions:
    "name what must hold for the win to survive: the shape range, the dtype, the occupancy the tile still allows, the clock policy it assumed",
  gotchas:
    "name what bit this run — register spill, a lost vectorisation, a barrier that serialised — so the next operator does not pay for it again",
};

/** 4. A placeholder in prose, or a template sentence, is a form nobody filled. */
function placeholders(entry: WikiEntryModel): WikiEntryProblem[] {
  const problems: WikiEntryProblem[] = [];
  const targets: Array<{ label: string; body: string; required: boolean }> = [
    { label: "Title", body: entry.title.trim(), required: true },
    ...ENTRY_SECTIONS.map((section) => ({
      label: section.heading,
      body: entry[section.key].trim(),
      required: section.required,
    })),
  ];

  for (const target of targets) {
    if (target.body === "") continue;
    // A body that is *only* `<...>` is a missing section (rule 1) and is not
    // reported twice.
    if (target.required && PLACEHOLDER_ONLY.test(target.body)) continue;

    const placeholder = PLACEHOLDER.exec(target.body);
    if (placeholder) {
      problems.push(
        makeProblem(
          "entry-placeholder",
          target.label,
          `the body still holds the placeholder "${placeholder[0]}"; a page that ships a form is worse than no page.`,
          `replace "${placeholder[0]}" with the words of this mechanism`,
        ),
      );
      continue;
    }
    const template = templateLine(target.body);
    if (template !== null) {
      problems.push(
        makeProblem(
          "entry-placeholder",
          target.label,
          `the body still holds the template sentence "${template}"; it names nothing this task measured.`,
          `write what this mechanism actually does here, in one or two sentences`,
        ),
      );
    }
  }
  return problems;
}

/** 2. A trigger is an observable. The milestone's phrase list is imported, not re-spelled. */
function categoryTrigger(entry: WikiEntryModel): WikiEntryProblem[] {
  const phrase = categoryPhrase(entry.trigger);
  if (phrase === null) return [];
  return [
    makeProblem(
      "entry-trigger-category",
      "Trigger",
      `the Trigger says "${phrase}" — a category, not an observable, so the next operator cannot tell when this mechanism is due.`,
      `name a number or an event, e.g. "waves/SM < 1 on the reference" or "ncu reports DRAM throughput above 80%"`,
    ),
  ];
}

/** An entry with no architecture is a page nobody can find by hardware. */
function architectures(entry: WikiEntryModel): WikiEntryProblem[] {
  if (entry.architectures.some((value) => value.trim() !== "")) return [];
  return [
    makeProblem(
      "entry-architectures-missing",
      "architectures",
      `architectures is empty; the tool fills it from the newest profile/<run>/summary.json's gpu.name, and this workspace has no profile it could read, so it will not invent a target.`,
      `pass architectures (e.g. ["sm90"]) — the corpus indexes pages by hardware, and an entry that names none is unfindable`,
    ),
  ];
}

/** 3. `verified` is a claim about measurement, and a claim needs a source that resolves. */
function unverifiedSource(entry: WikiEntryModel, ctx: EntryContext): WikiEntryProblem[] {
  if (entry.confidence !== "verified") return [];
  if (entry.sources.some((source) => resolvesSource(source, ctx))) return [];
  const listed = entry.sources.length === 0 ? "no sources at all" : `sources ${entry.sources.join(", ")}`;
  return [
    makeProblem(
      "entry-unverified-source",
      "sources",
      `confidence is "verified" with ${listed}, and nothing in this workspace resolves: a candidate id from candidates.jsonl, a profile/<run> directory, or contract:<sha> for a reading's own contract. Verified means this workspace measured it, not that a page said so.`,
      `cite the candidate id or the profile run that measured it, or lower confidence to "source-reported" (a source reported it) or "inferred" (nothing measured it here)`,
    ),
  ];
}

/**
 * 8. `verified` means a reader can check it, which means the commands are in the
 * page. A source token naming something in the author's workspace is a claim
 * about evidence; the command block is the evidence.
 */
function unreproducible(entry: WikiEntryModel): WikiEntryProblem[] {
  if (entry.confidence !== "verified") return [];
  const block = fencedBlocks(entry.reproduce).join("\n");
  if (block.trim() === "") {
    return [
      makeProblem(
        "entry-unreproducible",
        "Reproduce",
        `confidence is "verified" and there is no ## Reproduce block: a reader cannot re-run a claim they cannot see. Source tokens such as contract:<sha> resolve only inside the workspace that wrote them.`,
        `add a fenced block with the exact build and run commands and the raw numbers they printed (device_ms per variant), so someone with the same card can check the page`,
      ),
    ];
  }
  const COMMAND = /^\s*(\$\s*)?(nvcc|cuda|python3?|bash|\.\/|make|ncu)\b/;
  const lines = block.split("\n");
  const commandLines = lines.filter((line) => COMMAND.test(line));
  const hasCommand = commandLines.length > 0;
  // A digit on a command line is an argument (`--n 16777216`), not a result: the
  // number a reader checks has to be on a line the command did not produce.
  const hasNumber = lines.some((line) => !COMMAND.test(line) && /\d/.test(line));
  if (!hasCommand || !hasNumber) {
    return [
      makeProblem(
        "entry-unreproducible",
        "Reproduce",
        `the ## Reproduce block has ${hasCommand ? "a command" : "no command"} and ${hasNumber ? "a number" : "no number"}; both are needed for the page to be checkable.`,
        `paste the command line and the raw metric line it printed, e.g. "$ ./bench --n 16777216" then "METRIC device_ms=0.061417"`,
      ),
    ];
  }
  return [];
}

/** 6. The corpus is shared across operators; this task's names do not resolve for them. */
function referenceLeak(entry: WikiEntryModel, ctx: EntryContext): WikiEntryProblem[] {
  const forbidden = forbiddenTokens(ctx);
  if (forbidden.size === 0) return [];

  const problems: WikiEntryProblem[] = [];
  const targets: Array<{ label: string; body: string }> = [
    { label: "Title", body: entry.title },
    ...ENTRY_SECTIONS.map((section) => ({ label: section.heading, body: entry[section.key] })),
  ];

  for (const target of targets) {
    // A fenced block is the allow-list: it may quote code that names the file.
    const outside = stripFences(target.body);
    if (outside.trim() === "") continue;
    const seen = new Set<string>();
    for (const [token, why] of forbidden) {
      if (seen.has(token)) continue;
      if (!mentionsToken(outside, token)) continue;
      seen.add(token);
      problems.push(
        makeProblem(
          "entry-reference-leak",
          target.label,
          `the body names "${token}", ${why}; the entry travels to another operator whose workspace has no such name.`,
          `describe the thing generically — "the benchmark harness", "the m=1024 cell" — or quote it inside a fenced code block, which is the one place a task-specific name is allowed`,
        ),
      );
    }
  }
  return problems;
}

/** The bodies of fenced blocks, without the fences; [] when there are none. */
function fencedBlocks(text: string): string[] {
  const blocks: string[] = [];
  const pattern = /```[^\n]*\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) blocks.push(match[1]);
  return blocks;
}

function forbiddenTokens(ctx: EntryContext): Map<string, string> {
  const tokens = new Map<string, string>();
  const add = (token: string, why: string): void => {
    const trimmed = token.trim();
    if (trimmed === "") return;
    if (!tokens.has(trimmed)) tokens.set(trimmed, why);
  };

  for (const cell of ctx.contract?.cells ?? []) add(cell.id, "a cell of this task's contract");
  for (const [field, command] of [
    ["checkCommand", ctx.contract?.checkCommand],
    ["benchmarkCommand", ctx.contract?.benchmarkCommand],
  ] as const) {
    for (const token of commandFiles(command ?? "")) add(token, `the file this task's ${field} runs`);
  }
  for (const file of ctx.workspaceFiles ?? []) add(file, "a path in this task's workspace");

  return tokens;
}

/** The file a command runs: `bash goal.checks.sh --repeats 3` names `goal.checks.sh`. */
function commandFiles(command: string): string[] {
  const files: string[] = [];
  for (const token of command.split(/\s+/)) {
    const cleaned = token.replace(/^["']|["']$/g, "");
    if (cleaned === "" || cleaned.startsWith("-")) continue;
    if (!cleaned.includes("/") && !cleaned.includes(".")) continue;
    files.push(path.basename(cleaned));
  }
  return files;
}

const FENCE = /^\s*(```|~~~)/;

function stripFences(body: string): string {
  const kept: string[] = [];
  let inside = false;
  for (const line of body.split("\n")) {
    if (FENCE.test(line)) {
      inside = !inside;
      continue;
    }
    if (!inside) kept.push(line);
  }
  return kept.join("\n");
}

function mentionsToken(text: string, token: string): boolean {
  const pattern = new RegExp(`(^|[^A-Za-z0-9_./-])${escapeRegExp(token)}([^A-Za-z0-9_./-]|$)`);
  return pattern.test(text);
}

/** A candidate id, a run id, or a `profile/<run>` / `profile:<run>` pointer. */
export function resolvesSource(source: string, ctx: EntryContext): boolean {
  const token = source.trim();
  if (token === "") return false;
  if ((ctx.candidateIds ?? []).includes(token)) return true;
  // A goal.sh reading identities itself by the contract it ran under, so a run
  // that has no candidate yet — the common case, since the entry is written
  // before the ledger row that cites it — can still be sourced.
  const contractPointer = /^contract:([0-9a-f]{12,64})$/.exec(token);
  if (contractPointer) {
    const sha = ctx.contractSha ?? "";
    return sha.startsWith(contractPointer[1]);
  }
  const pointer = /^profile[/:](.+)$/.exec(token);
  const run = pointer ? pointer[1].trim() : token;
  return (ctx.profileRunIds ?? []).includes(run);
}

// ---- pre-fill -------------------------------------------------------------

export interface PrefillOptions {
  workspace: string;
  /** Source tokens the caller named: a candidate id, a run id, `profile/<run>`. */
  sources?: readonly string[];
}

export interface WorkspacePrefill {
  /** `["sm90"]` from an H100/H200 reading, `["sm100"]` from a B200/GB200 one, else `[]`. */
  architectures: string[];
  /** The cited sources plus the profile run the architectures came from. */
  sources: string[];
  /** `source-reported` when a profile is cited, `inferred` otherwise. */
  confidence: Confidence;
  /** The run whose summary supplied the architectures, or null. */
  profileRunId: string | null;
  /** `gpu.name` as the summary recorded it, or null. */
  gpuName: string | null;
  /** Why `architectures` is empty: no profile, or a GPU this build cannot map. */
  architectureReason: string | null;
  candidateIds: string[];
  newestCandidateId: string | null;
  profileRunIds: string[];
  /** Source tokens that resolve to nothing here. */
  unresolvedSources: string[];
  /** True when a cited source is a profile run that exists. */
  profileCited: boolean;
}

/**
 * What the workspace already knows, so the caller is only asked for judgment.
 * Reads `profile/<run>/summary.json` (newest first) and `candidates.jsonl`;
 * writes nothing.
 */
export function prefillFromWorkspace(options: PrefillOptions): WorkspacePrefill {
  const workspace = options.workspace;
  const paths = workspacePaths(workspace);
  const candidateIds = readCandidateIds(paths.candidates);
  const profiles = readProfileSummaries(paths.profile);
  const profileRunIds = profiles.map((profile) => profile.runId);
  const newest = profiles[0] ?? null;

  const architectures: string[] = [];
  let architectureReason: string | null = null;
  if (newest === null) {
    architectureReason =
      "no profile/<run>/summary.json in this workspace, so no reading names a GPU";
  } else if (newest.gpuName === null || newest.gpuName.trim() === "") {
    architectureReason = `profile/${newest.runId}/summary.json records no gpu.name`;
  } else {
    const architecture = architectureForGpu(newest.gpuName);
    if (architecture === null) {
      architectureReason = `profile/${newest.runId} reports gpu "${newest.gpuName}", which this build cannot map to an sm target`;
    } else {
      architectures.push(architecture);
    }
  }

  const contractSha = readContractSha(options.workspace);
  const sources: string[] = [];
  const unresolvedSources: string[] = [];
  for (const raw of options.sources ?? []) {
    const token = raw.trim();
    if (token === "") continue;
    const contractPointer = /^contract:([0-9a-f]{12,64})$/.exec(token);
    const pointer = /^profile[/:](.+)$/.exec(token);
    const normalized = pointer ? pointer[1].trim() : token;
    const resolves =
      candidateIds.includes(normalized) ||
      profileRunIds.includes(normalized) ||
      (contractPointer !== null && (contractSha ?? "").startsWith(contractPointer[1]));
    if (!resolves) {
      if (!unresolvedSources.includes(token)) unresolvedSources.push(token);
    }
    if (!sources.includes(normalized)) sources.push(normalized);
  }

  // The run the architectures came from is evidence for this entry whether or
  // not the caller remembered to cite it.
  if (newest !== null && !sources.includes(newest.runId)) sources.push(newest.runId);
  if (sources.length === 0 && candidateIds.length > 0) {
    const newestCandidate = candidateIds[candidateIds.length - 1];
    sources.push(newestCandidate);
  }

  const profileCited = sources.some((source) => profileRunIds.includes(source));

  return {
    architectures,
    sources,
    confidence: profileCited ? "source-reported" : "inferred",
    profileRunId: newest?.runId ?? null,
    gpuName: newest?.gpuName ?? null,
    architectureReason,
    candidateIds,
    newestCandidateId: candidateIds.length > 0 ? candidateIds[candidateIds.length - 1] : null,
    profileRunIds,
    unresolvedSources,
    profileCited,
  };
}

/** The workspace contract's own sha, so a `contract:<sha>` source can resolve. */
function readContractSha(workspace: string): string | null {
  try {
    const file = path.join(workspace, "kernel.contract.json");
    if (!fs.existsSync(file)) return null;
    return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  } catch {
    return null;
  }
}

interface ProfileSummaryView {
  runId: string;
  gpuName: string | null;
  createdAt: string | null;
  mtimeMs: number;
}

/** Newest first: `createdAt` when it parses, then the file's mtime, then the run id. */
function readProfileSummaries(profileDir: string): ProfileSummaryView[] {
  if (!fs.existsSync(profileDir)) return [];
  const views: ProfileSummaryView[] = [];
  for (const entry of fs.readdirSync(profileDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = path.join(profileDir, entry.name, "summary.json");
    if (!fs.existsSync(file)) continue;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    } catch {
      continue;
    }
    const gpu = parsed.gpu;
    const gpuName =
      gpu && typeof gpu === "object" && typeof (gpu as Record<string, unknown>).name === "string"
        ? ((gpu as Record<string, unknown>).name as string)
        : null;
    const createdAt = typeof parsed.createdAt === "string" ? parsed.createdAt : null;
    views.push({
      runId: typeof parsed.runId === "string" && parsed.runId.trim() !== "" ? parsed.runId : entry.name,
      gpuName,
      createdAt,
      mtimeMs: fs.statSync(file).mtimeMs,
    });
  }
  views.sort((left, right) => {
    const leftAt = left.createdAt === null ? Number.NaN : Date.parse(left.createdAt);
    const rightAt = right.createdAt === null ? Number.NaN : Date.parse(right.createdAt);
    if (Number.isFinite(leftAt) && Number.isFinite(rightAt) && leftAt !== rightAt) return rightAt - leftAt;
    if (Number.isFinite(leftAt) !== Number.isFinite(rightAt)) return Number.isFinite(leftAt) ? -1 : 1;
    if (left.mtimeMs !== right.mtimeMs) return right.mtimeMs - left.mtimeMs;
    return left.runId.localeCompare(right.runId);
  });
  return views;
}

function readCandidateIds(file: string): string[] {
  if (!fs.existsSync(file)) return [];
  const ids: string[] = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const text = line.trim();
    if (text === "") continue;
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      if (typeof parsed.id === "string" && parsed.id.trim() !== "" && !ids.includes(parsed.id)) ids.push(parsed.id);
    } catch {
      continue;
    }
  }
  return ids;
}

/** The ids already written under `.kernel/wiki-candidates/`. */
export function readCandidateEntryIds(workspace: string): string[] {
  const dir = wikiCandidatesDir(workspace);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => entry.name.replace(/\.md$/, ""))
    .sort();
}

// ---- helpers --------------------------------------------------------------

const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PLACEHOLDER = /<[^<>\n]*>/;
const PLACEHOLDER_ONLY = /^<[^<>\n]*>$/;

function templateLine(body: string): string | null {
  for (const line of body.split("\n")) {
    const normalized = line.trim().toLowerCase().replace(/\s+/g, " ").replace(/\.$/, "");
    if (normalized === "") continue;
    if ((ENTRY_TEMPLATE_SENTENCES as readonly string[]).includes(normalized)) return line.trim();
  }
  return null;
}

function categoryPhrase(value: string): string | null {
  const text = value.trim().toLowerCase();
  for (const phrase of TRIGGER_CATEGORIES) {
    if (new RegExp(`(^|[^a-z0-9])${escapeRegExp(phrase)}([^a-z0-9]|$)`).test(text)) return phrase;
  }
  return null;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function makeProblem(rule: EntryRuleId, section: string, what: string, fix: string): WikiEntryProblem {
  return { rule, section, what, fix, message: `${rule} ${section}: ${what} Fix: ${fix}` };
}

/** One printable line per refusal, numbered, in rule order. */
export function formatEntryProblems(problems: readonly WikiEntryProblem[]): string {
  return problems.map((problem, index) => `${index + 1}. ${problem.message}`).join("\n");
}
