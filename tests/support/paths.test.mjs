import assert from "node:assert/strict";
import * as path from "node:path";
import test from "node:test";

import {
  KERNEL_WIKI_PIN,
  agentLayout,
  packageRootFrom,
  skillDir,
} from "../../extensions/pi-kernel-expert/support/paths.ts";

test("agent layout defaults to the pi agent directory", () => {
  const layout = agentLayout({}, "/home/tester");
  assert.equal(layout.agentDir, path.join("/home/tester", ".pi", "agent"));
  assert.equal(layout.settingsPath, path.join(layout.agentDir, "settings.json"));
  assert.equal(layout.cacheDir, path.join(layout.agentDir, "kernel-expert", "cache"));
});

test("PI_CODING_AGENT_DIR overrides the agent directory", () => {
  const layout = agentLayout({ PI_CODING_AGENT_DIR: "/srv/pi-agent" }, "/home/tester");
  assert.equal(layout.agentDir, "/srv/pi-agent");
});

test("KernelWiki cache path carries the pinned revision", () => {
  const layout = agentLayout({ PI_CODING_AGENT_DIR: "/srv/pi-agent" }, "/home/tester");
  assert.equal(layout.kernelWikiDir, path.join(layout.cacheDir, `KernelWiki@${KERNEL_WIKI_PIN}`));
  assert.equal(KERNEL_WIKI_PIN, "76d27b56f804e7e7295d4c570e1e5d7eef4b0a75");
});

test("package root resolves three levels up from a support module", () => {
  const root = packageRootFrom("file:///opt/pi-kernel-expert/extensions/pi-kernel-expert/support/paths.ts");
  assert.equal(root, path.resolve("/opt/pi-kernel-expert"));
  assert.equal(skillDir(root, "ncu-report-skill"), path.join("/opt/pi-kernel-expert", "skills", "ncu-report-skill"));
});
