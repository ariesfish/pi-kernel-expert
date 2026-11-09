import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import {
  formatKnowledgeReport,
  inspectKnowledge,
  inspectLoopEngine,
  readPackageVersion,
  readVendoredRevision,
} from "../../extensions/pi-kernel-expert/support/knowledge.ts";
import { KERNEL_WIKI_PIN, agentLayout, packageRootFrom, skillDir } from "../../extensions/pi-kernel-expert/support/paths.ts";

const PACKAGE_ROOT = packageRootFrom(new URL("../../extensions/pi-kernel-expert/support/knowledge.ts", import.meta.url).href);

function tempAgentDir(settings) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kernel-expert-test-"));
  if (settings !== undefined) {
    fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify(settings));
  }
  return dir;
}

test("loop engine is detected from a string package entry", () => {
  const agentDir = tempAgentDir({ packages: ["npm:@ariesfish/pi-goal@0.5.3"] });
  assert.equal(inspectLoopEngine(path.join(agentDir, "settings.json")).state, "installed");
});

test("loop engine is detected from a source object entry", () => {
  const agentDir = tempAgentDir({ packages: [{ source: "npm:@ariesfish/pi-goal" }] });
  assert.equal(inspectLoopEngine(path.join(agentDir, "settings.json")).state, "installed");
});

test("an installed package that is not pi-goal reports missing", () => {
  const agentDir = tempAgentDir({ packages: ["npm:other-plugin"] });
  assert.equal(inspectLoopEngine(path.join(agentDir, "settings.json")).state, "missing");
});

test("no settings file is unknown, not missing", () => {
  const agentDir = tempAgentDir(undefined);
  assert.equal(inspectLoopEngine(path.join(agentDir, "settings.json")).state, "unknown");
});

test("malformed settings are unknown", () => {
  const agentDir = tempAgentDir(undefined);
  fs.writeFileSync(path.join(agentDir, "settings.json"), "{not json");
  assert.equal(inspectLoopEngine(path.join(agentDir, "settings.json")).state, "unknown");
});

test("vendored revision comes from VENDORED.yaml", () => {
  const revision = readVendoredRevision(skillDir(PACKAGE_ROOT, "ncu-report-skill"));
  assert.match(revision ?? "", /^[0-9a-f]{40}$/);
  assert.equal(revision, "c7980a43cb88a8734d113b22b57ff66746cf5719");
});

test("missing VENDORED.yaml yields null revision", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kernel-expert-novendor-"));
  assert.equal(readVendoredRevision(dir), null);
});

test("package version matches package.json", () => {
  const version = readPackageVersion(PACKAGE_ROOT);
  assert.match(version, /^\d+\.\d+\.\d+$/);
});

test("report states the vendored skill and the missing corpus", () => {
  const agentDir = tempAgentDir({ packages: ["npm:@ariesfish/pi-goal"] });
  const report = inspectKnowledge({ packageRoot: PACKAGE_ROOT, layout: agentLayout({ PI_CODING_AGENT_DIR: agentDir }, "/nonexistent") });
  assert.equal(report.ncu.present, true);
  assert.equal(report.kernelWiki.present, false);
  assert.equal(report.loopEngine.state, "installed");

  const text = formatKnowledgeReport(report);
  assert.match(text, /pi-kernel-expert \d+\.\d+\.\d+/);
  assert.match(text, /ncu skill {5}vendored @c7980a43cb88/);
  assert.match(text, new RegExp(`kernel-wiki\\s+not cached — pin ${KERNEL_WIKI_PIN.slice(0, 12)}, run kernel_bootstrap`));
  assert.match(text, /loop engine {3}pi-goal installed/);
});
