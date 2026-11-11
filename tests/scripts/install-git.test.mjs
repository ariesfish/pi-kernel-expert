import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const installer = fileURLToPath(new URL("../../scripts/install-git.sh", import.meta.url));

function environment(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi kernel installer "));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  const calls = path.join(root, "calls.jsonl");
  fs.writeFileSync(path.join(bin, "pi"), `#!${process.execPath}
const fs = require("node:fs");
const { pathToFileURL } = require("node:url");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.INSTALL_TEST_CALLS, JSON.stringify(args) + "\\n");
if (args[0] === "install") {
  process.exit(args[1].endsWith("/pi-goal") ? Number(process.env.INSTALL_TEST_GOAL_EXIT || 0) : Number(process.env.INSTALL_TEST_KERNEL_EXIT || 0));
}
const tools = [
  "validate_goal", "init_goal", "start_goal", "frame_goal", "probe_goal", "freeze_criteria", "check_goal", "review_goal", "run_goal", "log_goal",
  "kernel_bootstrap", "kernel_wiki", "kernel_wiki_candidate", "kernel_init", "kernel_contract", "kernel_profile", "kernel_candidate", "kernel_milestone", "kernel_sass", "kernel_kb",
].filter((name) => name !== process.env.INSTALL_TEST_MISSING_TOOL);
const commands = new Map();
const pi = {
  getAllTools: () => tools.map((name) => ({ name })),
  registerCommand: (name, command) => commands.set(name, command),
};
(async () => {
  const probe = args[args.indexOf("-e") + 1];
  const extension = await import(pathToFileURL(probe));
  extension.default(pi);
  const prompt = args[args.indexOf("-p") + 1];
  await commands.get(prompt.slice(1)).handler("", {});
})().catch((error) => { console.error(error.message); process.exitCode = process.env.INSTALL_TEST_SWALLOW_ERROR ? 0 : 1; });
`);
  fs.chmodSync(path.join(bin, "pi"), 0o755);
  const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, INSTALL_TEST_CALLS: calls, ...overrides };
  return {
    run: (args = []) => spawnSync("bash", [installer, ...args], { cwd: root, env, encoding: "utf8", timeout: 10000 }),
    calls: () => fs.existsSync(calls) ? fs.readFileSync(calls, "utf8").trim().split("\n").map(JSON.parse) : [],
  };
}

test("the Git installer installs the peer first and checks both packages through pi", (t) => {
  const fixture = environment(t);
  const result = fixture.run();
  assert.equal(result.status, 0, result.stderr);
  const calls = fixture.calls();
  assert.deepEqual(calls.slice(0, 2), [
    ["install", "git:github.com/ariesfish/pi-goal"],
    ["install", "git:github.com/ariesfish/pi-kernel-expert"],
  ]);
  assert.equal(calls.length, 3);
  assert.ok(calls[2].includes("--no-session"));
  assert.ok(calls[2].includes("-e"));
  assert.ok(calls[2].includes("-p"));
  assert.match(result.stdout, /PI_KERNEL_STACK_READY/);
  assert.match(result.stdout, /\/reload/);
});

for (const [variable, expectedCalls] of [
  ["INSTALL_TEST_GOAL_EXIT", [["install", "git:github.com/ariesfish/pi-goal"]]],
  ["INSTALL_TEST_KERNEL_EXIT", [
    ["install", "git:github.com/ariesfish/pi-goal"],
    ["install", "git:github.com/ariesfish/pi-kernel-expert"],
  ]],
]) {
  test(`an installation failure stops before any later step: ${variable}`, (t) => {
    const fixture = environment(t, { [variable]: "23" });
    const result = fixture.run();
    assert.equal(result.status, 23);
    assert.deepEqual(fixture.calls(), expectedCalls);
    assert.doesNotMatch(result.stdout, /PI_KERNEL_STACK_READY|Git installation verified/);
  });
}

for (const name of ["run_goal", "kernel_contract"]) {
  test(`a successful install is refused when required tool ${name} does not load`, (t) => {
    const fixture = environment(t, { INSTALL_TEST_MISSING_TOOL: name });
    const result = fixture.run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, new RegExp(`Required tools did not load: ${name}`));
    assert.doesNotMatch(result.stdout, /Git installation verified/);
  });
}

test("pi exiting zero without a successful registry check is not reported as ready", (t) => {
  const fixture = environment(t, { INSTALL_TEST_MISSING_TOOL: "run_goal", INSTALL_TEST_SWALLOW_ERROR: "1" });
  const result = fixture.run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /required tools were not confirmed/);
  assert.doesNotMatch(result.stdout, /Git installation verified/);
});
