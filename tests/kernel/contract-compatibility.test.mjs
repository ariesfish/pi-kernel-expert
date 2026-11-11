import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import {
  contractJson,
  contractSha,
  freezePayload,
  normalizeContract,
  readContract,
  renderBenchmarkScript,
  renderChecksScript,
  writeContractFiles,
} from "../../extensions/pi-kernel-expert/kernel/contract.ts";

import { readContract as legacyReadContract } from "../../extensions/pi-kernel-expert/kernel/candidates.ts";

// Captured from e770065 before splitting the contract implementation. These
// hashes protect generated artifacts, including quoting and embedded policy.
const fixtures = JSON.parse(
  fs.readFileSync(new URL("../fixtures/contract/artifacts.json", import.meta.url), "utf8"),
);

function digest(text) {
  return createHash("sha256").update(text).digest("hex");
}

// Normalize the corrected pi-goal tool field back to its original spelling only
// for these historical hashes. The receiver regression lives in freeze-compatibility.
function historicalFreezeJson(payload) {
  return `${JSON.stringify(payload, (key, value) => {
    if (key === "check" && value?.timeout_seconds !== undefined) {
      const { timeout_seconds, ...check } = value;
      return { ...check, timeoutSeconds: timeout_seconds };
    }
    return value;
  }, 2)}\n`;
}

for (const fixture of fixtures) {
  test(`contract artifacts remain compatible: ${fixture.name}`, (t) => {
    const result = normalizeContract(fixture.input);
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.warnings, []);
    assert.ok(result.contract);
    const json = contractJson(result.contract);
    const sha = contractSha(json);
    assert.deepEqual(
      {
        contract: sha,
        benchmark: digest(renderBenchmarkScript(result.contract, sha)),
        checks: digest(renderChecksScript(result.contract, sha)),
        freeze: digest(historicalFreezeJson(freezePayload(result.contract))),
      },
      fixture.hashes,
    );

    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kernel-contract-compatibility-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const written = writeContractFiles({ root, contract: result.contract });
    assert.equal(written.ok, true);
    for (const [name, file] of Object.entries({
      contract: "kernel.contract.json",
      benchmark: "goal.sh",
      checks: "goal.checks.sh",
      freeze: "kernel-freeze.json",
    })) {
      const text = fs.readFileSync(path.join(root, file), "utf8");
      const compatible = name === "freeze" ? historicalFreezeJson(JSON.parse(text)) : text;
      assert.equal(digest(compatible), fixture.hashes[name], file);
    }
    assert.deepEqual(readContract(root), { ok: true, contract: result.contract, sha });
  });
}

test("the candidate recorder retains the canonical contract reader export", () => {
  assert.equal(legacyReadContract, readContract);
});

test("the contract reader hashes file bytes, including whitespace", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kernel-contract-sha-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { contract } = normalizeContract(fixtures[0].input);
  const text = `  ${JSON.stringify(contract)}\n\n`;
  fs.writeFileSync(path.join(root, "kernel.contract.json"), text);
  assert.deepEqual(readContract(root), { ok: true, contract, sha: digest(text) });
  assert.notEqual(digest(text), contractSha(contractJson(contract)));
});
