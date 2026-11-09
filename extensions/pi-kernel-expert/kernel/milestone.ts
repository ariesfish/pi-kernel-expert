/**
 * `docs/milestone.md` — the plan as an addressable artifact.
 *
 * Seven sections; phases `### M<k> <name>`; decisions `#### D<m>.<n> <name>`
 * with a five-tuple on one line per key; typed gate lines under
 * `### M<k> Gate`. The model is a *view over the file's own lines*: every
 * structure (section, phase, decision, gate block) carries the line range it was
 * read from, and `renderMilestone` is that array joined back up. A
 * re-serialised plan would be a second author, and the byte-identical round trip
 * is what lets a hash of this file (T-011's lock) mean *the file*.
 *
 * Two properties are deliberate:
 *
 * - **The parser is total; the validator refuses.** Parsing structures what it
 *   can and repairs nothing — a line it cannot structure stays a section line —
 *   so the validator is the only place a refusal is born, and it reports *every*
 *   refusal at once. Discovering the second defect only after fixing the first is
 *   how an hour gets spent learning nothing.
 * - **A refusal names the rule, then the row, then what is wrong and the fix.**
 *   The row is an address: `D0.2` for a decision, `M0 Gate:3` for the third gate
 *   line of `### M0 Gate`, `milestone` for a defect of the file as a whole. A
 *   message that cannot be turned into an edit is not a refusal.
 *
 * Citation *resolution* — does `profile:run1` exist? does the contract cover
 * `m1024/typical`? — is T-012's job. Here the pointer is parsed and stored on
 * the gate line, and the line is judged on its shape alone.
 */
import type { KernelContract } from "./contract.ts";

/** The plan file, per task workspace. */
export const MILESTONE_RELATIVE_PATH = "docs/milestone.md";

/** The seven sections, in order. `## <n>. <title>`; the title is the contract. */
export const SECTION_TITLES = [
  "Problem and Target",
  "Contract",
  "DAG and Phase Order",
  "Decisions",
  "Dead Ends",
  "Global Gate",
  "Rules",
] as const;

/** The five-tuple, enforced literally: one key per line, spelled like this. */
export const FIVE_TUPLE_KEYS = ["Action", "Purpose", "Trigger", "Cost", "Depends on"] as const;
export type FiveTupleKey = (typeof FIVE_TUPLE_KEYS)[number];

/** `⇐` upstream (an edge), `⊗` companion (same commit, not an edge), `⇒` downstream. */
export const DEPENDENCY_ARROWS = ["⇐", "⊗", "⇒"] as const;
export type DependencyArrow = (typeof DEPENDENCY_ARROWS)[number];

/** Every class a gate line may carry. `none` is deliberately absent. */
export const VERIFY_CLASSES = ["ncu-direct", "ncu-derived", "sass-derived", "correctness", "mechanism"] as const;
export type VerifyClass = (typeof VERIFY_CLASSES)[number];

/** The one class a gate line may not carry: nothing proves this. */
export const VERIFY_NONE = "none";

/**
 * A trigger is an observable, never a category. These phrases are what an agent
 * writes when it has not decided what the decision is for.
 */
export const TRIGGER_CATEGORIES = [
  "when needed",
  "as needed",
  "as appropriate",
  "if slow",
  "if needed",
  "optimize",
  "improve",
  "make it faster",
  "tune",
] as const;

/**
 * Sentences a template would leave behind, normalised (lower case, one space,
 * no trailing period). A template writer (T-015) keeps its filler here so that
 * copying it into a row is refused instead of validated.
 */
export const TEMPLATE_SENTENCES = [
  "one line: what the decision does",
  "one line: why this decision exists",
  "the observable that makes this decision due",
  "one line: what it costs",
  "which decisions this one rides on",
  "one line summarising the decision",
] as const;

export const MILESTONE_RULE_IDS = [
  "route-missing-key",
  "route-dangling-dep",
  "route-id-is-gate",
  "route-placeholder",
  "gate-verify-none",
  "gate-sass-unpriced",
  "gate-no-mechanism-line",
  "trigger-is-category",
  "phase-order",
] as const;

export type MilestoneRuleId = (typeof MILESTONE_RULE_IDS)[number];

/**
 * One refusal. `message` starts with the rule id, then the row id, then what is
 * wrong and the fix, so it can be printed or asserted as one line.
 */
