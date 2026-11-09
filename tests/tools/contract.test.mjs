import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import kernelExpertExtension from "../../extensions/pi-kernel-expert/index.ts";
import { fakePi } from "../helpers/fake-host.mjs";
import {
  DRAFT_HEADINGS,
  PLAN_HEADINGS,
  workspacePaths,
} from "../../extensions/pi-kernel-expert/workspace/layout.ts";

function host() {
  const pi = fakePi();
  kernelExpertExtension(pi);
  const ctx = { cwd: "", ui: { notify() {} }, hasUI: false };
  return { pi, ctx };
}

function fill(root) {
  const paths = workspacePaths(root);
  fs.writeFileSync(paths.draft, ["# draft", ...DRAFT_HEADINGS.flatMap((h) => [`## ${h}`, `text ${h}`, ""])].join("\n"));
  fs.writeFileSync(paths.plan, ["# plan", ...PLAN_HEADINGS.flatMap((h) => [`## ${h}`, `text ${h}`, ""])].join("\n"));
}

const CONTRACT_PARAMS = {
  objective: "cut latency",
  check_command: "bash check.sh",
  benchmark_command: "bash bench.sh",
  cells: [{ id: "a", dtype: "bf16", vars: { M: "1024" } }],
  rtol: 1e-2,
  atol: 1e-3,
  repeats: 2,
  warmup: 0,
};

test("kernel_init creates the workspace and warns about a draft that is still placeholders", async () => {
  const { pi, ctx } = host();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kernel-expert-tool-"));
  ctx.cwd = root;
  const tool = pi.tools.get("kernel_init");
  const result = await tool.execute("id", {}, undefined, undefined, ctx);
  const text = result.content[0].text;
  assert.match(text, /created: docs\/draft\.md, docs\/plan\.md, candidates\.jsonl/);
  assert.match(text, /still need real content/);
  assert.match(text, /not a git repository/);
  assert.equal(fs.existsSync(path.join(root, "docs", "draft.md")), true);
});

test("kernel_contract refuses an incomplete draft and writes nothing", async () => {
  const { pi, ctx } = host();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kernel-expert-tool-"));
  ctx.cwd = root;
  await pi.tools.get("kernel_init").execute("id", {}, undefined, undefined, ctx);

  const result = await pi.tools.get("kernel_contract").execute("id", CONTRACT_PARAMS, undefined, undefined, ctx);
  assert.match(result.content[0].text, /Contract not generated: the plan draft is not ready/);
  assert.match(result.content[0].text, /Baseline and validation/);
  assert.equal(fs.existsSync(workspacePaths(root).contract), false);
});

test("kernel_contract writes the artifacts and returns the freeze payload", async () => {
  const { pi, ctx } = host();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kernel-expert-tool-"));
  ctx.cwd = root;
  await pi.tools.get("kernel_init").execute("id", {}, undefined, undefined, ctx);
  fill(root);

  const result = await pi.tools.get("kernel_contract").execute("id", CONTRACT_PARAMS, undefined, undefined, ctx);
  const text = result.content[0].text;
  assert.match(text, /Contract frozen for 1 cell\(s\)/);
  assert.match(text, /kernel\.contract\.json sha256 [0-9a-f]{64}/);
  assert.match(text, /"name": "geomean_speedup"/);
  assert.match(text, /"direction": "higher"/);
  assert.equal(result.details.freeze.criteria.filter((c) => c.kind === "metric" && c.blocking).length, 1);

  const paths = workspacePaths(root);
  for (const file of [paths.contract, paths.benchmarkScript, paths.checksScript, paths.freezePayload]) {
    assert.ok(fs.existsSync(file), `${file} missing`);
  }
});

