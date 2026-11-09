import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { normalizeContract, writeContractFiles } from "../../extensions/pi-kernel-expert/kernel/contract.ts";
import {
  HOST_BOUND_RATIO,
  READING_END_MARKER,
  READING_SCHEMA_VERSION,
  READING_START_MARKER,
  parseReadingBlock,
  verdictForRatio,
} from "../../extensions/pi-kernel-expert/kernel/reading.ts";
import { initWorkspace, workspacePaths } from "../../extensions/pi-kernel-expert/workspace/layout.ts";

/** A complete record, as the generator would write it after a real run. */
function reading(overrides = {}) {
  return {
    schemaVersion: READING_SCHEMA_VERSION,
    contractSha: "b".repeat(64),
    basis: "device",
    basisSource: "task-reported",
    gpu: {
      available: true,
      name: "NVIDIA H200",
      index: 0,
      visible: "0",
      start: { clocksSmMhz: 1980, clocksMemMhz: 1593, utilPct: 0, foreignProcessMiB: 0 },
      end: { clocksSmMhz: 1980, clocksMemMhz: 1593, utilPct: 41, foreignProcessMiB: 0 },
    },
    cells: [
      { id: "m1024", metric: "latency_us_m1024", median: 12.5, samples: 5, spreadPct: 1.2 },
      { id: "m4096", metric: "latency_us_m4096", median: 44.25, samples: 5, spreadPct: 0.8 },
    ],
    shellMs: 4210,
    hostEnqueueMs: 0.4,
    deviceMs: 12.5,
    hostBoundRatio: 0.032,
    hostBoundVerdict: "ok",
    startedAt: "2026-11-10T08:00:00Z",
    finishedAt: "2026-11-10T08:00:05Z",
    nvidiaSmi: "NVIDIA-SMI version    : 550.54.15",
    warnings: [],
    ...overrides,
  };
}

function block(record) {
  return `${READING_START_MARKER}\n${JSON.stringify(record)}\n${READING_END_MARKER}\n`;
}

function parseOk(text) {
  const result = parseReadingBlock(text);
  assert.equal(result.ok, true, result.ok ? "" : result.reason);
  return result.reading;
}

function parseRefused(text) {
  const result = parseReadingBlock(text);
  assert.equal(result.ok, false, "expected the parser to refuse this text");
  return result.reason;
}

test("a full reading block round-trips", () => {
  const record = reading();
  const text = ["METRIC latency_us_m1024=12.5", "METRIC geomean_speedup=1.02", block(record)].join("\n");
  assert.deepEqual(parseOk(text), record);
});

test("a log without a block is refused as 'no reading block'", () => {
  assert.equal(parseRefused("METRIC geomean_speedup=1\nbaseline recorded\n"), "no reading block");
  assert.equal(parseReadingBlock("").ok, false);
  assert.equal(parseReadingBlock("").reason, "no reading block");
});

test("a block with no hostEnqueueMs parses as unmeasured, never as a ratio", () => {
  const record = reading({
    hostEnqueueMs: undefined,
    hostBoundRatio: null,
    hostBoundVerdict: "unmeasured",
    hostBoundReason: "the task reported device_ms but no host_enqueue_ms; the host share is unmeasured",
  });
  const parsed = parseOk(block(record));
  assert.equal(parsed.hostBoundVerdict, "unmeasured");
  assert.equal(parsed.hostBoundRatio, null);
  assert.equal(parsed.deviceMs, 12.5);
  assert.equal(parsed.hostEnqueueMs, undefined);
  assert.match(parsed.hostBoundReason, /no host_enqueue_ms/);
});

test("a truncated block is refused by name", () => {
  const text = `${READING_START_MARKER}\n{"schemaVersion":1,"contractSha":"b"`;
  const reason = parseRefused(text);
  assert.match(reason, /truncated/);
  assert.match(reason, /END KERNEL READING/);
});

test("an unknown schemaVersion is refused by name", () => {
  const reason = parseRefused(block(reading({ schemaVersion: 2 })));
  assert.match(reason, /schemaVersion 2/);
  assert.match(reason, /not understood/);
  assert.match(reason, /reads 1/);
});

test("a body that is not JSON is refused", () => {
  const text = `${READING_START_MARKER}\nnot json at all\n${READING_END_MARKER}\n`;
  const reason = parseRefused(text);
  assert.match(reason, /not JSON/);

  const arrayBody = `${READING_START_MARKER}\n[1,2,3]\n${READING_END_MARKER}\n`;
  assert.match(parseRefused(arrayBody), /not a JSON object/);
});

test("a block buried in 200 lines of noise is found", () => {
  const noise = (tag) => Array.from({ length: 100 }, (_, i) => `${tag} line ${i}: compiling, 41% done`).join("\n");
  const text = `${noise("head")}\n${block(reading())}\n${noise("tail")}`;
  const parsed = parseOk(text);
  assert.equal(parsed.contractSha, "b".repeat(64));
  assert.equal(parsed.cells.length, 2);
});

