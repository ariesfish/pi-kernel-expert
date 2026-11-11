import assert from "node:assert/strict";
import test from "node:test";

import { freezePayload, normalizeContract } from "../../extensions/pi-kernel-expert/kernel/contract.ts";

// pi-goal's freeze_criteria accepts timeout_seconds and converts it to the
// internal timeoutSeconds field. Sending the internal spelling silently loses
// the task's requested timeout when the receiver builds its frozen contract.
test("the freeze payload preserves the correctness timeout through pi-goal's tool input", () => {
  const { contract, errors } = normalizeContract({
    objective: "verify the correctness timeout",
    checkCommand: "bash check.sh",
    benchmarkCommand: "bash bench.sh",
    cells: [{ id: "edge", dtype: "fp32", boundary: true }],
    tolerance: { rtol: 0, atol: 1e-6 },
    checksTimeoutSeconds: 17,
  });
  assert.deepEqual(errors, []);
  const payload = JSON.parse(JSON.stringify(freezePayload(contract)));
  const check = payload.criteria.find((criterion) => criterion.id === "C1").check;
  assert.equal(check.timeout_seconds, 17);
  assert.equal(check.timeoutSeconds, undefined, "the internal spelling is not a tool argument");
});