export interface Problem {
  rule: MilestoneRuleId;
  /** The row it is charged to: `D0.2`, `M0 Gate:3`, `M0`, `milestone`, a section label. */
  row: string;
  /** What is wrong, without the rule and the row. */
  what: string;
  /** What the caller does next; never "try again". */
  fix: string;
  message: string;
}

export interface Section {
  /** The heading as written: `## 3. Decisions`. */
  heading: string;
  /** `3`, or null for an unnumbered `## ` heading. */
  number: string | null;
  title: string;
  /** 0-based line index of the heading; `end` is exclusive and covers the section. */
  start: number;
  end: number;
}

export type PhaseKind = "gate" | "block";

/** A `### M<k> …` block. `gate` blocks hold gate lines; every other block holds decisions. */
export interface Phase {
  id: string;
  /** `k` of `M<k>`, or -1 for a `### ` heading that carries no phase id. */
  index: number;
  /** The words after the id: `Architecture`, `Gate`, `Contract`. */
  name: string;
  kind: PhaseKind;
  heading: string;
  start: number;
  end: number;
}

/** One `- Key: value` line under a decision heading. */
export interface MilestoneRow {
  /** The key as written, e.g. `Depends on`. */
  key: string;
  value: string;
  /** 0-based absolute line index. */
  line: number;
  raw: string;
}

export interface Dependency {
  arrow: DependencyArrow | null;
  /** The id named. Kept even when it resolves to nothing: a dangling edge is the refusal. */
  id: string;
  raw: string;
  line: number;
}

export interface Decision {
  /** `D0.1`, or the heading's own text when the id does not parse. */
  id: string;
  /** The words after the id. */
  name: string;
  /** The owning phase id, or null when the decision sits outside any `### M<k>` block. */
  phase: string | null;
  heading: string;
  start: number;
  end: number;
  /** The rows whose key is one of the five. */
  rows: MilestoneRow[];
  /** Rows whose key is not one of the five: a misspelling of a key, or prose with a colon. */
  unknownRows: MilestoneRow[];
  deps: Dependency[];
}

export interface Priced {
  /** `-12% issue slots`. */
  delta: string;
  /** Where the price came from: a profile run id, or `KB:<entry>` once `instruments` lands. */
  source: string;
  raw: string;
}

export interface GateLine {
  /** The row id a refusal names: `M0 Gate:3`. */
  row: string;
  phase: string;
  /** 1-based position among its block's gate lines. */
  index: number;
  /** 0-based absolute line index. */
  line: number;
  raw: string;
  /** The line's own words: no leading `- `, no markers. Empty is a legal value, not a pass. */
  text: string;
  verify: VerifyClass | null;
  /** The class token as written: `none`, `mechanism`, `fast` — kept so a refusal can quote it. */
  verifyRaw: string | null;
  /** `profile:run1`, `cell/group: m1024/typical`. */
  // T-012 resolves these against profile/ and the contract's cells x groups; this module only stores them.
  pointer: string | null;
  priced: Priced | null;
  pricedRaw: string | null;
}

export interface GateBlock {
  heading: string;
  phase: string;
  start: number;
  end: number;
  lines: GateLine[];
}

/**
 * The milestone, as a view over its own lines. `lines` is the file, so
 * `renderMilestone` cannot drift from what a human wrote.
 */
export interface MilestoneModel {
  /** The file, line for line, as `text.split("\n")`. */
  lines: string[];
  sections: Section[];
  phases: Phase[];
  decisions: Decision[];
  gates: GateBlock[];
  /** `## 4. Dead Ends` rows, `- ` stripped: `<D ids> | <reason> | <evidence>`. */
  deadEnds: string[];
  /** What the parser could not structure. Empty for a file the parser could read whole. */
  problems: Problem[];
}

/**
 * What a refusal may consult beyond the file. Taken now so the signature T-012
 * needs already exists; this module resolves nothing.
 */
export interface MilestoneContext {
  contract?: KernelContract | null;
  /** The `profile/<run_id>` directories that exist. T-012 resolves `ncu-*` pointers here. */
  profileRunIds?: readonly string[];
}

export function renderMilestone(model: MilestoneModel): string {
  return model.lines.join("\n");
}

