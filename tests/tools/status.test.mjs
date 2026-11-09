import assert from "node:assert/strict";
import test from "node:test";

import kernelExpertExtension from "../../extensions/pi-kernel-expert/index.ts";
import { fakeCommandContext, fakePi } from "../helpers/fake-host.mjs";

test("extension registers the command, the tools, and the discovery handler", () => {
  const pi = fakePi();
  kernelExpertExtension(pi);
  assert.deepEqual([...pi.commands.keys()], ["kernel-expert"]);
  assert.deepEqual([...pi.tools.keys()].sort(), [
    "kernel_bootstrap",
    "kernel_candidate",
    "kernel_contract",
    "kernel_init",
    "kernel_milestone",
    "kernel_profile",
    "kernel_wiki",
  ]);
  assert.equal(pi.handlers.get("resources_discover")?.length, 1);
});

test("kernel-expert command reports the three knowledge facts", async () => {
  const pi = fakePi();
  kernelExpertExtension(pi);
  const command = pi.commands.get("kernel-expert");
  assert.ok(command);

  const { ctx, notifications } = fakeCommandContext();
  await command.handler("", ctx);

  assert.equal(notifications.length, 1);
  const message = notifications[0].message;
  assert.match(message, /pi-kernel-expert/);
  assert.match(message, /loop engine/);
  assert.match(message, /ncu skill/);
  assert.match(message, /kernel-wiki/);
});
