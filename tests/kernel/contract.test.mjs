import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import {
  DEFAULT_GROUP,
  MIN_GROUPS_PER_CELL,
  cellMetricName,
  contractJson,
  contractSha,
  freezePayload,
  groupMetricName,
  normalizeContract,
  renderBenchmarkScript,
  renderChecksScript,
  writeContractFiles,
} from "../../extensions/pi-kernel-expert/kernel/contract.ts";
import {
  READING_END_MARKER,
  READING_START_MARKER,
  parseReadingBlock,
} from "../../extensions/pi-kernel-expert/kernel/reading.ts";
import { initWorkspace, workspacePaths } from "../../extensions/pi-kernel-expert/workspace/layout.ts";

/** Three data sets: the minimum a non-boundary cell must state. */
const GROUPS = [
  { name: "typical", intent: "random normal inputs, the ordinary case" },
  { name: "zero_block", intent: "a fully masked block must not divide by zero", seed: 7 },
  { name: "tail", intent: "a length off the tile boundary must not read past M" },
];

const BASE = {
  objective: "cut attention latency",
  checkCommand: "bash check.sh",
  benchmarkCommand: "bash bench.sh",
  cells: [
    { id: "m1024", dtype: "bf16", vars: { M: "1024" }, groups: GROUPS },
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
  const contract = built({ cells: [{ id: "m1024.attn", dtype: "bf16", groups: GROUPS }] });
  assert.equal(cellMetricName(contract, contract.cells[0]), "latency_us_m1024_attn");
  // The per-cell name cellMetricName returns is the aggregate; a group adds its name.
  assert.equal(groupMetricName(contract, contract.cells[0], contract.cells[0].groups[1]), "latency_us_m1024_attn_zero_block");
});

