import * as fs from "node:fs";
import * as path from "node:path";

/**
 * The local KB container: `kb/<arch>/<entry>.md` plus a symptom index per arch.
 *
 * This is the second tier the corpus cannot be. A kernel-wiki page carries a
 * confidence label and supports a *direction*; an entry here carries its own
 * measured footprint and its own boundary, and it supports a *price* — because a
 * citation from it can be refused. That is the whole difference, and it is
 * mechanical: `cite` looks for a certification mark and a status, and says no.
 *
 * Three statuses, each with an invariant:
 *
 * - `MEASURED <gpu> <date>` — claims a run, so it needs the GPU, the date, and a
 *   command the entry names.
 * - `UNVERIFIED — <what is missing>` — claims nothing, and must say what is
 *   missing. That dash is load-bearing: it is the difference between "we did not
 *   run this" and "we forgot".
 * - `TODO` — nobody has looked. Legal to write, not legal to cite.
 */

export const KB_DIR = "kb";
export const KB_ARCHES = ["sm80", "sm90", "sm100", "sm120", "generic"] as const;
export type KbArch = (typeof KB_ARCHES)[number];

/** The five sections every entry carries, in the corpus's own words. */
export const KB_SECTIONS = ["Purpose", "When needed (trigger)", "Mechanism", "Measured footprint and cost", "Gotchas"] as const;

/** The two additions every real entry grows. */
export const KB_BOUNDARY = "Certification boundary";

export type KbStatus =
  | { kind: "measured"; gpu: string; date: string; rest: string }
  | { kind: "unverified"; missing: string }
  | { kind: "todo"; rest: string };

export interface KbEntry {
  id: string;
  arch: KbArch;
  path: string;
  /** The raw status line, as written. */
  statusRaw: string;
  status: KbStatus | null;
  /** The certification header values, when the entry has one. */
  certificationSource: string | null;
  certificationCovers: string | null;
  uncertified: string | null;
  /** Section headings found, normalized to the five names plus the boundary. */
  sections: string[];
  body: string;
}

export interface KbTree {
  root: string;
  entries: KbEntry[];
  /** `<arch>/index.md` files that exist. */
  indexes: Array<{ arch: string; path: string; rows: KbIndexRow[] }>;
  /** Reasons the tree could not be read at all; empty when it could. */
  problems: string[];
}

export interface KbIndexRow {
  symptom: string;
  entry: string;
  statusRaw: string;
  line: number;
}

/** `MEASURED NVIDIA H200 2026-11-10` / `UNVERIFIED — no sm120 run` / `TODO` */
export function parseStatus(raw: string): KbStatus | null {
  const text = raw.trim().replace(/^[-*]\s*/, "");
  const measured = /^MEASURED\s+(\S+(?:\s+\S+)*?)\s+(\d{4}-\d{2}-\d{2})\b(.*)$/i.exec(text);
  if (measured) return { kind: "measured", gpu: measured[1].trim(), date: measured[2], rest: measured[3].trim() };
  const unverified = /^UNVERIFIED\s*(?:—|-|:)\s*(.+)$/i.exec(text);
  if (unverified) return { kind: "unverified", missing: unverified[1].trim() };
  if (/^TODO\b/i.test(text)) return { kind: "todo", rest: text.slice(4).trim() };
  return null;
}

/** The `${arch}` half of a path, when it is one of the five. */
export function archOf(value: string): KbArch | null {
  return (KB_ARCHES as readonly string[]).includes(value) ? (value as KbArch) : null;
}

/**
 * Read `<root>/kb`. A missing tree is not an empty tree: it is `null`-shaped and
 * the caller refuses, because a citation resolved against nothing is a pass that
 * nobody earned.
 */
