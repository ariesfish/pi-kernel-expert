import * as fs from "node:fs";
import * as path from "node:path";

/**
 * The cached corpus, read as an index rather than as prose: which page ids
 * exist and what confidence each one claims.
 *
 * Two callers, one reader. `kernel_wiki_candidate` asks "is this id free?" and
 * `kernel_milestone` asks "does `wiki:<id>#<confidence>` point at something?".
 * Both questions are answered by the same walk of the same tree, so the walk
 * lives here and neither tool owns it.
 *
 * A page with no `confidence:` line is a real page — seven of the 52 in the
 * pinned corpus have none — so `confidence` is `string | null` and never
 * defaulted. Inventing a label would be a worse defect than recording the
 * absence.
 */

/** The four labels a citation may carry. The corpus itself may also carry none. */
export const CONFIDENCE_LABELS = ["verified", "source-reported", "inferred", "experimental"] as const;
export type Confidence = (typeof CONFIDENCE_LABELS)[number];

export interface CorpusPage {
  id: string;
  /** The page's own label, or null when the page has none. */
  confidence: string | null;
  /** Path relative to the corpus root, for a refusal that has to point somewhere. */
  path: string;
}

export interface CorpusIndex {
  /** The commit the corpus was fetched at; empty when the caller did not say. */
  pin: string;
  /** The directory read, so a refusal can name the lookup path. */
  dir: string;
  pages: CorpusPage[];
}

/**
 * Read `wiki/**.md` under `corpusDir`. `null` means the corpus is not cached:
 * an absence the caller must report, never a pass.
 */
export function readCorpusIndex(corpusDir: string, pin = ""): CorpusIndex | null {
  const wikiDir = path.join(corpusDir, "wiki");
  if (!fs.existsSync(wikiDir) || !fs.statSync(wikiDir).isDirectory()) return null;
  const pages: CorpusPage[] = [];
  const seen = new Set<string>();
  walkMarkdown(wikiDir, (file) => {
    const front = frontmatter(fs.readFileSync(file, "utf8"));
    if (front.id === null || seen.has(front.id)) return;
    seen.add(front.id);
    pages.push({ id: front.id, confidence: front.confidence, path: path.relative(corpusDir, file) });
  });
  pages.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  return { pin, dir: corpusDir, pages };
}

export function findCorpusPage(index: CorpusIndex, id: string): CorpusPage | null {
  return index.pages.find((page) => page.id === id) ?? null;
}

function walkMarkdown(dir: string, visit: (file: string) => void): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkMarkdown(full, visit);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".md")) visit(full);
  }
}

/** `id` and `confidence` from a page's frontmatter; both optional, both `null` when absent. */
function frontmatter(text: string): { id: string | null; confidence: string | null } {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (lines[0]?.trim() !== "---") return { id: null, confidence: null };
  let id: string | null = null;
  let confidence: string | null = null;
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index].trim() === "---") break;
    const idMatch = /^id:\s*(.+)$/.exec(lines[index]);
    if (idMatch && id === null) id = unquote(idMatch[1]);
    const confidenceMatch = /^confidence:\s*(.+)$/.exec(lines[index]);
    if (confidenceMatch && confidence === null) confidence = unquote(confidenceMatch[1]);
  }
  return { id, confidence };
}

function unquote(value: string): string {
  return value.trim().replace(/^["']|["']$/g, "");
}
