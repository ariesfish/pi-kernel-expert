import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";

import kernelExpertExtension from "../../extensions/pi-kernel-expert/index.ts";
import { fakePi } from "../helpers/fake-host.mjs";

const ROOT = path.resolve(new URL("../..", import.meta.url).pathname);
const SKILL_DIR = path.join(ROOT, "skills", "kernel-flow");
const SKILL = fs.readFileSync(path.join(SKILL_DIR, "SKILL.md"), "utf8");

/** Tools this package registers plus pi-goal's tools the skill is allowed to name. */
const PI_GOAL_TOOLS = [
  "init_goal",
  "frame_goal",
  "probe_goal",
  "freeze_criteria",
  "start_goal",
  "run_goal",
  "check_goal",
  "log_goal",
  "validate_goal",
  "review_goal",
];

function registeredTools() {
  const pi = fakePi();
  kernelExpertExtension(pi);
  return new Set([...pi.tools.keys(), ...PI_GOAL_TOOLS]);
}

test("every tool the skill names exists", () => {
  const known = registeredTools();
  const named = new Set(
    SKILL.match(/\b(kernel_[a-z_]+|init_goal|frame_goal|probe_goal|freeze_criteria|start_goal|run_goal|check_goal|log_goal|validate_goal|review_goal)\b/g),
  );
  assert.ok(named.size >= 5, `expected the skill to name several tools, found ${[...named].join(", ")}`);
  const unknown = [...named].filter((name) => !known.has(name));
  assert.deepEqual(unknown, [], `skill names tools that do not exist: ${unknown.join(", ")}`);
});

test("the skill names the vendored profiling skill and the KernelWiki tool", () => {
  assert.match(SKILL, /`ncu-report-skill`/);
  assert.match(SKILL, /`kernel_wiki`/);
  assert.match(SKILL, /`kernel_profile`/);
  assert.match(SKILL, /`kernel_candidate`/);
  assert.match(SKILL, /`kernel_milestone`/);
  assert.match(SKILL, /`kernel-diagnose`/);
  assert.match(SKILL, /milestone_decision/);
  assert.match(SKILL, /m0-thawed/);
  assert.match(SKILL, /gate-cites-knowledge/);
});

test("the description carries both language triggers and the exclusions", () => {
  const raw = /description:\s*>-\n([\s\S]*?)\n---/.exec(SKILL)?.[1] ?? "";
  const description = raw.replace(/\s+/g, " ");
  assert.ok(description.length > 100);
  assert.match(description, /CUDA kernel/i);
  assert.match(description, /Nsight Compute/i);
  assert.match(description, /优化 CUDA kernel/);
  assert.match(description, /瓶颈定位/);
  assert.match(description, /Not for generic CUDA/i);
  assert.match(description, /host-side/i);
  assert.match(description, /distributed or multi-GPU/i);
  assert.match(description, /non-kernel optimization/i);
});

test("the artifact table and failure table stay concrete", () => {
  for (const artifact of [
    "docs/draft.md",
    "docs/plan.md",
    "kernel.contract.json",
    "goal.sh",
    "goal.checks.sh",
    ".kernel/baseline.tsv",
    "profile/<run>/summary.json",
    "candidates.jsonl",
    "goal.jsonl",
  ]) {
    assert.ok(SKILL.includes(artifact), `artifact table is missing ${artifact}`);
  }
  for (const failure of ["pass 1", "pass 2", "checks_failed", "stale"]) {
    assert.ok(SKILL.toLowerCase().includes(failure.toLowerCase()), `failure table is missing ${failure}`);
  }
  assert.doesNotMatch(SKILL, /proofile/);
});

test("the benchmark checklist ships with the skill and answers all seven questions", () => {
  const checklist = fs.readFileSync(path.join(SKILL_DIR, "references", "benchmark-checklist.md"), "utf8");
  for (const n of [1, 2, 3, 4, 5, 6, 7]) {
    assert.match(checklist, new RegExp(`\\n${n}\\. \\*\\*`), `checklist is missing question ${n}`);
  }
  assert.match(checklist, /limiter/i);
  assert.match(checklist, /reproduce/i);
  assert.match(checklist, /clock/i);
});