export function parseMilestone(text: string): { model: MilestoneModel; problems: Problem[] } {
  const lines = text.split("\n");
  const sections: Section[] = [];
  const phases: Phase[] = [];
  const decisions: Decision[] = [];
  const gates: GateBlock[] = [];
  const deadEnds: string[] = [];

  let section: Section | null = null;
  let phase: Phase | null = null;
  let gate: GateBlock | null = null;
  let decision: Decision | null = null;

  const closeInside = (end: number): void => {
    if (decision) {
      decision.end = end;
      decision = null;
    }
    if (gate) {
      gate.end = end;
      gate = null;
    }
    if (phase) {
      phase.end = end;
      phase = null;
    }
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];

    const h2 = /^##(?!#)\s+(.*)$/.exec(line);
    if (h2) {
      closeInside(index);
      if (section) section.end = index;
      const parts = headingParts(h2[1]);
      section = { heading: line, number: parts.number, title: parts.title, start: index, end: lines.length };
      sections.push(section);
      continue;
    }

    const h3 = /^###(?!#)\s+(.*)$/.exec(line);
    if (h3) {
      closeInside(index);
      const heading = h3[1].trim();
      const id = /^(M\d+)\b\s*(.*)$/.exec(heading);
      phase = {
        id: id ? id[1] : heading,
        index: id ? Number(id[1].slice(1)) : -1,
        name: id ? id[2].trim() : heading,
        kind: id && /^gate$/i.test(id[2].trim()) ? "gate" : "block",
        heading: line,
        start: index,
        end: lines.length,
      };
      phases.push(phase);
      if (phase.kind === "gate") {
        gate = { heading: line, phase: phase.id, start: index, end: lines.length, lines: [] };
        gates.push(gate);
      }
      continue;
    }

    const h4 = /^####(?!#)\s+(.*)$/.exec(line);
    if (h4) {
      if (decision) decision.end = index;
      const heading = h4[1].trim();
      const id = /^(D\d+\.\d+)\b\s*(.*)$/.exec(heading);
      decision = {
        id: id ? id[1] : heading,
        name: id ? id[2].trim() : heading,
        phase: phase ? phase.id : null,
        heading: line,
        start: index,
        end: lines.length,
        rows: [],
        unknownRows: [],
        deps: [],
      };
      decisions.push(decision);
      continue;
    }
  }
  closeInside(lines.length);
  if (section) section.end = lines.length;

  for (const entry of decisions) readDecisionRows(entry, lines);
  for (const block of gates) readGateLines(block, lines);

  const deadEndSection = sections.find((entry) => /dead\s*end/i.test(entry.title));
  if (deadEndSection) {
    for (let index = deadEndSection.start + 1; index < deadEndSection.end; index += 1) {
      const row = lines[index].trim();
      if (row === "" || /^#{1,6}\s/.test(row)) continue;
      deadEnds.push(row.replace(/^-\s*/, ""));
    }
  }

  const model: MilestoneModel = { lines, sections, phases, decisions, gates, deadEnds, problems: [] };
  return { model, problems: model.problems };
}

function headingParts(text: string): { number: string | null; title: string } {
  const trimmed = text.trim();
  const numbered = /^(\d+)\.\s*(.*)$/.exec(trimmed);
  if (numbered) return { number: numbered[1], title: numbered[2].trim() };
  return { number: null, title: trimmed };
}

function readDecisionRows(decision: Decision, lines: readonly string[]): void {
  for (let index = decision.start + 1; index < decision.end; index += 1) {
    const raw = lines[index];
    const row = /^-\s*(.*)$/.exec(raw.trim());
    if (!row) continue;
    const split = row[1].indexOf(":");
    if (split <= 0) continue;
    const key = row[1].slice(0, split).trim();
    const value = row[1].slice(split + 1).trim();
    const entry: MilestoneRow = { key, value, line: index, raw };
    if ((FIVE_TUPLE_KEYS as readonly string[]).some((known) => normalizeKey(known) === normalizeKey(key))) {
      decision.rows.push(entry);
    } else {
      decision.unknownRows.push(entry);
    }
  }
  const depends = decision.rows.find((row) => normalizeKey(row.key) === normalizeKey("Depends on"));
  if (depends) decision.deps = parseDependencies(depends);
}

