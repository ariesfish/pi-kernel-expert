import * as fs from "node:fs";
import * as path from "node:path";

import { KB_ARCHES, type KbTree, validateIndexes } from "./kb.ts";

/**
 * Five rules over `kb/`, and a failure mode that is itself a finding: a tree the
 * lint could not read is reported as "nothing was scanned", never as clean.
 *
 * The rules are the port of a much larger upstream lint (seven rules keyed by
 * reader), minus everything that needed a loop. What survives is what can be
 * checked from the text:
 *
 * 1. an upstream symbol used as a name (`kb-reference-token`) — an exact symbol
 *    is a retrieval key into pretraining memory, with more bandwidth than any
 *    paraphrase;
 * 2. a line citation a reader cannot open (`kb-line-ref`);
 * 3. session narrative — run dates, iteration numbers, commit shas
 *    (`kb-narrative`);
 * 4. a missing arch index (`kb-missing-index`) — fail closed;
 * 5. a claim that outruns its evidence (`kb-uncertified-claim`).
 *
 * Rules 1–3 exempt `README.md` and `TEMPLATE.md`: the files that state a rule
 * have to be able to name what it forbids.
 */

export const KB_LINT_RULES = [
  "kb-reference-token",
  "kb-line-ref",
  "kb-narrative",
  "kb-missing-index",
  "kb-uncertified-claim",
] as const;
export type KbLintRule = (typeof KB_LINT_RULES)[number];

export interface LintFinding {
  rule: KbLintRule;
  /** Path relative to the workspace, and a line when the finding has one. */
  where: string;
  why: string;
  fix: string;
}

/** The files the first three rules do not apply to. */
const EXEMPT = new Set(["README.md", "TEMPLATE.md", "index.md"]);

/** Sources that make a line reference legitimate: the reader can open them. */
const LINE_REF_SOURCES = [
  "docs.nvidia.com",
  "nvidia.github.io",
  "forums.developer.nvidia.com",
  "PTX ISA",
  "cutlass",
  "CUTLASS",
  "cute/",
  "CuTeDSL",
  "third_party",
  "examples/python",
  "probe_",
  "notes/",
  "scripts/",
  "hw_kb/",
  ".md)",
] as const;

/** Line-shaped citations: `L123`, `file.py:412`, `lines 40-52`. */
const LINE_REF = /\bL\d{2,}\b|\.(?:py|cu|cuh|cc|cpp|cxx|hpp|hh|h):\d+|\blines?\s*~?\s*\d+/;

/** Session narrative: run dates, `iter N`, and shas that are not prose. */
const NARRATIVE: Array<{ pattern: RegExp; what: string }> = [
  { pattern: /\b20\d{2}-[01]\d-[0-3]\d\b/, what: "a calendar date" },
  { pattern: /\b(?:0[1-9]|1[0-2])[0-3]\d\s*(?:[A-Za-z0-9]+[_\-][A-Za-z0-9]+\s+)?(?:arm|run)\b/, what: "a run reference" },
  { pattern: /\biter\s*\d+/i, what: "an iteration number" },
  { pattern: /(?=[0-9a-f]*[a-f])(?=[0-9a-f]*[0-9])[0-9a-f]{7,12}\b/i, what: "a commit or cubin sha" },
];

export interface LintOptions {
  /** Extra tokens to protect, one per line. Read from `docs/reference-tokens.txt`. */
  referenceTokens?: readonly string[];
}

export interface LintReport {
  findings: LintFinding[];
  /** Files scanned, so a clean report can say what it covered. */
  scanned: string[];
}

/**
 * Lint the tree. `tree === null` (no `kb/` at all) is a finding: fail closed.
 */
