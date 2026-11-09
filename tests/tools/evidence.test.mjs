import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import kernelExpertExtension from "../../extensions/pi-kernel-expert/index.ts";
import { DRAFT_HEADINGS, PLAN_HEADINGS } from "../../extensions/pi-kernel-expert/workspace/layout.ts";
import { fakePi } from "../helpers/fake-host.mjs";
import { processExec } from "../helpers/process-exec.mjs";

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function fill(root) {
  const docs = path.join(root, "docs");
  fs.writeFileSync(
    path.join(docs, "draft.md"),
    ["# draft", ...DRAFT_HEADINGS.flatMap((h) => [`## ${h}`, `text ${h}`, ""])].join("\n"),
  );
  fs.writeFileSync(
    path.join(docs, "plan.md"),
    ["# plan", ...PLAN_HEADINGS.flatMap((h) => [`## ${h}`, `text ${h}`, ""])].join("\n"),
  );
}

test("kernel_candidate maps tool parameters onto the ledger through a real repo", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kernel-expert-evidence-"));
  git(["init", "-q"], root);
  git(["config", "user.email", "test@example.com"], root);
  git(["config", "user.name", "Test"], root);
  fs.mkdirSync(path.join(root, "kernel"));
  fs.writeFileSync(path.join(root, "kernel", "attn.cu"), "v1\n");
  git(["add", "-A"], root);
  git(["commit", "-q", "-m", "base"], root);

  const pi = fakePi({ exec: processExec() });
  kernelExpertExtension(pi);
  const ctx = { cwd: root, ui: { notify() {} }, hasUI: false };

  await pi.tools.get("kernel_init").execute("id", {}, undefined, undefined, ctx);
  fill(root);
  const contract = await pi.tools.get("kernel_contract").execute(
    "id",
    {
      objective: "cut latency",
      check_command: "bash check.sh",
      benchmark_command: "bash bench.sh",
      cells: [
        {
          id: "a",
          dtype: "bf16",
          groups: [
            { name: "typical", intent: "random normal inputs, the ordinary case" },
            { name: "zero_block", intent: "a fully masked block must not divide by zero" },
            { name: "tail", intent: "a length off the tile boundary must not read past M" },
          ],
        },
      ],
      rtol: 1e-2,
      atol: 1e-3,
      scope_globs: ["kernel/**"],
    },
    undefined,
    undefined,
    ctx,
  );
  assert.match(contract.content[0].text, /Contract frozen/);

  fs.writeFileSync(path.join(root, "kernel", "attn.cu"), "v2\n");
  const first = await pi.tools.get("kernel_candidate").execute(
    "id",
    {
      decision: "keep",
      description: "widen the tile",
      metrics: { geomean_speedup: 1.15, latency_us_a: 12.5 },
      force_with_reason: "checked above noise by hand",
    },
    undefined,
    undefined,
    ctx,
  );
  assert.match(first.content[0].text, /recorded C1 \(keep\)/);
  assert.match(first.content[0].text, /benchmark\.csv refreshed \(1 row/);
  assert.equal(first.details.benchmarkCsv, path.join(root, "benchmark.csv"));

  const rejected = await pi.tools.get("kernel_candidate").execute(
    "id",
    { decision: "reject", description: "swap the tiling", reason: "the 8k cell regressed" },
    undefined,
    undefined,
    ctx,
  );
  assert.match(rejected.content[0].text, /recorded C2 \(reject\)/);
  assert.match(rejected.content[0].text, /parent C1/);

  const bad = await pi.tools.get("kernel_candidate").execute(
    "id",
    { decision: "keep", description: "no improvement", metrics: { geomean_speedup: 1.0, latency_us_a: 12.5 } },
    undefined,
    undefined,
    ctx,
  );
  assert.match(bad.content[0].text, /below the 2% noise floor/);
});

// --- end to end: the real goal.sh, the real tool, the refusal it produces ----

