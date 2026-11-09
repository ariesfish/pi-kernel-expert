import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { fetchPinnedCorpus, formatFetchResult } from "../../extensions/pi-kernel-expert/knowledge/fetch.ts";

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function makeSourceRepo() {
  const dir = tempDir("pi-kernel-expert-src-");
  git(["init", "-q"], dir);
  git(["config", "user.email", "test@example.com"], dir);
  git(["config", "user.name", "Test"], dir);
  fs.writeFileSync(
    path.join(dir, "SKILL.md"),
    "---\nname: KernelWiki\ndescription: test corpus\n---\n\n# Corpus\n",
  );
  fs.mkdirSync(path.join(dir, "kernels"));
  fs.writeFileSync(path.join(dir, "kernels", "a.md"), "a\n");
  git(["add", "-A"], dir);
  git(["commit", "-q", "-m", "c1"], dir);
  const first = git(["rev-parse", "HEAD"], dir);
  fs.writeFileSync(path.join(dir, "kernels", "b.md"), "b\n");
  git(["add", "-A"], dir);
  git(["commit", "-q", "-m", "c2"], dir);
  const second = git(["rev-parse", "HEAD"], dir);
  return { dir, first, second };
}

function hostExec() {
  return {
    async exec(command, args, options = {}) {
      return new Promise((resolve) => {
        execFile(command, args, { cwd: options.cwd, timeout: options.timeout ?? 30_000 }, (error, stdout, stderr) => {
          resolve({
            stdout: stdout ?? "",
            stderr: stderr ?? "",
            code: error ? (typeof error.code === "number" ? error.code : 1) : 0,
            killed: Boolean(error?.killed),
            truncated: false,
          });
        });
      });
    },
  };
}

test("installs the pinned revision, not the branch tip", async () => {
  const source = makeSourceRepo();
  const target = path.join(tempDir("pi-kernel-expert-cache-"), "kernel-wiki@pin");

  const result = await fetchPinnedCorpus({
    remote: source.dir,
    pin: source.first,
    targetDir: target,
    exec: hostExec(),
  });

  assert.equal(result.state, "installed");
  assert.equal(result.revision, source.first);
  assert.ok(fs.existsSync(path.join(target, "kernels", "a.md")));
  assert.equal(fs.existsSync(path.join(target, "kernels", "b.md")), false, "checked out the tip instead of the pin");
  assert.match(result.warnings.join("\n"), /not Agent Skills compliant/);
});

test("a second fetch reports already and does not re-clone", async () => {
  const source = makeSourceRepo();
  const target = path.join(tempDir("pi-kernel-expert-cache-"), "kernel-wiki@pin");
  const exec = hostExec();

  const first = await fetchPinnedCorpus({ remote: source.dir, pin: source.first, targetDir: target, exec });
  assert.equal(first.state, "installed");

  let calls = 0;
  const counted = {
    async exec(...args) {
      calls += 1;
      return exec.exec(...args);
    },
  };
  const second = await fetchPinnedCorpus({ remote: source.dir, pin: source.first, targetDir: target, exec: counted });
  assert.equal(second.state, "already");
  assert.equal(calls, 1, "already-cached path should only run rev-parse");
});

test("a wrong pin is refused and leaves no target or temp directory", async () => {
  const source = makeSourceRepo();
  const parent = tempDir("pi-kernel-expert-cache-");
  const target = path.join(parent, "kernel-wiki@pin");

  const result = await fetchPinnedCorpus({
    remote: source.dir,
    pin: "0".repeat(40),
    targetDir: target,
    exec: hostExec(),
  });

  assert.equal(result.state, "refused");
  assert.match(result.reason ?? "", /not in/);
  assert.equal(fs.existsSync(target), false);
  assert.deepEqual(fs.readdirSync(parent), []);
});