test("freeze payload has one blocking metric and one command criterion", () => {
  const contract = built({ testGlobs: ["tests/**/*.py"], scopeGlobs: ["kernel/**"] });
  const payload = freezePayload(contract);
  assert.deepEqual(payload.test_globs, ["tests/**/*.py"]);
  assert.deepEqual(payload.scope_globs, ["kernel/**"]);
  const blockingMetrics = payload.criteria.filter((c) => c.blocking && c.kind === "metric");
  assert.equal(blockingMetrics.length, 1);
  assert.deepEqual(blockingMetrics[0].metric, { name: "geomean_speedup", direction: "higher", unit: "x" });
  assert.match(blockingMetrics[0].statement, /3 group\(s\) in the matrix/);
  assert.match(payload.criteria.find((c) => c.kind === "command").statement, /every input group/);
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
  // The group table is a separate row format: cell|group|seed|intent.
  assert.match(bench, /CELL_GROUPS=\('m1024\|typical\|\|random normal inputs, the ordinary case'/);
  assert.match(bench, /'m1024\|zero_block\|7\|a fully masked block must not divide by zero'/);
  assert.match(bench, /KERNEL_GROUP_SEED/);

  const checks = renderChecksScript(contract, sha);
  assert.match(checks, /for pass in 1 2/);
  assert.match(checks, /CHECK_CMD='bash check\.sh'/);
  assert.match(checks, /boundary cell/);
  assert.match(checks, /CELL_GROUPS=\('m1024\|typical/);
  assert.match(checks, /export KERNEL_GROUP="\$gname" KERNEL_GROUP_INTENT="\$gintent" KERNEL_GROUP_SEED="\$gseed"/);
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

test("a written contract declares schemaVersion 2, basis device, and the generated harness globs", () => {
  const contract = built();
  assert.equal(contract.schemaVersion, 2);
  assert.equal(contract.basis, "device");
  assert.deepEqual(contract.harnessGlobs, ["goal.sh", "goal.checks.sh"]);
  assert.equal(contract.referenceCommand, null);

  const json = contractJson(contract);
  assert.match(json, /"schemaVersion": 2/);
  assert.match(json, /"basis": "device"/);
  assert.match(json, /"harnessGlobs": \[\s*"goal\.sh",\s*"goal\.checks\.sh"\s*\]/);
  assert.doesNotMatch(json, /"version": 1/, "a v1 `version` key must not survive into v2");

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kernel-expert-contract-"));
  initWorkspace(root);
  const outcome = writeContractFiles({ root, contract });
  assert.equal(outcome.ok, true);
  const onDisk = fs.readFileSync(workspacePaths(root).contract, "utf8");
  assert.match(onDisk, /"schemaVersion": 2/);
  assert.match(onDisk, /"basis": "device"/);
});

test("the basis round-trips as e2e and refuses anything else by name", () => {
  const e2e = built({ basis: "e2e" });
  assert.equal(e2e.basis, "e2e");
  const reparsed = JSON.parse(contractJson(e2e));
  assert.equal(reparsed.basis, "e2e");

  const refused = normalizeContract({ ...BASE, basis: "host" });
  assert.equal(refused.contract, undefined);
  assert.match(refused.errors.join("\n"), /basis must be "device" or "e2e", got "host"/);
});

test("a reference command equal to the benchmark command is refused naming both fields", () => {
  const refusals = [
    { benchmarkCommand: "python bench.py --cell X", referenceCommand: "python bench.py --cell X" },
    { benchmarkCommand: "bash bench.sh", referenceCommand: "  bash bench.sh  " },
  ];
  for (const overrides of refusals) {
    const result = normalizeContract({ ...BASE, ...overrides });
    assert.equal(result.contract, undefined);
    const text = result.errors.join("\n");
    assert.match(text, /referenceCommand and benchmarkCommand are the same command/);
    assert.match(text, /referenceCommand/);
    assert.match(text, /benchmarkCommand/);
    assert.match(text, /a self-reference is not a reference/);
  }

  const distinct = built({ referenceCommand: "python ref.py --cell X" });
  assert.equal(distinct.referenceCommand, "python ref.py --cell X");
});

test("an omitted harnessGlobs warns about a comparator the command runs", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kernel-expert-harness-"));
  fs.writeFileSync(path.join(root, "bench.py"), "print(1)\n");
  fs.writeFileSync(path.join(root, "compare.py"), "print(0)\n");

  const result = normalizeContract(
    {
      ...BASE,
      benchmarkCommand: "python bench.py --cell X",
      checkCommand: "python compare.py | tee check.log",
    },
    { root },
  );
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.contract.harnessGlobs, ["goal.sh", "goal.checks.sh"]);
  const text = result.warnings.join("\n");
  assert.match(text, /bench\.py \(called by benchmarkCommand\)/);
  assert.match(text, /compare\.py \(called by checkCommand\)/);
  assert.match(text, /no harnessGlobs entry covers it/);

  const covered = normalizeContract(
    { ...BASE, benchmarkCommand: "python bench.py --cell X", harnessGlobs: ["bench.py"] },
    { root },
  );
  assert.deepEqual(covered.warnings, [], "an explicit harnessGlobs is not second-guessed");
  assert.doesNotMatch(covered.warnings.join("\n"), /bench\.py/);
});

test("the freeze payload carries the basis, the harness globs, and the reference", () => {
  const contract = built({ basis: "e2e", harnessGlobs: ["bench.py"], referenceCommand: "python ref.py" });
  const payload = freezePayload(contract);
  assert.equal(payload.basis, "e2e");
  assert.deepEqual(payload.harness_globs, ["bench.py"]);
  assert.equal(payload.reference_command, "python ref.py");

  const withoutReference = freezePayload(built());
  assert.equal(withoutReference.reference_command, null);
  assert.deepEqual(withoutReference.harness_globs, ["goal.sh", "goal.checks.sh"]);
});

// --- the reading block, as the generated script prints it -------------------

function readingWorkspace(overrides = {}, benchBody = '#!/usr/bin/env bash\nset -euo pipefail\necho "METRIC device_ms=1.5"\necho "METRIC host_enqueue_ms=3"\n') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kernel-expert-reading-"));
  initWorkspace(root);
  fs.writeFileSync(path.join(root, "bench.sh"), benchBody);
  const normalized = normalizeContract({
    ...BASE,
    benchmarkCommand: "bash bench.sh",
    repeats: 2,
    warmup: 0,
    ...overrides,
  });
  assert.deepEqual(normalized.errors, []);
  const written = writeContractFiles({ root, contract: normalized.contract });
  assert.equal(written.ok, true);
  return { root, paths: workspacePaths(root) };
}

function runScript(script, cwd, env) {
  try {
    const stdout = execFileSync("bash", [script], {
      cwd,
      encoding: "utf8",
      env: env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, stdout, stderr: "" };
  } catch (error) {
    return { code: error.status ?? 1, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
  }
}

function stubBin(name, body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kernel-expert-stub-"));
  const file = path.join(dir, name);
  fs.writeFileSync(file, body);
  fs.chmodSync(file, 0o755);
  return dir;
}

function withPath(dir, extraEnv = {}) {
  return { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH ?? ""}`, ...extraEnv };
}

test("the generated benchmark script passes bash -n", () => {
  const contract = built();
  const script = renderBenchmarkScript(contract, contractSha(contractJson(contract)));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kernel-expert-bashn-"));
  const file = path.join(root, "goal.sh");
  fs.writeFileSync(file, script);
  // execFileSync throws on a non-zero exit; a syntax error must not be a passing test.
  execFileSync("bash", ["-n", file], { stdio: ["ignore", "pipe", "pipe"] });
});

test("one reading block per run, printed after every METRIC line", () => {
  const contract = built();
  const script = renderBenchmarkScript(contract, contractSha(contractJson(contract)));
  assert.equal(script.split(READING_START_MARKER).length - 1, 1, "the start marker is written once");
  assert.equal(script.split(READING_END_MARKER).length - 1, 1, "the end marker is written once");

  const { root, paths } = readingWorkspace({ benchmarkCommand: "bash -c 'echo METRIC x=1'" });
  const result = runScript(paths.benchmarkScript, root);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout.split(READING_START_MARKER).length - 1, 1);
  assert.equal(result.stdout.split(READING_END_MARKER).length - 1, 1);

  const metricLines = result.stdout.split("\n").filter((line) => /^METRIC\s+/.test(line));
  assert.deepEqual(metricLines, [
    "METRIC latency_us_m1024_typical=1",
    "METRIC latency_us_m1024_zero_block=1",
    "METRIC latency_us_m1024_tail=1",
    // one aggregate per cell: the median over that cell's groups
    "METRIC latency_us_m1024=1",
    // a boundary cell carries no groups, so it runs once as `default`
    "METRIC latency_us_m4096_default=1",
    "METRIC latency_us_m4096=1",
    "METRIC geomean_speedup=1",
  ]);
  const blockAt = result.stdout.indexOf(READING_START_MARKER);
  const lastMetricAt = result.stdout.lastIndexOf(`METRIC geomean_speedup=1`);
  assert.ok(lastMetricAt < blockAt, "every METRIC line precedes the block");
});

test("the block prints with gpu.available false when nvidia-smi fails, and the exit code is unchanged", () => {
  const { root, paths } = readingWorkspace();
  const bin = stubBin("nvidia-smi", "#!/usr/bin/env bash\nexit 1\n");
  const result = runScript(paths.benchmarkScript, root, withPath(bin));
  assert.equal(result.code, 0, result.stderr);

  const parsed = parseReadingBlock(result.stdout);
  assert.equal(parsed.ok, true, parsed.ok ? "" : parsed.reason);
  assert.equal(parsed.reading.gpu.available, false);
  assert.match(parsed.reading.gpu.error, /nvidia-smi/);
  assert.ok(
    parsed.reading.warnings.some((warning) => /no GPU state/.test(warning)),
    `warnings should say the state is missing: ${JSON.stringify(parsed.reading.warnings)}`,
  );
});

test("the block records GPU state from nvidia-smi, escaping a name with spaces and quotes", () => {
  const { root, paths } = readingWorkspace();
  const bin = stubBin(
    "nvidia-smi",
    [
      "#!/usr/bin/env bash",
      'for arg in "$@"; do',
      '  case "$arg" in',
      "    --version) printf 'NVIDIA-SMI version    : 999.0.0\\nCUDA Version          : 12.4\\n'; exit 0 ;;",
      '    --query-gpu=*) printf \'0, NVIDIA H200 "PCIe", 1980, 1593, 7\\n\'; exit 0 ;;',
      "    --query-compute-apps=*) printf '424242, 512\\n'; exit 0 ;;",
      "  esac",
      "done",
      "exit 1",
    ].join("\n"),
  );
  const result = runScript(paths.benchmarkScript, root, withPath(bin, { CUDA_VISIBLE_DEVICES: "0" }));
  assert.equal(result.code, 0, result.stderr);

  const parsed = parseReadingBlock(result.stdout);
  assert.equal(parsed.ok, true, parsed.ok ? "" : parsed.reason);
  const gpu = parsed.reading.gpu;
  assert.equal(gpu.available, true);
  assert.equal(gpu.name, 'NVIDIA H200 "PCIe"');
  assert.equal(gpu.index, 0);
  assert.equal(gpu.visible, "0");
  assert.equal(gpu.start.clocksSmMhz, 1980);
  assert.equal(gpu.start.clocksMemMhz, 1593);
  assert.equal(gpu.start.utilPct, 7);
  assert.equal(gpu.start.foreignProcessMiB, 512);
  assert.match(parsed.reading.nvidiaSmi, /NVIDIA-SMI version/);
  assert.ok(
    parsed.reading.warnings.some((warning) => /contended/.test(warning)),
    `a foreign process should be called out: ${JSON.stringify(parsed.reading.warnings)}`,
  );
});

test("the block is emitted before a guard failure's exit 1", () => {
  const { root, paths } = readingWorkspace(
    { cells: [{ id: "a", dtype: "bf16", vars: { M: "1024" }, groups: GROUPS }] },
    '#!/usr/bin/env bash\nset -euo pipefail\ncat speed\n',
  );
  fs.writeFileSync(path.join(root, "speed"), "10\n");
  const baseline = runScript(paths.benchmarkScript, root);
  assert.equal(baseline.code, 0, baseline.stderr);
  fs.writeFileSync(path.join(root, "speed"), "40\n");

  const regressed = runScript(paths.benchmarkScript, root);
  assert.equal(regressed.code, 1, "the guard exit code is unchanged");
  assert.match(regressed.stderr, /guard: cell a regressed/);
  assert.equal(regressed.stdout.split(READING_START_MARKER).length - 1, 1);
  const parsed = parseReadingBlock(regressed.stdout);
  assert.equal(parsed.ok, true, parsed.ok ? "" : parsed.reason);
  assert.equal(parsed.reading.cells[0].median, 40);
});

// --- input groups: a shape is not a data set --------------------------------

function groupWorkspace({ cells, checkCommand = "bash check.sh", benchBody } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kernel-expert-groups-"));
  initWorkspace(root);
  fs.writeFileSync(
    path.join(root, "bench.sh"),
    benchBody ??
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        'key="$KERNEL_CELL.$KERNEL_GROUP"',
        'if [[ -f "speeds/$key" ]]; then cat "speeds/$key"; else echo 5; fi',
        "",
      ].join("\n"),
  );
  fs.writeFileSync(
    path.join(root, "check.sh"),
    '#!/usr/bin/env bash\nprintf "%s %s %s %s\\n" "$KERNEL_CELL" "$KERNEL_GROUP" "$KERNEL_GROUP_INTENT" "$KERNEL_GROUP_SEED" >> calls.log\n',
  );
  fs.mkdirSync(path.join(root, "speeds"));
  const normalized = normalizeContract({
    ...BASE,
    benchmarkCommand: "bash bench.sh",
    checkCommand,
    repeats: 2,
    warmup: 0,
    cells: cells ?? BASE.cells,
  });
  assert.deepEqual(normalized.errors, []);
  const written = writeContractFiles({ root, contract: normalized.contract });
  assert.equal(written.ok, true);
  return { root, paths: workspacePaths(root), contract: normalized.contract };
}

const THREE = (prefix, seed) => [
  { name: "typical", intent: `${prefix}: random normal inputs, the ordinary case` },
  { name: "zero_block", intent: `${prefix}: a fully masked block must not divide by zero`, seed },
  { name: "tail", intent: `${prefix}: a length off the tile boundary must not read past N` },
];

test("a non-boundary cell with fewer than three groups is refused, naming the cell and the minimum", () => {
  const result = normalizeContract({
    ...BASE,
    cells: [
      {
        id: "m1024",
        dtype: "bf16",
        groups: [
          { name: "typical", intent: "random normal inputs" },
          { name: "zero_block", intent: "an all-zero block" },
        ],
      },
    ],
  });
  assert.equal(result.contract, undefined);
  const text = result.errors.join("\n");
  assert.match(text, /cells\[0\] \(cell "m1024"\) has 2 input group\(s\)/);
  assert.match(text, new RegExp(`at least ${MIN_GROUPS_PER_CELL}`));
  assert.match(text, /mark the cell boundary: true/);
});

test("a group without an intent is refused, naming the cell and the group", () => {
  const result = normalizeContract({
    ...BASE,
    cells: [
      {
        id: "m1024",
        dtype: "bf16",
        groups: [
          { name: "typical", intent: "random normal inputs" },
          { name: "zero_block", intent: "   " },
          { name: "tail" },
        ],
      },
    ],
  });
  assert.equal(result.contract, undefined);
  const text = result.errors.join("\n");
  assert.match(text, /cells\[0\]\.groups\[1\] \(group "zero_block" of cell "m1024"\) has no intent/);
  assert.match(text, /cells\[0\]\.groups\[2\] \(group "tail" of cell "m1024"\) has no intent/);
});

test("a duplicate group name in one cell, a bad name, and a non-integer seed are refused", () => {
  const duplicate = normalizeContract({
    ...BASE,
    cells: [
      {
        id: "m1024",
        dtype: "bf16",
        groups: [
          { name: "typical", intent: "one" },
          { name: "TYPICAL", intent: "two" },
          { name: "tail", intent: "three" },
        ],
      },
    ],
  });
  assert.equal(duplicate.contract, undefined);
  assert.match(duplicate.errors.join("\n"), /cells\[0\]\.groups\[1\]\.name "TYPICAL" is duplicated in cell "m1024"/);

  const bad = normalizeContract({
    ...BASE,
    cells: [
      {
        id: "m1024",
        dtype: "bf16",
        groups: [
          { name: "typical", intent: "one" },
          { name: "has space", intent: "two" },
          { name: "tail", intent: "three values, comma-separated", seed: 1.5 },
          { name: "pipe", intent: "left|right" },
        ],
      },
    ],
  });
  assert.equal(bad.contract, undefined);
  const text = bad.errors.join("\n");
  assert.match(text, /groups\[1\]\.name "has space"/);
  assert.match(text, /groups\[2\]\.seed \(group "tail"\) must be an integer/);
  assert.match(text, /groups\[3\]\.intent \(group "pipe"\) must not contain "\|"/);
});

test("a boundary cell with no groups is accepted and exports KERNEL_GROUP=default", () => {
  const { root, paths, contract } = groupWorkspace({
    cells: [{ id: "m4096", dtype: "fp8_e4m3", boundary: true }],
  });
  assert.deepEqual(contract.cells[0].groups, []);

  const bench = runScript(paths.benchmarkScript, root);
  assert.equal(bench.code, 0, bench.stderr);
  const checks = runScript(paths.checksScript, root);
  assert.equal(checks.code, 0, checks.stderr);

  const calls = fs.readFileSync(path.join(root, "calls.log"), "utf8").split("\n").filter(Boolean);
  assert.equal(calls.length, 2, "two passes, one default group");
  for (const call of calls) {
    assert.match(call, /^m4096 default {0,2}$/, "KERNEL_GROUP is default and the intent and seed are empty");
  }
  assert.equal(DEFAULT_GROUP, "default");
});

test("a boundary cell with no groups fails the checks as a shape, with no group in the line", () => {
  const { root, paths } = groupWorkspace({
    cells: [{ id: "m4096", dtype: "fp8_e4m3", boundary: true }],
    checkCommand: "bash -c 'exit 1'",
  });
  const result = runScript(paths.checksScript, root);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /^FAIL cell m4096 \(boundary cell\) pass 1:$/m);
  const failLines = result.stderr.split("\n").filter((line) => line.startsWith("FAIL "));
  assert.doesNotMatch(failLines.join("\n"), /group /, "a shape failure must not name a group");
  assert.match(result.stderr, /checks failed: 1 cell\/group pair\(s\)/);
});

test("a group failure is named as a group failure, not as a shape failure", () => {
  const { root, paths } = groupWorkspace({
    cells: [{ id: "m1024", dtype: "bf16", groups: THREE("m1024", 11) }],
    // Correct on typical, wrong on zero_block: the case this ticket exists for.
    checkCommand: 'bash -c \'[[ "$KERNEL_GROUP" != zero_block ]]\'',
  });
  const result = runScript(paths.checksScript, root);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /^FAIL cell m1024 group zero_block pass 1:$/m);
  assert.equal(result.stderr.split("\n").filter((line) => line.startsWith("FAIL ")).length, 1);
  assert.doesNotMatch(result.stderr, /FAIL cell m1024 pass/, "the shape line must not repeat for a group");
});

test("the generated checks script iterates every cell x group, twice each", () => {
  const cells = [
    { id: "m1024", dtype: "bf16", vars: { M: "1024" }, groups: THREE("m1024", 11) },
    { id: "m4096", dtype: "fp8", vars: { M: "4096" }, groups: THREE("m4096", 22) },
  ];
  const { root, paths } = groupWorkspace({ cells });
  const result = runScript(paths.checksScript, root);
  assert.equal(result.code, 0, result.stderr);

  const calls = fs.readFileSync(path.join(root, "calls.log"), "utf8").trim().split("\n");
  const pairs = calls.map((line) => line.split(" ").slice(0, 2).join(" "));
  // 2 cells x 3 groups = 6 pairs, each run twice (two passes).
  assert.deepEqual([...new Set(pairs)].sort(), [
    "m1024 tail",
    "m1024 typical",
    "m1024 zero_block",
    "m4096 tail",
    "m4096 typical",
    "m4096 zero_block",
  ]);
  assert.equal(calls.length, 12);
  assert.match(result.stdout, /checks ok: 2 cell\(s\), 2 passes each, 6 cell x group pair\(s\)/);

  // The intent and the seed travel with the group, so the command can build it.
  assert.ok(
    calls.includes("m4096 zero_block m4096: a fully masked block must not divide by zero 22"),
    `the zero_block call should carry its intent and seed:\n${calls.join("\n")}`,
  );
});

test("the generated bench prints one METRIC per cell x group plus one aggregate per cell", () => {
  const { root, paths } = groupWorkspace();
  fs.writeFileSync(path.join(root, "speeds", "m1024.zero_block"), "20\n");
  fs.writeFileSync(path.join(root, "speeds", "m1024.typical"), "10\n");
  fs.writeFileSync(path.join(root, "speeds", "m1024.tail"), "10\n");

  const result = runScript(paths.benchmarkScript, root);
  assert.equal(result.code, 0, result.stderr);
  const metricLines = result.stdout.split("\n").filter((line) => /^METRIC\s+/.test(line));
  assert.deepEqual(metricLines, [
    "METRIC latency_us_m1024_typical=10",
    "METRIC latency_us_m1024_zero_block=20",
    "METRIC latency_us_m1024_tail=10",
    // the aggregate the gate reads: the geomean over the cell's groups
    "METRIC latency_us_m1024=12.5992105",
    "METRIC latency_us_m4096_default=5",
    "METRIC latency_us_m4096=5",
    "METRIC geomean_speedup=1",
  ]);

  const parsed = parseReadingBlock(result.stdout);
  assert.equal(parsed.ok, true, parsed.ok ? "" : parsed.reason);
  assert.deepEqual(
    parsed.reading.cells.map((cell) => [cell.id, cell.group, cell.metric, cell.median]),
    [
      ["m1024", "typical", "latency_us_m1024_typical", 10],
      ["m1024", "zero_block", "latency_us_m1024_zero_block", 20],
      ["m1024", "tail", "latency_us_m1024_tail", 10],
      ["m4096", "default", "latency_us_m4096_default", 5],
    ],
  );
});

test("a contract this build did not write — cells without groups — is refused at write time", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kernel-expert-contract-"));
  initWorkspace(root);
  const contract = built();
  const legacy = {
    ...contract,
    cells: contract.cells.map(({ groups, ...rest }) => rest),
  };
  const outcome = writeContractFiles({ root, contract: legacy });
  assert.equal(outcome.ok, false);
  assert.match(outcome.errors[0], /cell "m1024" has no groups array/);
  assert.match(outcome.errors[0], /regenerate with kernel_contract/);
  assert.equal(fs.existsSync(workspacePaths(root).contract), false);
});
