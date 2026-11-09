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