export function lintKb(root: string, tree: KbTree | null, options: LintOptions = {}): LintReport {
  if (tree === null) {
    return {
      findings: [
        {
          rule: "kb-missing-index",
          where: `${path.join(root, "kb")}:0`,
          why: "there is no kb/ tree — nothing was scanned, so nothing is certified leak-free",
          fix: "create kb/<arch>/index.md with a symptom row per entry, or stop citing KB: in this workspace",
        },
      ],
      scanned: [],
    };
  }

  const findings: LintFinding[] = [];
  const scanned: string[] = [];
  const tokens = (options.referenceTokens ?? []).map((token) => token.trim()).filter((token) => token !== "");

  for (const index of tree.indexes) {
    scanned.push(path.relative(root, index.path));
  }
  for (const arch of KB_ARCHES) {
    const index = tree.indexes.find((candidate) => candidate.arch === arch);
    if (!index && tree.entries.some((entry) => entry.arch === arch)) {
      findings.push({
        rule: "kb-missing-index",
        where: `kb/${arch}`,
        why: `kb/${arch}/ holds entries and no index.md: a reader with a symptom has no way in, and a tree nobody scanned is not leak-free`,
        fix: `add kb/${arch}/index.md with one symptom row per entry`,
      });
    }
  }

  for (const entry of tree.entries) {
    scanned.push(entry.path);
    const lines = entry.body.split("\n");
    lines.forEach((line, index) => {
      const where = `${entry.path}:${index + 1}`;
      // The certification header and the status line are the one place a date
      // belongs: a MEASURED status is a run at a time on a card, and the header
      // cites the probe. Everywhere else a date is a session log.
      const isProvenance = /^\s*(?:[-*]\s*)?(?:\*\*)?(?:Certification source|Certification covers|Uncertified|Status|Verified)(?:\*\*)?\s*:/i.test(line);
      if (!EXEMPT.has(path.basename(entry.path)) && !isProvenance) {
        for (const token of tokens) {
          if (line.toLowerCase().includes(token.toLowerCase())) {
            findings.push({
              rule: "kb-reference-token",
              where,
              why: `names ${JSON.stringify(token)}, an upstream symbol: an exact symbol is a retrieval key into pretraining memory, and the entry is supposed to be a mechanism`,
              fix: "describe the mechanism in your own words; if the source must be named, put it in docs/reference-tokens.txt's README, not in an entry",
            });
          }
        }
        if (LINE_REF.test(line) && !LINE_REF_SOURCES.some((source) => line.includes(source))) {
          findings.push({
            rule: "kb-line-ref",
            where,
            why: `cites a line (${LINE_REF.exec(line)?.[0] ?? ""}) with no source a reader can open on the same line`,
            fix: "name the document (its URL, or a probe under notes/), or drop the line number and keep the claim",
          });
        }
        for (const narrative of NARRATIVE) {
          if (narrative.pattern.test(line)) {
            findings.push({
              rule: "kb-narrative",
              where,
              why: `carries ${narrative.what}: an entry is a mechanism, not a session log`,
              fix: "move the session detail into the run archive and keep the mechanism here",
            });
            break;
          }
        }
      }

      const status = /^\s*[-*]?\s*(status|verified)\s*:\s*(.+)$/i.exec(line);
      if (status) {
        const value = status[2].trim();
        if (/^MEASURED\b/i.test(value) && !/\d{4}-\d{2}-\d{2}/.test(value)) {
          findings.push({
            rule: "kb-uncertified-claim",
            where,
            why: `claims MEASURED with no date (${JSON.stringify(value)}): a measurement is a run at a time on a card`,
            fix: "write `MEASURED <gpu> <yyyy-mm-dd>`, or downgrade to `UNVERIFIED — <what is missing>`",
          });
        }
        if (/^MEASURED\b/i.test(value) && !/NVIDIA|A100|H100|H200|B200|GB200|RTX|L40|MI\d/i.test(value)) {
          findings.push({
            rule: "kb-uncertified-claim",
            where,
            why: `claims MEASURED with no GPU (${JSON.stringify(value)})`,
            fix: "name the card the number came from: a number without a card is a rumour",
          });
        }
        if (/^UNVERIFIED\b/i.test(value) && !/(—|-|:)\s*\S/.test(value)) {
          findings.push({
            rule: "kb-uncertified-claim",
            where,
            why: "says UNVERIFIED without saying what is missing, which reads the same as forgotten",
            fix: "write `UNVERIFIED — <the measurement that is missing>`",
          });
        }
      }
    });

    if (!entry.sections.some((section) => /^certification boundary$/i.test(section))) {
      findings.push({
        rule: "kb-uncertified-claim",
        where: entry.path,
        why: "has no `## Certification boundary` section: every entry grows one, even when the boundary is `we never ran this on sm120`",
        fix: "add the section and state what the claim does not cover",
      });
    }
  }

  for (const problem of validateIndexes(tree)) {
    const rule: KbLintRule =
      problem.rule === "kb-index-duplicate" || problem.rule === "kb-index-status-drift" ? "kb-missing-index" : "kb-missing-index";
    findings.push({ rule, where: "kb/index", why: problem.what, fix: problem.fix });
  }

  return { findings, scanned };
}

/** `docs/reference-tokens.txt`, one token per line, `#` comments. */
export function readReferenceTokens(root: string): string[] {
  const file = path.join(root, "docs", "reference-tokens.txt");
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .map((line) => line.replace(/#.*$/, "").trim())
    .filter((line) => line !== "");
}
