import assert from "node:assert/strict";
import test from "node:test";

import { compile } from "@earendil-works/pi-schema";

import kernelExpertExtension from "../../extensions/pi-kernel-expert/index.ts";
import { fakePi } from "../helpers/fake-host.mjs";

function registeredTools() {
  const pi = fakePi();
  kernelExpertExtension(pi);
  return pi.tools;
}

test("every tool parameter schema is plain, compilable JSON Schema", () => {
  const tools = registeredTools();
  assert.ok(tools.size >= 10, `expected the registered tool set, got ${tools.size}`);

  for (const [name, tool] of tools) {
    assert.equal(tool.parameters.type, "object", `${name}: root is an object`);
    assert.equal("~kind" in tool.parameters, false, `${name}: no TypeBox kind marker`);
    assert.equal("~unsafe" in tool.parameters, false, `${name}: no TypeBox unsafe marker`);

    const validator = compile(tool.parameters);
    assert.equal(typeof validator.check, "function", `${name}: compiles`);
  }
});

test("a tool schema rejects an undeclared argument field", () => {
  const wiki = registeredTools().get("kernel_wiki");
  assert.ok(wiki);
  const validator = compile(wiki.parameters);
  assert.equal(validator.check({ query: "tcgen05", unexpected: true }), false);
  assert.deepEqual(validator.errors({ query: "tcgen05", unexpected: true }), [
    { path: "/unexpected", keyword: "additionalProperties", message: "unknown field" },
  ]);
});