/** One end-to-end workspace: a real bench, a real goal.sh, a kernel change. */
async function e2eWorkspace({ hostEnqueueMs = "0.2" } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kernel-expert-e2e-"));
  git(["init", "-q"], root);
  git(["config", "user.email", "test@example.com"], root);
  git(["config", "user.name", "Test"], root);
  fs.mkdirSync(path.join(root, "kernel"));
  fs.writeFileSync(path.join(root, "kernel", "attn.cu"), "v1\n");
  fs.writeFileSync(path.join(root, "check.sh"), "#!/usr/bin/env bash\nexit 0\n");
  // A bench whose device window is thin but whose host path is not: 0.2 ms of
  // enqueue behind 0.05 ms of device time, the shape a pipelined timer reports.
  fs.writeFileSync(
    path.join(root, "bench.sh"),
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      "if [[ -f fast ]]; then value=5; else value=10; fi",
      'echo "METRIC latency_us=$value"',
      'echo "METRIC device_ms=0.05"',
      `echo "METRIC host_enqueue_ms=${hostEnqueueMs}"`,
    ].join("\n"),
  );
  git(["add", "-A"], root);
  git(["commit", "-q", "-m", "base"], root);

  const pi = fakePi({ exec: processExec() });
  kernelExpertExtension(pi);
  const ctx = { cwd: root, ui: { notify() {} }, hasUI: false };
  await pi.tools.get("kernel_init").execute("id", {}, undefined, undefined, ctx);
  fill(root);

  const contract = await pi.tools.get("kernel_contract").execute(
    "id",
    {
      objective: "cut latency",
      check_command: "bash check.sh",
      benchmark_command: "bash bench.sh",
      cells: [
        {
          id: "a",
          dtype: "bf16",
          groups: [
            { name: "typical", intent: "random normal inputs, the ordinary case" },
            { name: "zero_block", intent: "a fully masked block must not divide by zero" },
            { name: "tail", intent: "a length off the tile boundary must not read past M" },
          ],
        },
      ],
      rtol: 1e-2,
      atol: 1e-3,
      scope_globs: ["kernel/**", "bench.sh"],
      harness_globs: ["bench.sh", "goal.sh"],
      repeats: 1,
      warmup: 0,
    },
    undefined,
    undefined,
    ctx,
  );
  assert.match(contract.content[0].text, /Contract frozen/);
  return { root, pi, ctx };
}

function runGoal(root) {
  return processExec()
    .exec("bash", ["goal.sh"], { cwd: root })
    .then((result) => {
      assert.equal(result.code, 0, result.stderr);
      return result.stdout;
    });
}

/** The METRIC lines the run printed, as the tool's `metrics` argument. */
function metricMap(stdout) {
  const metrics = {};
  for (const line of stdout.split("\n")) {
    const match = /^METRIC\s+([A-Za-z0-9_.]+)=([0-9.eE+-]+)$/.exec(line.trim());
    if (match) metrics[match[1]] = Number(match[2]);
  }
  return metrics;
}

test("kernel_candidate refuses a host-bound keep whose diff touched the harness, in one block", async () => {
  const { root, pi, ctx } = await e2eWorkspace();

  // a baseline run, then a faster run against it: a real geomean_speedup
  const baseline = await runGoal(root);
  assert.equal(metricMap(baseline).geomean_speedup, 1);
  fs.writeFileSync(path.join(root, "fast"), "");

  fs.writeFileSync(path.join(root, "kernel", "attn.cu"), "v2\n");
  fs.writeFileSync(path.join(root, "bench.sh"), `${fs.readFileSync(path.join(root, "bench.sh"), "utf8")}# loosened\n`);
  const run = await runGoal(root);
  const metrics = metricMap(run);
  assert.ok(metrics.geomean_speedup > 1, "the second run is faster than the baseline");
  assert.ok(metrics.latency_us_a > 0, "the cell aggregate is on the run's output");

  const outcome = await pi.tools.get("kernel_candidate").execute(
    "id",
    { decision: "keep", description: "speed the epilogue", metrics, reading: run },
    undefined,
    undefined,
    ctx,
  );
  const text = outcome.content[0].text;
  assert.match(text, /^Candidate not recorded — 2 refusal\(s\), all printed/m);
  assert.match(text, /host-bound \(charged to the candidate\): hostBoundRatio 4 /);
  assert.match(text, /harness-touched \(charged to the candidate\): the diff edits harness file bench\.sh/);
  assert.equal(text.split("\n").filter((line) => line.startsWith("- ")).length, 2);
  assert.deepEqual(
    outcome.details.refusals.map((refusal) => refusal.rule),
    ["host-bound", "harness-touched"],
  );
  assert.equal(fs.existsSync(path.join(root, "candidates.jsonl")), true);
  assert.equal(fs.readFileSync(path.join(root, "candidates.jsonl"), "utf8").trim(), "", "a refused keep writes no ledger row");
});

test("the same shape of run is kept when the host path is thin and the harness is untouched", async () => {
  const { root, pi, ctx } = await e2eWorkspace({ hostEnqueueMs: "0.005" });
  await runGoal(root);
  fs.writeFileSync(path.join(root, "fast"), "");
  fs.writeFileSync(path.join(root, "kernel", "attn.cu"), "v2\n");

  const run = await runGoal(root);
  const keep = await pi.tools.get("kernel_candidate").execute(
    "id",
    { decision: "keep", description: "speed the epilogue", metrics: metricMap(run), reading: run },
    undefined,
    undefined,
    ctx,
  );
  const text = keep.content[0].text;
  assert.match(text, /recorded C1 \(keep\)/);
  assert.match(text, /reading: basis device, hostBoundRatio 0\.1, verdict measured, pairing absent/);
  const [row] = fs.readFileSync(path.join(root, "candidates.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(row.pairing, "absent");
  assert.equal(row.verdict, "measured");
  assert.deepEqual(row.forcedRules, []);
  assert.equal(row.reading.hostBoundVerdict, "ok");
});
