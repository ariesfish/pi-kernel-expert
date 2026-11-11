import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager,
} from "@earendil-works/pi-coding-agent";

export const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const goalRoot = path.join(os.homedir(), ".pi/agent/git/github.com/ariesfish/pi-goal");
export const digest = (value) => createHash("sha256").update(value).digest("hex");
export const textOf = (result) => result.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");

// Uses real file-based extension loading and the runtime's nested tool pipeline.
// The recorded assistant message supplies the scripted caller, without an LLM.
export async function withRuntime(cwd, handler, approvedContractSha = null) {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kernel-runtime-"));
  const settingsManager = SettingsManager.inMemory({ packages: [], extensions: [], compaction: { enabled: false } });
  const sessionManager = SessionManager.inMemory(cwd);
  sessionManager.appendMessage({
    role: "assistant", content: [{ type: "toolCall", id: "integration", name: "integration_driver", arguments: {} }],
    api: "openai-completions", provider: "scripted-verification", model: "no-model-request",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "toolUse", timestamp: Date.now(),
  });
  const events = [];
  let sequence = fs.existsSync(path.join(cwd, "runs/runtime"))
    ? Math.max(0, ...fs.readdirSync(path.join(cwd, "runs/runtime")).map((file) => Number.parseInt(file, 10) || 0))
    : 0;
  const loader = new DefaultResourceLoader({
    cwd, agentDir, settingsManager, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    additionalExtensionPaths: [path.join(goalRoot, "extensions/pi-goal/index.ts"), path.join(repo, "extensions/pi-kernel-expert/index.ts")],
    extensionFactories: [(pi) => {
      pi.on("tool_call", (event) => { events.push({ name: event.toolName, id: event.toolCallId, parent: event.parentToolCallId }); });
      pi.registerTool({
        name: "integration_driver", label: "Integration driver", description: "Scripted integration verification",
        parameters: { type: "object", properties: {}, additionalProperties: false },
        async execute(_id, _params, signal, _update, ctx) {
          const call = async (name, params, { allowRefusal = false } = {}) => {
            const outcome = await ctx.executeTool(name, params, { signal });
            const result = outcome.result ? { ...outcome.result, isError: outcome.isError } : outcome;
            const text = textOf(result);
            const index = String(++sequence).padStart(2, "0");
            fs.mkdirSync(path.join(cwd, "runs/runtime"), { recursive: true });
            fs.writeFileSync(path.join(cwd, "runs/runtime", `${index}-${name}.json`), `${JSON.stringify({ name, params, result }, null, 2)}\n`);
            console.log(`${name}: ${text.split("\n").slice(0, 3).join(" | ")}`);
            assert.equal(result.isError ?? false, false, text);
            if (!allowRefusal) assert.ok(!text.startsWith("❌"), text);
            return result;
          };
          await handler({ call, ctx, events });
          return { content: [{ type: "text", text: "integration phase completed" }], details: {} };
        },
      });
    }],
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const { session } = await createAgentSession({ cwd, agentDir, settingsManager, sessionManager, resourceLoader: loader, tools: ["+bash", "+read"] });
  const extensionErrors = [];
  try {
    const ui = { ...session.extensionRunner.createContext().ui,
      confirm: async (title, message) => {
        fs.writeFileSync(path.join(cwd, "runs/freeze-confirmation.txt"), `${title}\n${message}\n`);
        const actual = digest(fs.readFileSync(path.join(cwd, "kernel-freeze.json")));
        assert.ok(approvedContractSha && actual === approvedContractSha, "Human approval for this exact contract is required");
        return true;
      },
    };
    await session.bindExtensions({ mode: approvedContractSha ? "rpc" : "print", uiContext: approvedContractSha ? ui : undefined, onError: (event) => extensionErrors.push(event) });
    const names = session.getAllTools().map((tool) => tool.name);
    console.log(`Registered runtime tools: ${names.join(", ")}`);
    console.log(`Loaded extension tools: ${loader.getExtensions().extensions.map((extension) => `${extension.path}: ${[...extension.tools.keys()].join(", ")}`).join("; ")}`);
    for (const name of ["kernel_init", "kernel_contract", "kernel_candidate", "frame_goal", "probe_goal", "freeze_criteria", "run_goal", "log_goal"]) assert.ok(names.includes(name), name);
    const driver = session.agent.state.tools.find((tool) => tool.name === "integration_driver");
    assert.ok(driver);
    await driver.execute("integration", {}, new AbortController().signal);
    assert.deepEqual(extensionErrors, []);
    assert.ok(events.length > 0);
    fs.writeFileSync(path.join(cwd, "runs/runtime-events.json"), `${JSON.stringify(events, null, 2)}\n`);
  } finally {
    session.dispose();
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
}