function parseDependencies(row: MilestoneRow): Dependency[] {
  if (row.value.trim() === "" || /^none$/i.test(row.value.trim())) return [];
  const deps: Dependency[] = [];
  for (const chunk of row.value.split(",")) {
    const item = chunk.trim();
    if (item === "") continue;
    const arrow = /^(⇐|⊗|⇒)\s*(.*)$/.exec(item);
    if (arrow) {
      deps.push({ arrow: arrow[1] as DependencyArrow, id: arrow[2].trim(), raw: item, line: row.line });
    } else {
      deps.push({ arrow: null, id: item, raw: item, line: row.line });
    }
  }
  return deps;
}

function readGateLines(block: GateBlock, lines: readonly string[]): void {
  let count = 0;
  for (let index = block.start + 1; index < block.end; index += 1) {
    const raw = lines[index];
    if (raw.trim() === "") continue;
    count += 1;
    const verify = /\[VERIFY:\s*([^\]]*?)\s*\]/i.exec(raw);
    const priced = /\[PRICED:\s*([^\]]*?)\s*\]/i.exec(raw);
    const verifyTokens = verify ? verify[1].trim().split(/\s+/) : [];
    const klass = verifyTokens.length > 0 ? verifyTokens[0].toLowerCase() : null;
    const pointer = verifyTokens.length > 1 ? verifyTokens.slice(1).join(" ") : null;

    let pricedEntry: Priced | null = null;
    if (priced) {
      const comma = priced[1].indexOf(",");
      pricedEntry =
        comma === -1
          ? { delta: priced[1].trim(), source: "", raw: priced[0] }
          : {
              delta: priced[1].slice(0, comma).trim(),
              source: priced[1].slice(comma + 1).trim(),
              raw: priced[0],
            };
    }

    block.lines.push({
      row: `${block.phase} Gate:${count}`,
      phase: block.phase,
      index: count,
      line: index,
      raw,
      text: stripMarkers(raw.replace(/^-\s*/, "")),
      verify: klass !== null && (VERIFY_CLASSES as readonly string[]).includes(klass) ? (klass as VerifyClass) : null,
      verifyRaw: klass,
      pointer,
      priced: pricedEntry,
      pricedRaw: priced ? priced[0] : null,
    });
  }
}

function stripMarkers(text: string): string {
  return text
    .replace(/\[VERIFY:\s*[^\]]*\]/gi, " ")
    .replace(/\[PRICED:\s*[^\]]*\]/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Every refusal, in rule order, then refuse once. `_ctx` is T-012's: it carries
 * the contract and the profile runs that exist so a *pointer* can be resolved;
 * this module judges shape only and resolves nothing.
 */
export function validateMilestone(model: MilestoneModel, _ctx: MilestoneContext = {}): Problem[] {
  return [
    ...model.problems,
    ...missingKeys(model),
    ...danglingDeps(model),
    ...idIsGate(model),
    ...placeholders(model),
    ...verifyNone(model),
    ...sassUnpriced(model),
    ...noMechanismLine(model),
    ...categoryTriggers(model),
    ...phaseOrder(model),
  ];
}

/** 1. The five-tuple is the decision. A key that is absent or empty is a decision nobody can act on. */
function missingKeys(model: MilestoneModel): Problem[] {
  const problems: Problem[] = [];
  for (const decision of model.decisions) {
    const absent: string[] = [];
    const empty: string[] = [];
    for (const key of FIVE_TUPLE_KEYS) {
      const row = decision.rows.find((entry) => normalizeKey(entry.key) === normalizeKey(key));
      if (!row) absent.push(key);
      else if (row.value.trim() === "") empty.push(key);
    }
    const unknown = decision.unknownRows.map((row) => row.key);
    if (absent.length === 0 && empty.length === 0 && unknown.length === 0) continue;

    const parts: string[] = [];
    if (absent.length > 0) parts.push(`${absent.join(", ")} absent`);
    if (empty.length > 0) parts.push(`${empty.join(", ")} empty`);
    if (unknown.length > 0) {
      parts.push(`${unknown.map((key) => `"${key}" is not one of the five`).join(", ")}`);
    }
    const missingKeysToWrite = [...absent, ...empty];
    const fix =
      missingKeysToWrite.length > 0
        ? `write one line per key under ${decision.id}: ${missingKeysToWrite.map((key) => `"- ${key}: …"`).join(", ")}`
        : `spell the key as one of ${FIVE_TUPLE_KEYS.join(", ")} — the five-tuple is enforced literally`;
    problems.push(
      makeProblem(
        "route-missing-key",
        decision.id,
        `the five-tuple is incomplete — ${parts.join("; ")}. A key that is not written is a decision nobody can action or invalidate.`,
        fix,
      ),
    );
  }
  return problems;
}

