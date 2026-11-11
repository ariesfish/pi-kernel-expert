// Regression over the installed peer's real input conversion; synthetic test
// consent is limited to this disposable unit-test workspace (no GPU commands).
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { freezePayload, normalizeContract } from "../../extensions/pi-kernel-expert/kernel/contract.ts";
import { goalRoot } from "./runtime.mjs";

const { executeFreezeCriteria } = await import(path.join(goalRoot, "extensions/pi-goal/workflows/goal-contract-workflow.ts"));
const { createRuntimeStore } = await import(path.join(goalRoot, "extensions/pi-goal/support/runtime.ts"));
const { enterResearchNeedsInitFromFiles } = await import(path.join(goalRoot, "extensions/pi-goal/protocol/research-phase.ts"));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kernel-timeout-regression-"));
try {
  const runtime = createRuntimeStore().ensure("timeout-regression");
  enterResearchNeedsInitFromFiles(runtime.loop);
  const { contract, errors } = normalizeContract({
    objective: "synthetic timeout conversion regression",
    checkCommand: "true", benchmarkCommand: "printf '1\\n'",
    cells: [{ id: "edge", dtype: "fp32", boundary: true }],
    tolerance: { rtol: 0, atol: 1e-6 }, checksTimeoutSeconds: 17,
  });
  assert.deepEqual(errors, []);
  const result = await executeFreezeCriteria(freezePayload(contract), {
    runtime, workDir: root, confirm: async () => true,
  });
  assert.equal(result.ok, true, result.text);
  assert.equal(result.state.contract.criteria.find((criterion) => criterion.id === "C1").check.timeoutSeconds, 17);
  console.log("Installed pi-goal retains the requested 17-second timeout from the generated tool payload.");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
