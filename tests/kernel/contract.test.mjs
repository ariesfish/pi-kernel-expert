import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import {
  cellMetricName,
  contractJson,
  contractSha,
  freezePayload,
  normalizeContract,
  renderBenchmarkScript,
  renderChecksScript,
  writeContractFiles,
} from "../../extensions/pi-kernel-expert/kernel/contract.ts";
import { initWorkspace, workspacePaths } from "../../extensions/pi-kernel-expert/workspace/layout.ts";

const BASE = {
  objective: "cut attention latency",
  checkCommand: "bash check.sh",
  benchmarkCommand: "bash bench.sh",
  cells: [
    { id: "m1024", dtype: "bf16", vars: { M: "1024" } },
    { id: "m4096", dtype: "fp8_e4m3", vars: { M: "4096" }, boundary: true },
  ],
  tolerance: { rtol: 1e-2, atol: 1e-3 },
  repeats: 3,
  warmup: 1,
};

function built(overrides = {}) {
  const result = normalizeContract({ ...BASE, ...overrides });
  assert.deepEqual(result.errors, []);
  assert.ok(result.contract);
  return result.contract;
}

test("a minimal contract normalizes with defaults", () => {
  const contract = built();
  assert.equal(contract.metricName, "latency_us");
  assert.equal(contract.direction, "lower");
  assert.equal(contract.guardPct, 5);
  assert.equal(contract.checksTimeoutSeconds, 900);
  assert.equal(contract.noiseFloorPct, 2);
  assert.deepEqual(contract.tolerance, { rtol: 1e-2, atol: 1e-3 });
  assert.equal(contract.cells[0].vars.M, "1024");
  assert.equal(contract.cells[1].boundary, true);
});

test("validation names every bad field", () => {
  const result = normalizeContract({
    ...BASE,
    objective: "  ",
    checkCommand: "",
    benchmarkCommand: "",
    metricName: "bad-name",
    repeats: 0,
    warmup: 99,
    guardPct: 200,
    tolerance: { rtol: -1, atol: 0 },
    cells: [
      { id: "bad id", dtype: "" },
      { id: "dup", dtype: "bf16", vars: { "bad-key": "1" } },
      { id: "DUP", dtype: "bf16" },
      { id: "ok", dtype: "bf16", vars: { M: "1,2" } },
    ],
  });
  const text = result.errors.join("\n");
  assert.match(text, /objective is required/);
  assert.match(text, /checkCommand is required/);
  assert.match(text, /benchmarkCommand is required/);
  assert.match(text, /metricName "bad-name"/);
  assert.match(text, /repeats must be/);
  assert.match(text, /warmup must be/);
  assert.match(text, /guardPct must be/);
  assert.match(text, /tolerance.rtol must be >= 0/);
  assert.match(text, /cells\[0\]\.id/);
  assert.match(text, /cells\[0\]\.dtype is required/);
  assert.match(text, /cells\[1\]\.vars\.bad-key/);
  assert.match(text, /is duplicated/);
  assert.match(text, /must not contain/);
});

test("cell metric names are shell- and METRIC-safe", () => {
  const contract = built({ cells: [{ id: "m1024.attn", dtype: "bf16" }] });
  assert.equal(cellMetricName(contract, contract.cells[0]), "latency_us_m1024_attn");
});

test("freeze payload has one blocking metric and one command criterion", () => {
  const contract = built({ testGlobs: ["tests/**/*.py"], scopeGlobs: ["kernel/**"] });
  const payload = freezePayload(contract);
  assert.deepEqual(payload.test_globs, ["tests/**/*.py"]);
  assert.deepEqual(payload.scope_globs, ["kernel/**"]);
  const blockingMetrics = payload.criteria.filter((c) => c.blocking && c.kind === "metric");
  assert.equal(blockingMetrics.length, 1);
  assert.deepEqual(blockingMetrics[0].metric, { name: "geomean_speedup", direction: "higher", unit: "x" });
  const command = payload.criteria.find((c) => c.kind === "command");
  assert.equal(command.blocking, true);
  assert.equal(command.check.command, "bash goal.checks.sh");
  assert.equal(command.check.expect, "exit0");
  assert.equal(command.check.timeoutSeconds, 900);
});

test("rendered scripts embed the cells, the hash, and the guard", () => {
  const contract = built();
  const json = contractJson(contract);
  const sha = contractSha(json);
  assert.equal(sha.length, 64);

  const bench = renderBenchmarkScript(contract, sha);
  assert.match(bench, new RegExp(`sha256 ${sha}`));
  assert.match(bench, /'m1024\|bf16\|0\.01\|0\.001\|0\|M=1024'/);
  assert.match(bench, /'m4096\|fp8_e4m3\|0\.01\|0\.001\|1\|M=4096'/);
  assert.match(bench, /REPEATS=3/);
  assert.match(bench, /WARMUP=1/);
  assert.match(bench, /GUARD_PCT='5'/);
  assert.match(bench, /METRIC geomean_speedup/);
  assert.match(bench, /--reset-baseline/);

  const checks = renderChecksScript(contract, sha);
  assert.match(checks, /for pass in 1 2/);
  assert.match(checks, /CHECK_CMD='bash check\.sh'/);
  assert.match(checks, /boundary cell/);
});

test("writeContractFiles refuses to clobber and writes executable scripts on force", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kernel-expert-contract-"));
  initWorkspace(root);
  const contract = built();

  const first = writeContractFiles({ root, contract });
  assert.equal(first.ok, true);
  const paths = workspacePaths(root);
  for (const file of [paths.contract, paths.benchmarkScript, paths.checksScript, paths.freezePayload]) {
    assert.ok(fs.existsSync(file), `${file} missing`);
  }
  assert.ok(fs.statSync(paths.benchmarkScript).mode & 0o100, "goal.sh should be executable");

  const second = writeContractFiles({ root, contract });
  assert.equal(second.ok, false);
  assert.equal(second.errors.length, 4);
  assert.match(second.errors[0], /already exists/);

  const forced = writeContractFiles({ root, contract, force: true });
  assert.equal(forced.ok, true);
});

test("the freeze payload file matches the returned payload", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kernel-expert-contract-"));
  initWorkspace(root);
  const outcome = writeContractFiles({ root, contract: built() });
  assert.equal(outcome.ok, true);
  const onDisk = JSON.parse(fs.readFileSync(workspacePaths(root).freezePayload, "utf8"));
  assert.deepEqual(onDisk, outcome.result.freeze);
});
