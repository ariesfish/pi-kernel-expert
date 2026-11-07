import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { normalizeContract, writeContractFiles } from "../../extensions/pi-kernel-expert/kernel/contract.ts";
import {
  DRAFT_HEADINGS,
  PLAN_HEADINGS,
  initWorkspace,
  workspacePaths,
} from "../../extensions/pi-kernel-expert/workspace/layout.ts";

function run(script, cwd) {
  try {
    const stdout = execFileSync("bash", [script], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { code: 0, stdout, stderr: "" };
  } catch (error) {
    return { code: error.status ?? 1, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
  }
}

function fillWorkspace(root) {
  const paths = workspacePaths(root);
  fs.writeFileSync(
    paths.draft,
    ["# Plan draft", ...DRAFT_HEADINGS.flatMap((h) => [`## ${h}`, `content for ${h}`, ""])].join("\n"),
  );
  fs.writeFileSync(
    paths.plan,
    ["# Executable plan", ...PLAN_HEADINGS.flatMap((h) => [`## ${h}`, `content for ${h}`, ""])].join("\n"),
  );
}

function writeCommand(root, name, body) {
  const file = path.join(root, name);
  fs.writeFileSync(file, body);
  fs.chmodSync(file, 0o755);
  return file;
}

function setup(overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kernel-expert-scripts-"));
  initWorkspace(root);
  fillWorkspace(root);
  fs.mkdirSync(path.join(root, "speeds"));
  fs.mkdirSync(path.join(root, "checks"));

  writeCommand(root, "bench.sh", '#!/usr/bin/env bash\nset -euo pipefail\ncat "speeds/$KERNEL_CELL"\n');
  writeCommand(
    root,
    "check.sh",
    '#!/usr/bin/env bash\nset -euo pipefail\ncode=$(cat "checks/$KERNEL_CELL" 2>/dev/null || echo 0)\nexit "$code"\n',
  );

  const normalized = normalizeContract({
    objective: "cut latency",
    checkCommand: "bash check.sh",
    benchmarkCommand: "bash bench.sh",
    cells: [
      { id: "a", dtype: "bf16", vars: { M: "1024" } },
      { id: "b", dtype: "fp8", vars: { M: "4096" }, boundary: true },
    ],
    tolerance: { rtol: 1e-2, atol: 1e-3 },
    repeats: 3,
    warmup: 0,
    guardPct: 5,
    ...overrides,
  });
  assert.deepEqual(normalized.errors, []);
  const written = writeContractFiles({ root, contract: normalized.contract });
  assert.equal(written.ok, true);
  return { root, paths: workspacePaths(root) };
}

function setSpeed(root, cell, value) {
  fs.writeFileSync(path.join(root, "speeds", cell), `${value}\n`);
}

function metrics(stdout) {
  const found = {};
  for (const match of stdout.matchAll(/^METRIC\s+([\w.]+)=(\S+)$/gm)) {
    found[match[1]] = Number(match[2]);
  }
  return found;
}

test("the first run records the baseline and reports a neutral geomean", () => {
  const { root, paths } = setup();
  setSpeed(root, "a", 10);
  setSpeed(root, "b", 20);

  const result = run(paths.benchmarkScript, root);
  assert.equal(result.code, 0, result.stderr);
  const reported = metrics(result.stdout);
  assert.equal(reported.latency_us_a, 10);
  assert.equal(reported.latency_us_b, 20);
  assert.equal(reported.geomean_speedup, 1);
  assert.match(result.stdout, /baseline recorded/);

  const baseline = fs.readFileSync(paths.baseline, "utf8").trim().split("\n");
  assert.equal(baseline.length, 3, "header plus two cells");
  assert.match(baseline[1], /^a\tlatency_us\t10\tlower$/);
});

test("a candidate is compared per cell and as a geomean", () => {
  const { root, paths } = setup();
  setSpeed(root, "a", 10);
  setSpeed(root, "b", 20);
  assert.equal(run(paths.benchmarkScript, root).code, 0);

  setSpeed(root, "a", 5);
  setSpeed(root, "b", 10);
  const result = run(paths.benchmarkScript, root);
  assert.equal(result.code, 0, result.stderr);
  const reported = metrics(result.stdout);
  assert.ok(Math.abs(reported.geomean_speedup - 2) < 1e-9, `geomean ${reported.geomean_speedup}`);
  assert.equal(reported.latency_us_a, 5);
});

test("a per-cell regression beyond the guard fails the benchmark and names the cell", () => {
  const { root, paths } = setup();
  setSpeed(root, "a", 10);
  setSpeed(root, "b", 20);
  assert.equal(run(paths.benchmarkScript, root).code, 0);

  setSpeed(root, "a", 10);
  setSpeed(root, "b", 40);
  const result = run(paths.benchmarkScript, root);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /guard: cell b regressed/);
  assert.match(result.stderr, /guard failed: 1 cell/);
});

test("a changed contract refuses to run the benchmark", () => {
  const { root, paths } = setup();
  setSpeed(root, "a", 10);
  setSpeed(root, "b", 20);
  fs.appendFileSync(paths.contract, "\n");
  const result = run(paths.benchmarkScript, root);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /kernel\.contract\.json changed/);
});

test("cell variables are exported to the benchmark command", () => {
  const { root, paths } = setup({
    benchmarkCommand: "bash vars.sh",
    cells: [
      { id: "v", dtype: "bf16", vars: { M: "7", N: "6" } },
    ],
  });
  writeCommand(root, "vars.sh", '#!/usr/bin/env bash\nprintf "%s\\n" "$((KERNEL_M * KERNEL_N))"\n');
  const result = run(paths.benchmarkScript, root);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(metrics(result.stdout).latency_us_v, 42);
});

test("checks run two passes per cell and report a failure with the boundary note", () => {
  const { root, paths } = setup();
  fs.writeFileSync(path.join(root, "checks", "a"), "0\n");
  fs.writeFileSync(path.join(root, "checks", "b"), "1\n");

  const failing = run(paths.checksScript, root);
  assert.equal(failing.code, 1);
  assert.match(failing.stderr, /FAIL cell b \(boundary cell\) pass 1/);
  assert.match(failing.stderr, /checks failed: 1 cell/);

  fs.writeFileSync(path.join(root, "checks", "b"), "0\n");
  const passing = run(paths.checksScript, root);
  assert.equal(passing.code, 0, passing.stderr);
  assert.match(passing.stdout, /checks ok: 2 cell\(s\), 2 passes each/);
});

test("a check that fails only on the second pass is reported as pass 2", () => {
  const { root, paths } = setup({
    checkCommand: "bash flaky.sh",
    cells: [{ id: "a", dtype: "bf16" }],
  });
  writeCommand(
    root,
    "flaky.sh",
    '#!/usr/bin/env bash\nn=$(cat calls 2>/dev/null || echo 0)\nn=$((n+1))\necho "$n" > calls\n[[ "$n" -lt 2 ]]\n',
  );
  const result = run(paths.checksScript, root);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /FAIL cell a pass 2/);
  assert.match(result.stderr, /order-dependent|checks failed/);
});

test("a changed contract refuses to run the checks", () => {
  const { root, paths } = setup();
  fs.appendFileSync(paths.contract, " ");
  const result = run(paths.checksScript, root);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /kernel\.contract\.json changed/);
});
