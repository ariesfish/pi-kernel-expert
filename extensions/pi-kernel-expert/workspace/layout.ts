import * as fs from "node:fs";
import * as path from "node:path";

/** KDA's plan-draft requirements, as headings the gate can check. */
export const DRAFT_HEADINGS = [
  "Baseline and validation",
  "Risks and unknowns",
  "Candidate directions",
  "First steps",
  "Validation and evaluation commands",
  "Evidence required",
] as const;

export const PLAN_HEADINGS = ["Steps", "Evidence per step", "Stop conditions"] as const;

export interface WorkspacePaths {
  root: string;
  docs: string;
  draft: string;
  plan: string;
  milestone: string;
  profile: string;
  runs: string;
  candidates: string;
  kernelDir: string;
  baseline: string;
  contract: string;
  benchmarkScript: string;
  checksScript: string;
  freezePayload: string;
}

export function workspacePaths(root: string): WorkspacePaths {
  const docs = path.join(root, "docs");
  const kernelDir = path.join(root, ".kernel");
  return {
    root,
    docs,
    draft: path.join(docs, "draft.md"),
    plan: path.join(docs, "plan.md"),
    milestone: path.join(docs, "milestone.md"),
    profile: path.join(root, "profile"),
    runs: path.join(root, "runs"),
    candidates: path.join(root, "candidates.jsonl"),
    kernelDir,
    baseline: path.join(kernelDir, "baseline.tsv"),
    contract: path.join(root, "kernel.contract.json"),
    benchmarkScript: path.join(root, "goal.sh"),
    checksScript: path.join(root, "goal.checks.sh"),
    freezePayload: path.join(root, "kernel-freeze.json"),
  };
}

export interface InitResult {
  root: string;
  created: string[];
  existing: string[];
}