test("an existing tree at another revision is refused, not overwritten", async () => {
  const source = makeSourceRepo();
  const target = path.join(tempDir("pi-kernel-expert-cache-"), "kernel-wiki@pin");
  await fetchPinnedCorpus({ remote: source.dir, pin: source.first, targetDir: target, exec: hostExec() });

  const result = await fetchPinnedCorpus({
    remote: source.dir,
    pin: source.second,
    targetDir: target,
    exec: hostExec(),
  });

  assert.equal(result.state, "refused");
  assert.match(result.reason ?? "", /refusing to overwrite/);
  assert.equal(git(["rev-parse", "HEAD"], target), source.first);
});

test("a directory without SKILL.md is refused untouched", async () => {
  const parent = tempDir("pi-kernel-expert-cache-");
  const target = path.join(parent, "kernel-wiki@pin");
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, "notes.txt"), "mine\n");

  const result = await fetchPinnedCorpus({
    remote: "/nonexistent",
    pin: "1".repeat(40),
    targetDir: target,
    exec: hostExec(),
  });

  assert.equal(result.state, "refused");
  assert.match(result.reason ?? "", /no SKILL.md/);
  assert.equal(fs.readFileSync(path.join(target, "notes.txt"), "utf8"), "mine\n");
});

test("a malformed pin is refused before any process runs", async () => {
  let calls = 0;
  const exec = { async exec() { calls += 1; throw new Error("must not run"); } };
  const result = await fetchPinnedCorpus({
    remote: "/nonexistent",
    pin: "76d27b5",
    targetDir: path.join(tempDir("pi-kernel-expert-cache-"), "x"),
    exec,
  });
  assert.equal(result.state, "refused");
  assert.match(result.reason ?? "", /40-character/);
  assert.equal(calls, 0);
});

test("formatFetchResult names the reload step after an install", async () => {
  const source = makeSourceRepo();
  const target = path.join(tempDir("pi-kernel-expert-cache-"), "kernel-wiki@pin");
  const result = await fetchPinnedCorpus({ remote: source.dir, pin: source.first, targetDir: target, exec: hostExec() });
  const text = formatFetchResult(result);
  assert.match(text, /kernel-wiki fetched to/);
  assert.match(text, /Run \/reload/);
  assert.match(text, new RegExp(source.first));
});

test("restricted artifact headers are pruned and recorded", async () => {
  const source = makeSourceRepo();
  fs.mkdirSync(path.join(source.dir, "artifacts", "prs", "cutlass", "PR-0001", "key-files"), { recursive: true });
  fs.writeFileSync(
    path.join(source.dir, "artifacts", "prs", "cutlass", "PR-0001", "key-files", "kernel.py"),
    "# SPDX-FileCopyrightText: Copyright (c) 2024 NVIDIA CORPORATION & AFFILIATES. All rights reserved.\n# SPDX-License-Identifier: LicenseRef-NvidiaProprietary\n\nprint('restricted')\n",
  );
  // A diff carries the marker hundreds of lines in; the scan must not stop at the header.
  const padding = Array.from({ length: 400 }, (_, i) => ` context line ${i}`).join("\n");
  fs.writeFileSync(
    path.join(source.dir, "artifacts", "prs", "cutlass", "PR-0001", "diff.patch"),
    `${padding}\n+# SPDX-License-Identifier: LicenseRef-NvidiaProprietary\n`,
  );
  fs.writeFileSync(path.join(source.dir, "artifacts", "prs", "cutlass", "PR-0001", "PROVENANCE.yaml"), "source: cutlass\n");
  git(["add", "-A"], source.dir);
  git(["commit", "-q", "-m", "restricted"], source.dir);
  const pin = git(["rev-parse", "HEAD"], source.dir);

  const target = path.join(tempDir("pi-kernel-expert-cache-"), "kernel-wiki@pin");
  const result = await fetchPinnedCorpus({ remote: source.dir, pin, targetDir: target, exec: hostExec() });

  assert.equal(result.state, "installed");
  assert.match(result.warnings.join("\n"), /removed 2 file\(s\) marked LicenseRef-NvidiaProprietary/);
  assert.equal(
    fs.existsSync(path.join(target, "artifacts", "prs", "cutlass", "PR-0001", "key-files", "kernel.py")),
    false,
    "restricted file survived the prune",
  );
  assert.ok(fs.existsSync(path.join(target, "artifacts", "prs", "cutlass", "PR-0001", "PROVENANCE.yaml")));
  assert.equal(fs.existsSync(path.join(target, "artifacts", "prs", "cutlass", "PR-0001", "diff.patch")), false);
  const record = fs.readFileSync(path.join(target, "SANITIZED.yaml"), "utf8");
  assert.match(record, /removed: 2/);
  assert.match(record, /PR-0001\/key-files\/kernel\.py/);
  assert.match(record, /PR-0001\/diff\.patch/);
  assert.match(record, new RegExp(pin));

  const repaired = await fetchPinnedCorpus({ remote: source.dir, pin, targetDir: target, exec: hostExec() });
  assert.equal(repaired.state, "already");
  assert.equal(repaired.warnings.some((w) => /restricted/.test(w)), false, "an already-clean cache should not re-warn");
});

