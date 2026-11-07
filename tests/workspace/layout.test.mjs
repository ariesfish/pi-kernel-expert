import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import {
  DRAFT_HEADINGS,
  PLAN_HEADINGS,
  formatWorkspaceIssues,
  initWorkspace,
  sectionIssues,
  validateWorkspace,
  workspacePaths,
} from "../../extensions/pi-kernel-expert/workspace/layout.ts";

function tempWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pi-kernel-expert-ws-"));
}

function fillDraft(root) {
  const paths = workspacePaths(root);
  fs.writeFileSync(
    paths.draft,
    [
      "# Plan draft",
      ...DRAFT_HEADINGS.flatMap((heading) => [`## ${heading}`, `real content for ${heading}`, ""]),
    ].join("\n"),
  );
  fs.writeFileSync(
    paths.plan,
    ["# Executable plan", ...PLAN_HEADINGS.flatMap((heading) => [`## ${heading}`, `real content for ${heading}`, ""])].join("\n"),
  );
}

test("init creates the workspace files and leaves an existing file alone", () => {
  const root = tempWorkspace();
  const first = initWorkspace(root);
  assert.deepEqual(first.created.sort(), ["candidates.jsonl", "docs/draft.md", "docs/plan.md"]);
  assert.ok(fs.existsSync(workspacePaths(root).profile));
  assert.ok(fs.existsSync(workspacePaths(root).kernelDir));

  fs.writeFileSync(workspacePaths(root).draft, "mine\n");
  const second = initWorkspace(root);
  assert.deepEqual(second.created, []);
  assert.deepEqual(second.existing.sort(), ["candidates.jsonl", "docs/draft.md", "docs/plan.md"]);
  assert.equal(fs.readFileSync(workspacePaths(root).draft, "utf8"), "mine\n");
});

test("the generated templates are placeholders, not a frozen plan", () => {
  const root = tempWorkspace();
  initWorkspace(root);
  const validation = validateWorkspace(root);
  assert.equal(validation.ok, false);
  assert.equal(validation.draftIssues.length, DRAFT_HEADINGS.length);
  assert.equal(validation.planIssues.length, PLAN_HEADINGS.length);
  assert.ok(validation.draftIssues.every((issue) => issue.problem === "placeholder"));
  assert.match(formatWorkspaceIssues(validation), /docs\/draft\.md › Baseline and validation/);
});

test("filled sections pass; a missing or empty section is named", () => {
  const root = tempWorkspace();
  initWorkspace(root);
  fillDraft(root);
  assert.equal(validateWorkspace(root).ok, true);

  const draft = fs.readFileSync(workspacePaths(root).draft, "utf8");
  fs.writeFileSync(workspacePaths(root).draft, draft.replace("## Risks and unknowns", "## Removed heading"));
  const missing = validateWorkspace(root);
  assert.equal(missing.ok, false);
  assert.deepEqual(missing.draftIssues, [{ heading: "Risks and unknowns", problem: "missing" }]);

  fs.writeFileSync(
    workspacePaths(root).draft,
    draft.replace(/## Risks and unknowns\nreal content for Risks and unknowns/, "## Risks and unknowns\n"),
  );
  const empty = validateWorkspace(root);
  assert.deepEqual(empty.draftIssues, [{ heading: "Risks and unknowns", problem: "empty" }]);
});

test("heading matching tolerates case and trailing punctuation", () => {
  const issues = sectionIssues("## baseline and validation:\nreal\n## risks and unknowns\nreal\n", [
    "Baseline and validation",
    "Risks and unknowns",
    "Candidate directions",
  ]);
  assert.deepEqual(issues, [{ heading: "Candidate directions", problem: "missing" }]);
});

test("a missing workspace reports every section as missing", () => {
  const validation = validateWorkspace(tempWorkspace());
  assert.equal(validation.ok, false);
  assert.ok(validation.draftIssues.every((issue) => issue.problem === "missing"));
});