/** Create the task workspace. Existing files are never overwritten. */
export function initWorkspace(root: string): InitResult {
  const paths = workspacePaths(root);
  const created: string[] = [];
  const existing: string[] = [];

  for (const dir of [paths.docs, paths.profile, paths.runs, paths.kernelDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const files: Array<[string, string]> = [
    [paths.draft, renderDraftTemplate()],
    [paths.plan, renderPlanTemplate()],
    [paths.milestone, renderMilestoneTemplate()],
    [paths.candidates, ""],
  ];
  for (const [file, body] of files) {
    if (fs.existsSync(file)) {
      existing.push(path.relative(root, file));
      continue;
    }
    fs.writeFileSync(file, body);
    created.push(path.relative(root, file));
  }

  return { root, created, existing };
}

export function renderDraftTemplate(): string {
  return [
    "# Plan draft",
    "",
    "Read `CONTEXT.md`-style vocabulary: the baseline is the thing you measured;",
    "the reference oracle decides correctness. Replace every `<...>` placeholder.",
    "",
    "## Baseline and validation",
    "<The current implementation, how it is built, and the command that proves it correct.>",
    "",
    "## Risks and unknowns",
    "<What could make the measurement lie or the comparison unfair.>",
    "",
    "## Candidate directions",
    "<Ranked by expected value and risk. One mechanism per direction; a direction that cannot fail is not a direction.>",
    "",
    "## First steps",
    "<The first concrete change and how it will be validated.>",
    "",
    "## Validation and evaluation commands",
    "<Exact commands. Validation = correctness; evaluation = the measured target.>",
    "",
    "## Evidence required",
    "<What must exist before a candidate is promoted: cells, tolerance, run count, profile freshness.>",
    "",
  ].join("\n");
}

export function renderPlanTemplate(): string {
  return [
    "# Executable plan",
    "",
    "## Steps",
    "<Ordered steps, each one ending in a runnable check.>",
    "",
    "## Evidence per step",
    "<Step → artifact or command output that proves it passed.>",
    "",
    "## Stop conditions",
    "<What makes the loop stop: promotion met, budget exhausted, or an explicit blocker.>",
    "",
  ].join("\n");
}

/**
 * The milestone template. Every slot is a `<...>` placeholder on purpose: the
 * validator refuses each one *by name*, so the first thing the tool tells a new
 * task is which of its plan rows is still a form. A template that validated
 * would be a plan nobody wrote and everybody trusted.
 */
export function renderMilestoneTemplate(): string {
  return `# Milestone

## 1. Problem and Target
<What is slow, measured where, and the number this task has to move.>

## 2. Contract
- basis: <device or e2e>
- cells: <the cell ids from kernel.contract.json>
- groups: <one per cell, or default when the cell has none>

## 3. DAG and Phase Order
<Why this order. M0 first, because its gate is what unblocks the rest.>
A gate line's [VERIFY: ...] class is followed by its pointer (profile:RUN, or
cell-group:CELL/GROUP), and the pointer is resolved against profile/ and the
contract — so it has to name something that exists.

### M0 Contract
- tile: <elements per block, threads, elements per thread>
- smem: <none, or the inventory and its stages>
- warp roles: <which warps do what>
- register budget: <registers per thread, and what breaks if it moves>
- issue order: <the inner loop, in order>
- accumulator precision: <fp32, tf32, fp16, ...>

### M0 Architecture
#### D0.1 <the first decision, as a verb phrase>
- Action: <what changes>
- Purpose: <why, in terms of the limiter this kernel is bound by>
- Trigger: <the observable that says it is time, never a category>
- Cost: <effort, and what it costs in registers or smem>
- Depends on: none

### M0 Gate
- <the number that moves, and by how much> [VERIFY: ncu-direct]
- <what must stay correct> [VERIFY: correctness]
- <the mechanism that landed, which is why the number moved> [VERIFY: mechanism]

## 4. Dead Ends
- <D ids> | <reason, with the number that killed it> | <evidence pointer>

## 5. Global Gate
<Which cells and groups the gate covers, and what it does not cover.>

## 6. Rules
<What a candidate may not change in this task.>
`;
}

/** Headings present in the document, normalized for comparison. */
export function headingsIn(text: string): Set<string> {
  const found = new Set<string>();
  for (const line of text.split("\n")) {
    const match = /^#{2,3}\s+(.+?)\s*$/.exec(line);
    if (match) found.add(normalizeHeading(match[1]));
  }
  return found;
}

export interface SectionIssue {
  heading: string;
  problem: "missing" | "empty" | "placeholder";
}

/** Sections whose body is blank or still the generated `<...>` placeholder. */
export function sectionIssues(text: string, headings: readonly string[]): SectionIssue[] {
  const issues: SectionIssue[] = [];
  const present = headingsIn(text);
  for (const heading of headings) {
    if (!present.has(normalizeHeading(heading))) {
      issues.push({ heading, problem: "missing" });
      continue;
    }
    const body = sectionBody(text, heading);
    if (body.trim() === "") {
      issues.push({ heading, problem: "empty" });
    } else if (/^<.*>$/s.test(body.trim())) {
      issues.push({ heading, problem: "placeholder" });
    }
  }
  return issues;
}

function sectionBody(text: string, heading: string): string {
  const lines = text.split("\n");
  const wanted = normalizeHeading(heading);
  let collecting = false;
  const body: string[] = [];
  for (const line of lines) {
    const match = /^#{2,3}\s+(.+?)\s*$/.exec(line);
    if (match) {
      if (collecting) break;
      collecting = normalizeHeading(match[1]) === wanted;
      continue;
    }
    if (collecting) body.push(line);
  }
  return body.join("\n").trim();
}

function normalizeHeading(heading: string): string {
  return heading.trim().toLowerCase().replace(/[:\s]+$/, "");
}

export interface WorkspaceValidation {
  ok: boolean;
  draftIssues: SectionIssue[];
  planIssues: SectionIssue[];
}

export function validateWorkspace(root: string): WorkspaceValidation {
  const paths = workspacePaths(root);
  const draftText = fs.existsSync(paths.draft) ? fs.readFileSync(paths.draft, "utf8") : "";
  const planText = fs.existsSync(paths.plan) ? fs.readFileSync(paths.plan, "utf8") : "";
  const draftIssues = sectionIssues(draftText, DRAFT_HEADINGS);
  const planIssues = sectionIssues(planText, PLAN_HEADINGS);
  return { ok: draftIssues.length === 0 && planIssues.length === 0, draftIssues, planIssues };
}

export function formatWorkspaceIssues(validation: WorkspaceValidation): string {
  const lines: string[] = [];
  const describe = (label: string, issues: SectionIssue[]) => {
    for (const issue of issues) {
      const detail =
        issue.problem === "missing"
          ? "section missing"
          : issue.problem === "empty"
            ? "section is empty"
            : "section still holds the generated placeholder";
      lines.push(`- ${label} › ${issue.heading}: ${detail}`);
    }
  };
  describe("docs/draft.md", validation.draftIssues);
  describe("docs/plan.md", validation.planIssues);
  return lines.join("\n");
}