test("the last block wins when a log holds several runs", () => {
  const first = reading({ shellMs: 1 });
  const second = reading({ shellMs: 2 });
  const parsed = parseOk(`${block(first)}\n${block(second)}`);
  assert.equal(parsed.shellMs, 2);
});

test("a task that reports host_enqueue_ms > device_ms is host_bound", () => {
  const ratio = 2.4 / 1.2;
  const record = reading({
    hostEnqueueMs: 2.4,
    deviceMs: 1.2,
    hostBoundRatio: ratio,
    hostBoundVerdict: "host_bound",
  });
  const parsed = parseOk(block(record));
  assert.equal(parsed.hostBoundVerdict, "host_bound");
  assert.ok(parsed.hostBoundRatio >= HOST_BOUND_RATIO);
  assert.equal(verdictForRatio(ratio), "host_bound");
  assert.equal(verdictForRatio(HOST_BOUND_RATIO), "host_bound");
  assert.equal(verdictForRatio(0.49), "ok");
  assert.equal(verdictForRatio(null), "unmeasured");
});

test("a verdict that contradicts its own ratio is refused, not trusted", () => {
  const lied = parseRefused(block(reading({ hostBoundVerdict: "host_bound" })));
  assert.match(lied, /contradicts hostBoundRatio/);

  const passingUnmeasured = parseRefused(
    block(reading({ hostBoundRatio: null, hostBoundVerdict: "ok" })),
  );
  assert.match(passingUnmeasured, /contradicts hostBoundRatio null/);
});

test("a missing required field is named", () => {
  const broken = reading();
  delete broken.basis;
  const reason = parseRefused(block(broken));
  assert.match(reason, /malformed/);
  assert.match(reason, /basis must be "device" or "e2e"/);
});

function runScript(script, cwd, env = process.env) {
  try {
    const stdout = execFileSync("bash", [script], {
      cwd,
      encoding: "utf8",
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, stdout, stderr: "" };
  } catch (error) {
    return { code: error.status ?? 1, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
  }
}

function setup(overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kernel-expert-reading-"));
  initWorkspace(root);
  fs.writeFileSync(
    path.join(root, "bench.sh"),
    '#!/usr/bin/env bash\nset -euo pipefail\necho "METRIC device_ms=1.5"\necho "METRIC host_enqueue_ms=3"\n',
  );
  const normalized = normalizeContract({
    objective: "cut latency",
    checkCommand: "true",
    benchmarkCommand: "bash bench.sh",
    cells: [{ id: "a", dtype: "bf16", vars: { M: "1024" } }],
    tolerance: { rtol: 1e-2, atol: 1e-3 },
    repeats: 2,
    warmup: 0,
    ...overrides,
  });
  assert.deepEqual(normalized.errors, []);
  const written = writeContractFiles({ root, contract: normalized.contract });
  assert.equal(written.ok, true);
  return { root, paths: workspacePaths(root) };
}

test("the generated goal.sh emits one block the parser accepts, end to end", () => {
  const { root, paths } = setup();
  const result = runScript(paths.benchmarkScript, root);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout.split(READING_START_MARKER).length - 1, 1, "exactly one start marker");

  const parsed = parseOk(result.stdout);
  assert.equal(parsed.contractSha.length, 64);
  assert.equal(parsed.basis, "device");
  assert.equal(parsed.basisSource, "task-reported");
  assert.equal(parsed.cells.length, 1);
  assert.equal(parsed.cells[0].id, "a");
  assert.equal(parsed.cells[0].metric, "latency_us_a");
  assert.equal(parsed.cells[0].median, 1.5);
  assert.equal(parsed.cells[0].samples, 2);
  assert.equal(parsed.deviceMs, 1.5);
  assert.equal(parsed.hostEnqueueMs, 3);
  // The task reported a host enqueue twice its device time: host_bound.
  assert.equal(parsed.hostBoundVerdict, "host_bound");
  assert.equal(parsed.hostBoundRatio, 2);
  assert.match(parsed.startedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
});

test("a bench that reports no device figures yields an unmeasured verdict", () => {
  const { root, paths } = setup({ benchmarkCommand: "bash plain.sh" });
  fs.writeFileSync(path.join(root, "plain.sh"), '#!/usr/bin/env bash\necho "METRIC x=1"\n');
  const result = runScript(paths.benchmarkScript, root);
  assert.equal(result.code, 0, result.stderr);

  const parsed = parseOk(result.stdout);
  assert.equal(parsed.basisSource, "shell-wall");
  assert.equal(parsed.hostBoundRatio, null);
  assert.equal(parsed.hostBoundVerdict, "unmeasured");
  assert.equal(parsed.deviceMs, undefined);
  assert.equal(parsed.hostEnqueueMs, undefined);
  assert.match(parsed.hostBoundReason, /neither device_ms nor host_enqueue_ms/);
  assert.equal(typeof parsed.shellMs, "number", "the shell's own clock is still recorded");
});

test("the contract's e2e basis is copied into the reading", () => {
  const { root, paths } = setup({ basis: "e2e" });
  const result = runScript(paths.benchmarkScript, root);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(parseOk(result.stdout).basis, "e2e");
});
