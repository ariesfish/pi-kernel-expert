import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { findSkillConflict, skillRoots } from "../../extensions/pi-kernel-expert/knowledge/conflicts.ts";
import { planKernelWikiRegistration } from "../../extensions/pi-kernel-expert/knowledge/registration.ts";
import { agentLayout, KERNEL_WIKI_PIN } from "../../extensions/pi-kernel-expert/support/paths.ts";

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeSkill(dir, name) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: test\n---\n\n# Skill\n`);
}

test("finds a conflicting skill declared by frontmatter", () => {
  const root = tempDir("pi-kernel-expert-skills-");
  writeSkill(path.join(root, "some-dir"), "kernel-wiki");
  const conflict = findSkillConflict([{ path: root, label: "test root" }], "kernel-wiki");
  assert.ok(conflict);
  assert.equal(conflict.path, path.join(root, "some-dir"));
  assert.equal(conflict.label, "test root");
});

test("falls back to the directory name when frontmatter has no name", () => {
  const root = tempDir("pi-kernel-expert-skills-");
  fs.mkdirSync(path.join(root, "kernel-wiki"), { recursive: true });
  fs.writeFileSync(path.join(root, "kernel-wiki", "SKILL.md"), "---\ndescription: no name\n---\n");
  assert.ok(findSkillConflict([{ path: root, label: "root" }], "kernel-wiki"));
});

test("no conflict for a differently named skill or a missing root", () => {
  const root = tempDir("pi-kernel-expert-skills-");
  writeSkill(path.join(root, "other"), "other-skill");
  assert.equal(findSkillConflict([{ path: root, label: "root" }], "kernel-wiki"), null);
  assert.equal(findSkillConflict([{ path: path.join(root, "absent"), label: "root" }], "kernel-wiki"), null);
});

test("skill roots cover user, project, and agents locations", () => {
  const cwd = tempDir("pi-kernel-expert-cwd-");
  fs.mkdirSync(path.join(cwd, ".git"));
  const roots = skillRoots({ cwd, agentDir: "/agent", home: "/home/tester" });
  const paths = roots.map((root) => root.path);
  assert.ok(paths.includes(path.join("/agent", "skills")));
  assert.ok(paths.includes(path.join(cwd, ".pi", "skills")));
  assert.ok(paths.includes(path.join("/home/tester", ".agents", "skills")));
  assert.ok(paths.includes(path.join(cwd, ".agents", "skills")));
});

test("registration registers the cache when nothing conflicts", () => {
  const agentDir = tempDir("pi-kernel-expert-agent-");
  const cwd = tempDir("pi-kernel-expert-cwd-");
  fs.mkdirSync(path.join(cwd, ".git"));
  const layout = agentLayout({ PI_CODING_AGENT_DIR: agentDir }, "/home/tester");
  writeSkill(layout.kernelWikiDir, "kernel-wiki");

  const plan = planKernelWikiRegistration({ cwd, layout, home: "/home/tester" });
  assert.equal(plan.present, true);
  assert.equal(plan.conflict, null);
  assert.deepEqual(plan.skillPaths, [layout.kernelWikiDir]);
  assert.match(layout.kernelWikiDir, new RegExp(KERNEL_WIKI_PIN));
});

test("registration yields to an existing installation and names it", () => {
  const agentDir = tempDir("pi-kernel-expert-agent-");
  const cwd = tempDir("pi-kernel-expert-cwd-");
  fs.mkdirSync(path.join(cwd, ".git"));
  const layout = agentLayout({ PI_CODING_AGENT_DIR: agentDir }, "/home/tester");
  writeSkill(layout.kernelWikiDir, "kernel-wiki");
  const existing = path.join(cwd, ".pi", "skills", "kernel-wiki");
  writeSkill(existing, "kernel-wiki");

  const plan = planKernelWikiRegistration({ cwd, layout, home: "/home/tester" });
  assert.equal(plan.present, true);
  assert.equal(plan.conflict?.path, existing);
  assert.deepEqual(plan.skillPaths, []);
});

test("registration registers nothing when the corpus is absent", () => {
  const agentDir = tempDir("pi-kernel-expert-agent-");
  const cwd = tempDir("pi-kernel-expert-cwd-");
  const layout = agentLayout({ PI_CODING_AGENT_DIR: agentDir }, "/home/tester");
  const plan = planKernelWikiRegistration({ cwd, layout, home: "/home/tester" });
  assert.equal(plan.present, false);
  assert.deepEqual(plan.skillPaths, []);
});
