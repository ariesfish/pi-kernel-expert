import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { diffFingerprint } from "../../extensions/pi-kernel-expert/kernel/diff.ts";
import { processExec } from "../helpers/process-exec.mjs";

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function repo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kernel-expert-diff-"));
  git(["init", "-q"], root);
  git(["config", "user.email", "test@example.com"], root);
  git(["config", "user.name", "Test"], root);
  fs.mkdirSync(path.join(root, "kernel"));
  fs.writeFileSync(path.join(root, "kernel", "attn.cu"), "v1\n");
  fs.writeFileSync(path.join(root, "README.md"), "readme\n");
  git(["add", "-A"], root);
  git(["commit", "-q", "-m", "base"], root);
  return root;
}

async function fingerprint(root, scopeGlobs) {
  const result = await diffFingerprint({ exec: processExec(), root, scopeGlobs });
  assert.equal(result.ok, true, result.ok ? "" : result.reason);
  return result.value;
}

test("the fingerprint is stable for the same tree and changes with a tracked edit", async () => {
  const root = repo();
  const one = await fingerprint(root);
  const two = await fingerprint(root);
  assert.equal(one.hash, two.hash);

  fs.writeFileSync(path.join(root, "kernel", "attn.cu"), "v2\n");
  const edited = await fingerprint(root);
  assert.notEqual(edited.hash, one.hash);
  assert.deepEqual(edited.changedFiles, ["kernel/attn.cu"]);

  fs.writeFileSync(path.join(root, "kernel", "attn.cu"), "v1\n");
  assert.equal((await fingerprint(root)).hash, one.hash);
});

test("untracked file content counts, and a size-only change still counts", async () => {
  const root = repo();
  const base = await fingerprint(root);
  const newFile = path.join(root, "kernel", "new.cu");
  fs.writeFileSync(newFile, "a\n");
  const added = await fingerprint(root);
  assert.notEqual(added.hash, base.hash);
  assert.deepEqual(added.changedFiles, ["kernel/new.cu"]);

  fs.writeFileSync(newFile, "b\n");
  const edited = await fingerprint(root);
  assert.notEqual(edited.hash, added.hash);
});

test("evidence directories never count as the candidate change", async () => {
  const root = repo();
  const base = await fingerprint(root);
  fs.mkdirSync(path.join(root, "profile", "run1"), { recursive: true });
  fs.writeFileSync(path.join(root, "profile", "run1", "summary.json"), "{}\n");
  fs.mkdirSync(path.join(root, ".kernel"), { recursive: true });
  fs.writeFileSync(path.join(root, ".kernel", "baseline.tsv"), "x\n");
  fs.writeFileSync(path.join(root, "candidates.jsonl"), "{}\n");
  fs.writeFileSync(path.join(root, "benchmark.csv"), "a,b\n");
  assert.equal((await fingerprint(root)).hash, base.hash);
});

test("scope globs narrow the fingerprint to the code under change", async () => {
  const root = repo();
  const base = await fingerprint(root, ["kernel/**"]);
  fs.writeFileSync(path.join(root, "README.md"), "readme v2\n");
  const docsOnly = await fingerprint(root, ["kernel/**"]);
  assert.equal(docsOnly.hash, base.hash, "a README edit is out of scope");

  fs.writeFileSync(path.join(root, "kernel", "attn.cu"), "v3\n");
  assert.notEqual((await fingerprint(root, ["kernel/**"])).hash, base.hash);
});

test("a non-repository is refused with a reason", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kernel-expert-diff-"));
  const result = await diffFingerprint({ exec: processExec(), root });
  assert.equal(result.ok, false);
  assert.match(result.reason, /not a git repository/);
});