/** 2. An edge to a decision that does not exist silently under-invalidates resume. */
function danglingDeps(model: MilestoneModel): Problem[] {
  const defined = new Set(model.decisions.map((decision) => decision.id));
  const known = [...defined].join(", ") || "none";
  const problems: Problem[] = [];
  for (const decision of model.decisions) {
    for (const dep of decision.deps) {
      if (dep.id === decision.id) {
        problems.push(
          makeProblem(
            "route-dangling-dep",
            decision.id,
            `"Depends on" names ${dep.id}, the decision itself; a self-edge is not a dependency and tells a resume nothing about what must land first.`,
            `point the row at the decision this one rides on, or write "- Depends on: none"`,
          ),
        );
        continue;
      }
      if (defined.has(dep.id)) continue;
      problems.push(
        makeProblem(
          "route-dangling-dep",
          decision.id,
          `"Depends on" names ${dep.id}, which no decision defines (the milestone defines ${known}); a dangling edge silently under-invalidates resume.`,
          `add the decision ("#### ${dep.id} <name>") or correct the id; an edge to nothing is not an edge`,
        ),
      );
    }
  }
  return problems;
}

/** 3. A decision whose id or heading says "gate" is read as a gate: it would silently become a full eval. */
function idIsGate(model: MilestoneModel): Problem[] {
  const problems: Problem[] = [];
  for (const decision of model.decisions) {
    const hits: string[] = [];
    if (/gate/i.test(decision.id)) hits.push(`the id "${decision.id}"`);
    if (/gate/i.test(decision.name)) hits.push(`the heading "${decision.heading.trim()}"`);
    if (hits.length === 0) continue;
    problems.push(
      makeProblem(
        "route-id-is-gate",
        decision.id,
        `${hits.join(" and ")} contains "gate", which reads as a gate block — the decision would silently become a full eval instead of a change.`,
        `rename it after what changes (e.g. "#### ${decision.id} Tile-size choice") and put the proof in "### M<k> Gate"`,
      ),
    );
  }
  return problems;
}