test("an already-cached tree is repaired when a restricted file reappears", async () => {
  const source = makeSourceRepo();
  fs.mkdirSync(path.join(source.dir, "artifacts", "x"), { recursive: true });
  fs.writeFileSync(path.join(source.dir, "artifacts", "x", "a.py"), "safe\n");
  git(["add", "-A"], source.dir);
  git(["commit", "-q", "-m", "artifacts"], source.dir);
  const pin = git(["rev-parse", "HEAD"], source.dir);

  const target = path.join(tempDir("pi-kernel-expert-cache-"), "kernel-wiki@pin");
  await fetchPinnedCorpus({ remote: source.dir, pin, targetDir: target, exec: hostExec() });

  const reintroduced = path.join(target, "artifacts", "x", "b.py");
  fs.writeFileSync(reintroduced, "# SPDX-License-Identifier: LicenseRef-NvidiaProprietary\n");

  const repaired = await fetchPinnedCorpus({ remote: source.dir, pin, targetDir: target, exec: hostExec() });
  assert.equal(repaired.state, "already");
  assert.match(repaired.warnings.join("\n"), /removed 1 restricted file/);
  assert.equal(fs.existsSync(reintroduced), false);
  const record = fs.readFileSync(path.join(target, "SANITIZED.yaml"), "utf8");
  assert.match(record, /removed: 1/);
});

test("repairs keep the earlier removals in the record", async () => {
  const source = makeSourceRepo();
  fs.mkdirSync(path.join(source.dir, "artifacts", "x"), { recursive: true });
  fs.writeFileSync(path.join(source.dir, "artifacts", "x", "a.py"), "LicenseRef-NvidiaProprietary\n");
  fs.writeFileSync(path.join(source.dir, "artifacts", "x", "b.py"), "safe\n");
  git(["add", "-A"], source.dir);
  git(["commit", "-q", "-m", "artifacts"], source.dir);
  const pin = git(["rev-parse", "HEAD"], source.dir);

  const target = path.join(tempDir("pi-kernel-expert-cache-"), "kernel-wiki@pin");
  const first = await fetchPinnedCorpus({ remote: source.dir, pin, targetDir: target, exec: hostExec() });
  assert.match(first.warnings.join("\n"), /removed 1 file/);

  fs.writeFileSync(path.join(target, "artifacts", "x", "c.py"), "LicenseRef-NvidiaProprietary\n");
  const repaired = await fetchPinnedCorpus({ remote: source.dir, pin, targetDir: target, exec: hostExec() });
  assert.equal(repaired.state, "already");

  const record = fs.readFileSync(path.join(target, "SANITIZED.yaml"), "utf8");
  assert.match(record, /removed: 2/);
  assert.match(record, /artifacts\/x\/a\.py/);
  assert.match(record, /artifacts\/x\/c\.py/);
});