test("kernel_contract refuses to clobber an existing contract without force", async () => {
  const { pi, ctx } = host();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kernel-expert-tool-"));
  ctx.cwd = root;
  await pi.tools.get("kernel_init").execute("id", {}, undefined, undefined, ctx);
  fill(root);

  await pi.tools.get("kernel_contract").execute("id", CONTRACT_PARAMS, undefined, undefined, ctx);
  const second = await pi.tools.get("kernel_contract").execute("id", CONTRACT_PARAMS, undefined, undefined, ctx);
  assert.match(second.content[0].text, /already exists; pass force/);

  const forced = await pi.tools.get("kernel_contract").execute(
    "id",
    { ...CONTRACT_PARAMS, force: true },
    undefined,
    undefined,
    ctx,
  );
  assert.match(forced.content[0].text, /Contract frozen/);
});

test("kernel_contract carries the basis, the harness globs, and the reference into both artifacts", async () => {
  const { pi, ctx } = host();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kernel-expert-tool-"));
  ctx.cwd = root;
  await pi.tools.get("kernel_init").execute("id", {}, undefined, undefined, ctx);
  fill(root);

  const result = await pi.tools.get("kernel_contract").execute(
    "id",
    {
      ...CONTRACT_PARAMS,
      basis: "e2e",
      harness_globs: ["bench.py", "goal.sh"],
      reference_command: "python ref.py",
    },
    undefined,
    undefined,
    ctx,
  );
  const text = result.content[0].text;
  assert.match(text, /basis e2e {2}harness bench\.py, goal\.sh/);
  assert.match(text, /reference python ref\.py/);

  const paths = workspacePaths(root);
  const contract = JSON.parse(fs.readFileSync(paths.contract, "utf8"));
  assert.equal(contract.schemaVersion, 2);
  assert.equal(contract.basis, "e2e");
  assert.deepEqual(contract.harnessGlobs, ["bench.py", "goal.sh"]);
  assert.equal(contract.referenceCommand, "python ref.py");

  const freeze = JSON.parse(fs.readFileSync(paths.freezePayload, "utf8"));
  assert.equal(freeze.basis, "e2e");
  assert.deepEqual(freeze.harness_globs, ["bench.py", "goal.sh"]);
  assert.equal(freeze.reference_command, "python ref.py");
  assert.deepEqual(freeze, result.details.freeze);
});

test("kernel_contract defaults the basis and warns about a comparator no glob covers", async () => {
  const { pi, ctx } = host();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kernel-expert-tool-"));
  ctx.cwd = root;
  await pi.tools.get("kernel_init").execute("id", {}, undefined, undefined, ctx);
  fill(root);
  fs.writeFileSync(path.join(root, "bench.py"), "print(1)\n");

  const result = await pi.tools.get("kernel_contract").execute(
    "id",
    { ...CONTRACT_PARAMS, benchmark_command: "python bench.py --cell X" },
    undefined,
    undefined,
    ctx,
  );
  const text = result.content[0].text;
  assert.match(text, /basis device {2}harness goal\.sh, goal\.checks\.sh/);
  assert.match(text, /warnings:/);
  assert.match(text, /bench\.py \(called by benchmarkCommand\) exists but no harnessGlobs entry covers it/);
  assert.equal(result.details.warnings.length, 1);
  assert.match(result.details.warnings[0], /bench\.py/);

  const contract = JSON.parse(fs.readFileSync(workspacePaths(root).contract, "utf8"));
  assert.equal(contract.basis, "device");
  assert.deepEqual(contract.harnessGlobs, ["goal.sh", "goal.checks.sh"]);
});

test("kernel_contract refuses a self-reference before writing anything", async () => {
  const { pi, ctx } = host();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kernel-expert-tool-"));
  ctx.cwd = root;
  await pi.tools.get("kernel_init").execute("id", {}, undefined, undefined, ctx);
  fill(root);

  const result = await pi.tools.get("kernel_contract").execute(
    "id",
    { ...CONTRACT_PARAMS, reference_command: "bash bench.sh" },
    undefined,
    undefined,
    ctx,
  );
  assert.match(result.content[0].text, /Contract not generated:/);
  assert.match(result.content[0].text, /referenceCommand and benchmarkCommand are the same command/);
  assert.match(result.content[0].text, /a self-reference is not a reference/);
  assert.equal(fs.existsSync(workspacePaths(root).contract), false);
});