/** 4. A row that still holds `<...>` or a template sentence is not a decision. */
function placeholders(model: MilestoneModel): Problem[] {
  const problems: Problem[] = [];

  for (const decision of model.decisions) {
    if (isPlaceholder(decision.name)) {
      problems.push(
        makeProblem(
          "route-placeholder",
          decision.id,
          `the heading still holds the placeholder "${decision.name}" — a form row is not a decision.`,
          `name what changes, e.g. "#### ${decision.id} Double-buffer the smem tile"`,
        ),
      );
    }
    for (const row of decision.rows) {
      if (!isPlaceholder(row.value)) continue;
      problems.push(
        makeProblem(
          "route-placeholder",
          decision.id,
          `"${row.key}" still holds the placeholder "${row.value}" (line ${row.line + 1}); a row nobody filled is a decision nobody made.`,
          `write the one line it stands for, or delete ${decision.id} — a placeholder that validates is worse than no decision`,
        ),
      );
    }
    for (const row of decision.unknownRows) {
      if (!isPlaceholder(row.value)) continue;
      problems.push(
        makeProblem(
          "route-placeholder",
          decision.id,
          `"${row.key}" still holds the placeholder "${row.value}" (line ${row.line + 1}), and "${row.key}" is not one of the five keys.`,
          `spell the key as one of ${FIVE_TUPLE_KEYS.join(", ")} and write the row`,
        ),
      );
    }
  }

  for (const phase of model.phases) {
    if (phase.kind === "gate" || !isPlaceholder(phase.name)) continue;
    problems.push(
      makeProblem(
        "route-placeholder",
        phase.id,
        `the phase heading still holds the placeholder "${phase.name}".`,
        `name the phase, e.g. "### ${phase.id} Architecture"`,
      ),
    );
  }

  for (const gate of model.gates) {
    for (const line of gate.lines) {
      if (!isPlaceholder(line.text)) continue;
      problems.push(
        makeProblem(
          "route-placeholder",
          line.row,
          `the gate line still holds the placeholder "${line.text}" (line ${line.line + 1}); a gate that names nothing proves nothing.`,
          `write what would prove it, e.g. "- device_ms halves on m1024/typical [VERIFY: ncu-direct profile:run1]"`,
        ),
      );
    }
  }

  for (let index = 0; index < model.deadEnds.length; index += 1) {
    const row = model.deadEnds[index];
    if (!isPlaceholder(row)) continue;
    problems.push(
      makeProblem(
        "route-placeholder",
        `Dead Ends:${index + 1}`,
        `the dead-end row still holds the placeholder "${row}"; a banned combination with no reason bans nothing.`,
        `write it as "- <D ids> | <reason> | <evidence pointer>"`,
      ),
    );
  }

  for (const section of model.sections) {
    for (let index = section.start + 1; index < section.end; index += 1) {
      if (insideBlock(model, index)) continue;
      const text = model.lines[index].trim();
      if (text === "" || /^#{1,6}\s/.test(text)) continue;
      if (!isPlaceholder(text)) continue;
      problems.push(
        makeProblem(
          "route-placeholder",
          sectionLabel(section),
          `line ${index + 1} still holds the placeholder "${text}"; the section says nothing yet.`,
          `write what the section is for in the words of this task, or remove the line`,
        ),
      );
    }
  }

  return problems;
}

/** 5. A gate line must say what proves it. `none` is the one thing a gate cannot accept. */
function verifyNone(model: MilestoneModel): Problem[] {
  const problems: Problem[] = [];
  for (const gate of model.gates) {
    for (const line of gate.lines) {
      if (line.verify !== null) continue;
      const shown = line.text === "" ? "(a line with no words)" : `"${line.text}"`;
      if (line.verifyRaw === null) {
        problems.push(
          makeProblem(
            "gate-verify-none",
            line.row,
            `${shown} carries no [VERIFY: …] at all, so nothing says what would prove it (line ${line.line + 1}).`,
            `append one class: [VERIFY: ncu-direct profile:<run>], [VERIFY: ncu-derived profile:<run>], [VERIFY: correctness cell/group: <cell>/<group>], [VERIFY: sass-derived][PRICED: <delta>, <source>], or [VERIFY: mechanism]`,
          ),
        );
        continue;
      }
      if (line.verifyRaw === VERIFY_NONE) {
        problems.push(
          makeProblem(
            "gate-verify-none",
            line.row,
            `${shown} carries [VERIFY: none]; "none" means nothing proves this, which is the one thing a gate line may not say (line ${line.line + 1}).`,
            `name what proves it — a profile run, a cell/group the checks cover, a priced SASS claim, or the mechanism itself — or drop the line`,
          ),
        );
        continue;
      }
      problems.push(
        makeProblem(
          "gate-verify-none",
          line.row,
          `${shown} carries [VERIFY: ${line.verifyRaw}], which is not a class this build reads (${VERIFY_CLASSES.join(", ")}; line ${line.line + 1}).`,
          `use one of ${VERIFY_CLASSES.join(", ")}; an unknown class is not evidence`,
        ),
      );
    }
  }
  return problems;
}

/** 6. A SASS-shaped claim without a measured price is a guess. */
function sassUnpriced(model: MilestoneModel): Problem[] {
  const problems: Problem[] = [];
  for (const gate of model.gates) {
    for (const line of gate.lines) {
      if (line.verify !== "sass-derived") continue;
      if (line.priced === null) {
        problems.push(
          makeProblem(
            "gate-sass-unpriced",
            line.row,
            `[VERIFY: sass-derived] carries no [PRICED: <delta>, <source>] on the same line (line ${line.line + 1}); a SASS-shaped claim without a measured price is a guess.`,
            `add the price to the same line, e.g. "[PRICED: -8% issue slots, profile:run2]"`,
          ),
        );
        continue;
      }
      if (line.priced.source === "") {
        problems.push(
          makeProblem(
            "gate-sass-unpriced",
            line.row,
            `[PRICED: ${line.priced.delta}] names a delta with no source (line ${line.line + 1}); a price with no origin cannot be checked.`,
            `write "[PRICED: <delta>, <source>]" where the source is the profile run the price came from`,
          ),
        );
      }
    }
  }
  return problems;
}

/** 7. Every milestone carries at least one gate line that says something is proved. */
function noMechanismLine(model: MilestoneModel): Problem[] {
  const all = model.gates.flatMap((gate) => gate.lines);
  if (all.some(namesSomething)) return [];
  if (all.length === 0) {
    return [
      makeProblem(
        "gate-no-mechanism-line",
        "milestone",
        `the milestone has no gate line at all — nothing in it says what would prove a phase landed.`,
        `add "### M0 Gate" with at least one line naming the observable that would show the mechanism, e.g. "- the smem tile double-buffers and ncu reports no partial waves [VERIFY: mechanism]"`,
      ),
    ];
  }
  const shown = all
    .slice(0, 4)
    .map((line) => `${line.row} (${line.verifyRaw === null ? "no [VERIFY: …]" : `[VERIFY: ${line.verifyRaw}]`})`)
    .join(", ");
  return [
    makeProblem(
      "gate-no-mechanism-line",
      "milestone",
      `none of the ${all.length} gate line(s) says what is proved — ${shown}${all.length > 4 ? ", …" : ""} is either "none", markerless, or a bare number, so the milestone cannot be validated as landed.`,
      `make one line say the mechanism, and say it in words: "- the inner loop is double-buffered and issues 2 LDG per 128 B [VERIFY: mechanism]", or cite the profile run that shows it`,
    ),
  ];
}

/** 8. A trigger is an observable, never a category. */
function categoryTriggers(model: MilestoneModel): Problem[] {
  const problems: Problem[] = [];
  for (const decision of model.decisions) {
    const row = decision.rows.find((entry) => normalizeKey(entry.key) === normalizeKey("Trigger"));
    if (!row) continue; // rule 1 owns a missing Trigger
    const phrase = categoryPhrase(row.value);
    if (phrase === null) continue;
    problems.push(
      makeProblem(
        "trigger-is-category",
        decision.id,
        `the Trigger says "${phrase}" — a category, not an observable, so nothing tells the agent the decision is due (line ${row.line + 1}).`,
        `name a number or an event on the reference, e.g. "waves/SM < 1 on the reference" or "ncu reports DRAM throughput above 80% on m1024/typical"`,
      ),
    );
  }
  return problems;
}

/** The structural rule: phases are one sequence, read in file order. */
function phaseOrder(model: MilestoneModel): Problem[] {
  const problems: Problem[] = [];
  const seen = new Map<string, Phase>();
  // Refuse a phase once: a misplaced `### M0 Architecture` and its `### M0 Gate`
  // are one edit, so one refusal is what a reader can act on.
  const reported = new Set<string>();
  let highest: Phase | null = null;

  // A phase id is written twice on purpose — `### M0 Architecture` and
  // `### M0 Gate` are the same phase — so only two blocks of the *same* kind
  // collide, and a second `### M0 …` decision block makes every D0.* ambiguous.
  for (const phase of [...model.phases].sort((left, right) => left.start - right.start)) {
    if (phase.index < 0) continue;
    const earlier = seen.get(`${phase.kind}\u0000${phase.id}`);
    if (earlier) {
      problems.push(
        makeProblem(
          "phase-order",
          phase.id,
          `"${phase.heading.trim()}" is the second ${phase.kind === "gate" ? "gate" : "phase"} block for ${phase.id} (line ${earlier.start + 1} and line ${phase.start + 1}); a phase id addresses its ${phase.kind === "gate" ? "gate lines" : "decisions"}, so the second block makes the address ambiguous.`,
          `renumber the later block (M${Math.max(...model.phases.map((entry) => entry.index)) + 1}) or merge it into the first`,
        ),
      );
      continue;
    }
    if (highest && phase.index < highest.index && !reported.has(phase.id)) {
      problems.push(
        makeProblem(
          "phase-order",
          phase.id,
          `the "${phase.heading.trim()}" block appears after "${highest.heading.trim()}"; phases are one sequence M0, M1, … and a later-numbered block before an earlier one makes the order a claim this file does not make.`,
          `move the ${phase.id} blocks before "${highest.heading.trim()}", or renumber them`,
        ),
      );
      reported.add(phase.id);
    }
    seen.set(`${phase.kind}\u0000${phase.id}`, phase);
    if (!highest || phase.index > highest.index) highest = phase;
  }

  return problems;
}

function makeProblem(rule: MilestoneRuleId, row: string, what: string, fix: string): Problem {
  return { rule, row, what, fix, message: `${rule} ${row}: ${what} Fix: ${fix}` };
}

function normalizeKey(key: string): string {
  return key.trim().toLowerCase().replace(/\s+/g, " ");
}

function sectionLabel(section: Section): string {
  return section.number === null ? section.title : `${section.number}. ${section.title}`;
}

/** Every line index that belongs to a phase block (which includes its decisions). */
function insideBlock(model: MilestoneModel, index: number): boolean {
  if (model.phases.some((phase) => index >= phase.start && index < phase.end)) return true;
  return model.decisions.some((decision) => index >= decision.start && index < decision.end);
}

const PLACEHOLDER = /<[^<>\n]*>/;

/** `<...>` anywhere, or one of the template's own sentences verbatim. */
export function isPlaceholder(value: string): boolean {
  const text = value.trim();
  if (PLACEHOLDER.test(text)) return true;
  const normalized = text.toLowerCase().replace(/\s+/g, " ").replace(/\.$/, "").trim();
  return (TEMPLATE_SENTENCES as readonly string[]).includes(normalized);
}

/** A gate line whose words say something: a class is not a class of evidence if the line is empty or a bare number. */
const BARE_NUMBER = /^[<>=≤≥~≈]*\s*[\d.,]+\s*(?:%|x|×)?\s*(?:ns|us|µs|ms|s|kib|mib|gib|b)?$/i;

function namesSomething(line: GateLine): boolean {
  if (line.verify === null) return false;
  const text = line.text.trim();
  if (text === "") return false;
  return !BARE_NUMBER.test(text);
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

/** The value under one of the five keys, or null when the row is absent. */
export function decisionValue(decision: Decision, key: FiveTupleKey): string | null {
  const row = decision.rows.find((entry) => normalizeKey(entry.key) === normalizeKey(key));
  return row ? row.value : null;
}

/** `⇐ D0.1, ⊗ D0.2`, or `none`. */
export function formatDependencies(decision: Decision): string {
  if (decision.deps.length === 0) return "none";
  return decision.deps.map((dep) => `${dep.arrow ?? "?"} ${dep.id}`).join(", ");
}

/**
 * What the tool prints when the file validates: the plan, addressably. One line
 * per phase, decision and gate line, each carrying the id a later refusal or a
 * `kernel_candidate` keep can name.
 */
export function formatMilestoneSummary(model: MilestoneModel): string {
  const lines: string[] = [];
  const sectionList = model.sections.map((section) => sectionLabel(section)).join(", ");
  lines.push(
    `${model.sections.length} section(s)${sectionList === "" ? "" : `: ${sectionList}`}; ${model.decisions.length} decision(s); ${model.gates.length} gate block(s)`,
  );

  if (model.phases.length > 0) {
    lines.push("phases:");
    for (const phase of model.phases) {
      const owned = model.decisions.filter((decision) => decision.phase === phase.id);
      if (phase.kind === "gate") {
        const block = model.gates.find((entry) => entry.phase === phase.id);
        lines.push(`  ${phase.id} ${phase.name} — ${block?.lines.length ?? 0} gate line(s)`);
      } else {
        lines.push(`  ${phase.id} ${phase.name} — ${owned.length} decision(s)`);
      }
    }
  }

  if (model.decisions.length > 0) {
    lines.push("decisions:");
    for (const decision of model.decisions) {
      const owner = decision.phase === null ? "no phase" : decision.phase;
      lines.push(`  ${decision.id} ${decision.name} (${owner}) — depends on ${formatDependencies(decision)}`);
    }
  }

  if (model.gates.length > 0) {
    lines.push("gates:");
    for (const gate of model.gates) {
      for (const line of gate.lines) {
        const klass = line.verifyRaw === null ? "no [VERIFY: …]" : `[VERIFY: ${line.verifyRaw}]`;
        const pointer = line.pointer === null ? "" : ` ${line.pointer}`;
        const priced = line.priced === null ? "" : ` [PRICED: ${line.priced.delta}, ${line.priced.source}]`;
        lines.push(
          `  ${line.row} ${klass}${pointer}${priced} — ${line.text === "" ? "(no words)" : line.text}`,
        );
      }
    }
  }

  if (model.deadEnds.length > 0) {
    lines.push(`dead ends: ${model.deadEnds.length} row(s)`);
  }

  return lines.join("\n");
}

/** One refusal per line, in rule order: what is wrong and the fix, already composed. */
export function formatMilestoneProblems(problems: readonly Problem[]): string {
  return problems.map((problem, index) => `${index + 1}. ${problem.message}`).join("\n");
}
