import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";

const ROOT = path.resolve(new URL("../..", import.meta.url).pathname);
const SKILLS = path.join(ROOT, "skills");

function skillDirs() {
  return fs
    .readdirSync(SKILLS, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

function frontmatter(file) {
  const text = fs.readFileSync(file, "utf8");
  assert.ok(text.startsWith("---\n"), `${file} must start with frontmatter`);
  const end = text.indexOf("\n---", 4);
  assert.ok(end > 0, `${file} must close its frontmatter`);
  const raw = text.slice(4, end);
  const fields = {};
  for (const line of raw.split("\n")) {
    const match = /^([a-z-]+):\s*(.*)$/.exec(line);
    if (match) fields[match[1]] = match[2];
  }
  return fields;
}

test("every skill directory has a valid SKILL.md", () => {
  const dirs = skillDirs();
  assert.ok(dirs.length > 0, "expected at least one skill");
  const names = new Set();
  for (const dir of dirs) {
    const file = path.join(SKILLS, dir, "SKILL.md");
    assert.ok(fs.existsSync(file), `${dir} has no SKILL.md`);
    const fields = frontmatter(file);
    assert.match(fields.name ?? "", /^[a-z0-9]+(-[a-z0-9]+)*$/, `${dir}: invalid name`);
    assert.ok((fields.description ?? "").length > 0, `${dir}: missing description`);
    assert.ok((fields.description ?? "").length <= 1024, `${dir}: description over 1024 chars`);
    assert.equal(names.has(fields.name), false, `duplicate skill name ${fields.name}`);
    names.add(fields.name);
  }
});

test("vendored ncu skill carries provenance and its license", () => {
  const dir = path.join(SKILLS, "ncu-report-skill");
  const vendored = fs.readFileSync(path.join(dir, "VENDORED.yaml"), "utf8");
  const revision = /^revision:\s*([0-9a-f]{40})$/m.exec(vendored)?.[1];
  assert.ok(revision, "VENDORED.yaml must carry a full commit SHA");
  assert.match(vendored, /^source:\s*https:\/\/github\.com\/mit-han-lab\/ncu-report-skill\.git$/m);
  assert.ok(fs.existsSync(path.join(dir, "LICENSE")), "vendored tree must keep its LICENSE");
});

test("the vendored tree has the upstream reference set", () => {
  const dir = path.join(SKILLS, "ncu-report-skill");
  for (const name of [
    "helpers/ncu_utils.py",
    "helpers/analyze_reports.py",
    "helpers/extract_stall_hotspots.py",
    "helpers/plot_timeline.py",
    "helpers/harness_template.cu",
    "reference/06-diagnosis-playbook.md",
    "blackwell-cuda-programming.md",
  ]) {
    assert.ok(fs.existsSync(path.join(dir, name)), `vendored tree is missing ${name}`);
  }
});
