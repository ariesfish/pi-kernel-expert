/**
 * T-015 evidence: kernel_init writes a milestone template, and the validator
 * refuses it by naming every placeholder; kernel_contract warns without failing.
 * Run from this directory: node --experimental-strip-types run-init.mts
 */
import * as fs from "node:fs";
import * as path from "node:path";

import kernelExpertExtension from "../../../../extensions/pi-kernel-expert/index.ts";
import { DRAFT_HEADINGS, PLAN_HEADINGS, workspacePaths } from "../../../../extensions/pi-kernel-expert/workspace/layout.ts";
import { fakeCommandContext, fakePi } from "../../../../tests/helpers/fake-host.mjs";

const ROOT = path.resolve(".work");
fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(ROOT, { recursive: true });

const pi = fakePi();
kernelExpertExtension(pi);
const { ctx } = fakeCommandContext({ cwd: ROOT });
const call = async (name: string, params: Record<string, unknown>) => {
  const result = await pi.tools.get(name).execute("call", params, undefined, undefined, ctx);
  return result.content[0].text;
};
const say = (heading: string, body: string): void => {
  console.log(`\n${"=".repeat(72)}\n${heading}\n${"=".repeat(72)}\n${body.trim()}`);
};

say("1. kernel_init on an empty workspace", await call("kernel_init", {}));

const paths = workspacePaths(ROOT);
say("2. the milestone template it wrote (docs/milestone.md, first 24 lines)", fs.readFileSync(paths.milestone, "utf8").split("\n").slice(0, 24).join("\n"));

say("3. kernel_milestone on the untouched template", await call("kernel_milestone", {}));

// The contract needs a real draft/plan first; the template is meant to be refused.
fs.writeFileSync(paths.draft, ["# draft", ...DRAFT_HEADINGS.flatMap((h) => [`## ${h}`, `text ${h}`, ""])].join("\n"));
fs.writeFileSync(paths.plan, ["# plan", ...PLAN_HEADINGS.flatMap((h) => [`## ${h}`, `text ${h}`, ""])].join("\n"));
const contractText = await call("kernel_contract", {
  objective: "cut latency",
  check_command: "bash check.sh",
  benchmark_command: "bash bench.sh",
  cells: [{
    id: "a",
    dtype: "bf16",
    groups: [
      { name: "typical", intent: "random normal inputs, the ordinary case" },
      { name: "zero_block", intent: "a fully masked block must not divide by zero" },
      { name: "tail", intent: "a length off the tile boundary must not read past M" },
    ],
  }],
  rtol: 1e-2,
  atol: 1e-3,
});
say("4. kernel_contract with the template still in place (warns, does not refuse)", contractText.split("\nfreeze_criteria payload:")[0]);
console.log(`\nkernel.contract.json written: ${fs.existsSync(paths.contract)}`);

// The warning is what makes the next step obvious: remove the milestone and the
// warning changes from "still a template" to "there is no plan at all".
fs.rmSync(paths.milestone);
const noMilestone = await call("kernel_contract", {
  objective: "cut latency",
  check_command: "bash check.sh",
  benchmark_command: "bash bench.sh",
  cells: [{
    id: "a",
    dtype: "bf16",
    groups: [
      { name: "typical", intent: "random normal inputs, the ordinary case" },
      { name: "zero_block", intent: "a fully masked block must not divide by zero" },
      { name: "tail", intent: "a length off the tile boundary must not read past M" },
    ],
  }],
  rtol: 1e-2,
  atol: 1e-3,
  force: true,
});
say("5. kernel_contract with no milestone at all", noMilestone.split("\nfreeze_criteria payload:")[0].split("warnings:")[1] ?? "(no warnings)");