export function readKbTree(root: string): KbTree | null {
  const dir = path.join(root, KB_DIR);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return null;
  const tree: KbTree = { root: dir, entries: [], indexes: [], problems: [] };
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const arch = archOf(entry.name);
    if (!arch) {
      tree.problems.push(`${KB_DIR}/${entry.name} is not one of ${KB_ARCHES.join(", ")}`);
      continue;
    }
    const archDir = path.join(dir, entry.name);
    const indexPath = path.join(archDir, "index.md");
    if (fs.existsSync(indexPath)) {
      tree.indexes.push({ arch, path: indexPath, rows: readIndex(fs.readFileSync(indexPath, "utf8")) });
    }
    for (const file of fs.readdirSync(archDir, { withFileTypes: true })) {
      if (!file.isFile() || !file.name.endsWith(".md") || file.name === "index.md") continue;
      if (file.name === "README.md" || file.name === "TEMPLATE.md") continue;
      tree.entries.push(readEntry(path.join(archDir, file.name), arch, path.relative(root, path.join(archDir, file.name))));
    }
  }
  tree.entries.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  return tree;
}

export function readEntry(file: string, arch: KbArch, relative: string): KbEntry {
  const body = fs.readFileSync(file, "utf8");
  const statusLine = body.split("\n").find((line) => /^\s*[-*]?\s*(status|verified)\s*:/i.test(line)) ?? "";
  const statusValue = statusLine.replace(/^\s*[-*]?\s*(status|verified)\s*:\s*/i, "");
  const headings = [...body.matchAll(/^##\s+(.+?)\s*$/gm)].map((match) => match[1]);
  return {
    id: path.basename(file, ".md"),
    arch,
    path: relative,
    statusRaw: statusValue,
    status: statusValue === "" ? null : parseStatus(statusValue),
    certificationSource: headerValue(body, "Certification source"),
    certificationCovers: headerValue(body, "Certification covers"),
    uncertified: headerValue(body, "Uncertified"),
    sections: headings,
    body,
  };
}

/** `**Certification source:**  probe 7 on h200-7, 2026-11-10` and the `- Key: value` form. */
function headerValue(body: string, key: string): string | null {
  const line = body
    .split("\n")
    .find((candidate) => new RegExp(`^\\s*(?:[-*]\\s*)?(?:\\*\\*)?${key}(?:\\*\\*)?\\s*:`, "i").test(candidate));
  if (!line) return null;
  const value = line.replace(new RegExp(`^\\s*(?:[-*]\\s*)?(?:\\*\\*)?${key}(?:\\*\\*)?\\s*:`, "i"), "").replace(/\*\*/g, "").trim();
  return value === "" ? null : value;
}

// --- the citation ----------------------------------------------------------

export type CiteResult =
  | { ok: true; token: string; entry: KbEntry }
  | { ok: false; rule: string; reason: string; fix: string };

/**
 * `KB:<entry>` may be emitted only for an entry that claims a run: the mark, the
 * status, the boundary, and a command. Everything else is refused with what is
 * missing, because a transcribed recipe is not a price.
 */
export function cite(tree: KbTree | null, id: string): CiteResult {
  if (tree === null) {
    return {
      ok: false,
      rule: "kb-absent",
      reason: `there is no ${KB_DIR}/ tree in this workspace, so KB:${id} resolves against nothing`,
      fix: `create ${KB_DIR}/<arch>/index.md and the entry, or cite a profile run instead`,
    };
  }
  const entry = tree.entries.find((candidate) => candidate.id === id);
  if (!entry) {
    return {
      ok: false,
      rule: "kb-entry-unknown",
      reason: `no entry ${id} under ${tree.root} (it has ${tree.entries.length === 0 ? "none" : tree.entries.map((candidate) => candidate.id).join(", ")})`,
      fix: "use the entry's own id, or write the entry first — an id nobody can look up is a note to self",
    };
  }
  const missing: string[] = [];
  if (entry.certificationSource === null) missing.push("no `Certification source:` line");
  if (entry.status === null) missing.push(`no status line (${entry.statusRaw === "" ? "none" : `unreadable: ${JSON.stringify(entry.statusRaw)}`})`);
  if (!entry.sections.some((section) => section.toLowerCase() === KB_BOUNDARY.toLowerCase())) missing.push(`no \`## ${KB_BOUNDARY}\` section`);
  if (!entry.body.includes("```")) missing.push("no fenced command");

  if (entry.status?.kind === "measured" && (!entry.status.gpu || !entry.status.date)) {
    missing.push("a MEASURED status without both a GPU and a date");
  }
  // A status that does not claim a run cannot back a price, even when everything
  // else about the entry is in place: that is the entire point of the status.
  if (entry.status !== null && entry.status.kind !== "measured") {
    return {
      ok: false,
      rule: entry.status.kind === "unverified" ? "kb-entry-unverified" : "kb-entry-todo",
      reason: `${entry.path} is ${entry.status.kind === "unverified" ? `UNVERIFIED (${entry.status.missing})` : "TODO"} — nobody has measured it, so it cannot price a gate line. Cite a profile run instead, or measure it.`,
      fix: "run the probe, then set `MEASURED <gpu> <yyyy-mm-dd>` and name the command; until then this is a direction, not evidence",
    };
  }

  if (missing.length > 0) {
    return {
      ok: false,
      rule: "kb-entry-uncertified",
      reason: `${entry.path} cannot be cited: ${missing.join("; ")}. A citation is what lets a claim be checked, and this entry cannot be.`,
      fix: "add the certification header, the status line, the boundary section and the command, or cite a profile run",
    };
  }
  return { ok: true, token: `KB:${entry.id}`, entry };
}

// --- the index -------------------------------------------------------------

/** A symptom-ledger row: `| symptom | entry | status |`. */
export function readIndex(text: string): KbIndexRow[] {
  const rows: KbIndexRow[] = [];
  text.split("\n").forEach((line, index) => {
    const cells = line.split("|").map((cell) => cell.trim());
    if (cells.length < 5) return;
    const [, symptom, entry, status] = cells;
    if (symptom === "" || /^-+$/.test(symptom) || /^symptom$/i.test(symptom)) return;
    rows.push({ symptom, entry: entry.replace(/`/g, ""), statusRaw: status, line: index + 1 });
  });
  return rows;
}

export interface IndexProblem {
  rule: string;
  what: string;
  fix: string;
}

/**
 * The index is validated, never generated. A generated index is a table of
 * contents again, and the symptom phrase is the judgment that makes the index
 * worth having: "these are the readings that mean this applies", not "here is
 * what exists".
 */
export function validateIndexes(tree: KbTree): IndexProblem[] {
  const problems: IndexProblem[] = [];
  for (const entry of tree.entries) {
    const index = tree.indexes.find((candidate) => candidate.arch === entry.arch);
    if (!index) continue;
    const rows = index.rows.filter((row) => row.entry === entry.id);
    if (rows.length === 0) {
      problems.push({
        rule: "kb-index-missing-row",
        what: `${entry.id} has no row in ${KB_DIR}/${entry.arch}/index.md, so nothing routes to it by symptom`,
        fix: "add a row whose symptom is an observable a reader would have just seen",
      });
    } else if (rows.length > 1) {
      problems.push({
        rule: "kb-index-duplicate",
        what: `${entry.id} has ${rows.length} rows in ${KB_DIR}/${entry.arch}/index.md (lines ${rows.map((row) => row.line).join(", ")}), so a symptom points at it twice`,
        fix: "keep the row whose symptom is the one a reader arrives with",
      });
    }
  }
  for (const index of tree.indexes) {
    const known = new Set(tree.entries.filter((entry) => entry.arch === index.arch).map((entry) => entry.id));
    for (const row of index.rows) {
      if (!known.has(row.entry)) {
        problems.push({
          rule: "kb-index-dangling",
          what: `${KB_DIR}/${index.arch}/index.md:${row.line} points at ${row.entry}, which is not an entry in ${KB_DIR}/${index.arch}/`,
          fix: "point the row at an entry that exists, or write it",
        });
      }
      const entry = tree.entries.find((candidate) => candidate.id === row.entry);
      if (entry && row.statusRaw !== "" && entry.statusRaw !== "" && normalizeStatus(row.statusRaw) !== normalizeStatus(entry.statusRaw)) {
        problems.push({
          rule: "kb-index-status-drift",
          what: `${KB_DIR}/${index.arch}/index.md:${row.line} says ${JSON.stringify(row.statusRaw)} and the entry says ${JSON.stringify(entry.statusRaw)}`,
          fix: "make the row repeat the entry's status, or fix the entry: the index is a claim about the entry, not an independent one",
        });
      }
    }
  }
  return problems;
}

function normalizeStatus(raw: string): string {
  return raw.toLowerCase().replace(/[`*]/g, "").replace(/\s+/g, " ").trim();
}
