// Run from the repository root with:
// node --experimental-strip-types .dev/audit/contract-refactor/verify-equivalence.mjs
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

import * as current from "../../../extensions/pi-kernel-expert/kernel/contract.ts";

const root = process.cwd();
const relative = "extensions/pi-kernel-expert/kernel/contract.ts";
const baselineText = execFileSync("git", ["show", `e770065:${relative}`], { encoding: "utf8" });
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kernel-contract-equivalence-"));
try {
  const baselineFile = path.join(temporary, "contract.ts");
  const layoutUrl = pathToFileURL(path.join(root, "extensions/pi-kernel-expert/workspace/layout.ts")).href;
  fs.writeFileSync(baselineFile, baselineText.replace('"../workspace/layout.ts"', JSON.stringify(layoutUrl)));
  const baseline = await import(pathToFileURL(baselineFile).href);
  assert.deepEqual(Object.keys(current).filter((key) => key !== "readContract").sort(), Object.keys(baseline).sort());

  const fixtures = JSON.parse(fs.readFileSync("tests/fixtures/contract/artifacts.json", "utf8"));
  let comparisons = 0;
  for (const fixture of fixtures) {
    for (const direction of ["lower", "higher"]) {
      for (const basis of ["device", "e2e"]) {
        for (const repeats of [1, 5, 50]) {
          const input = { ...fixture.input, direction, basis, repeats };
          const before = baseline.normalizeContract(input);
          const after = current.normalizeContract(input);
          assert.deepEqual(after, before);
          const sha = baseline.contractSha(baseline.contractJson(before.contract));
          for (const render of ["contractJson", "freezePayload", "renderBenchmarkScript", "renderChecksScript"]) {
            assert.deepEqual(current[render](after.contract, sha), baseline[render](before.contract, sha), render);
          }
          comparisons += 1;
        }
      }
    }
  }

  const invalid = [
    { objective: "" }, { checkCommand: "" }, { benchmarkCommand: "" },
    { metricName: "bad-name" }, { direction: "invalid" }, { basis: "invalid" },
    { repeats: 0 }, { repeats: 51 }, { warmup: -1 }, { warmup: 21 },
    { guardPct: -1 }, { noiseFloorPct: 51 }, { checksTimeoutSeconds: 0 },
    { tolerance: { rtol: -1, atol: 0 } }, { cells: [] },
    { cells: [{ id: "bad id", dtype: "" }] }, { harnessGlobs: [] },
    { burnInMs: -1 }, { clockLock: { sm: 99 } },
    { referenceCommand: fixtures[0].input.benchmarkCommand },
  ];
  for (const override of invalid) {
    const input = { ...fixtures[0].input, ...override };
    assert.deepEqual(current.normalizeContract(input), baseline.normalizeContract(input));
  }

  const harnessRoot = path.join(temporary, "harness");
  fs.mkdirSync(path.join(harnessRoot, "eval"), { recursive: true });
  fs.writeFileSync(path.join(harnessRoot, "eval/bench.py"), "# fixture\n");
  let harnessComparisons = 0;
  for (const glob of ["eval/**", "./eval/**", "././eval/**", "**/*.py", "eval/*.py", "eval/bench?.py", "eval/bench.py"]) {
    for (const prefix of ["", "./", "././"]) {
      const input = {
        ...fixtures[0].input,
        benchmarkCommand: `python ${prefix}eval/bench.py`,
        checkCommand: `python '${prefix}eval/bench.py'`,
        harnessGlobs: [glob],
      };
      const contract = current.normalizeContract(input).contract;
      assert.deepEqual(
        current.uncoveredHarnessWarnings(contract, harnessRoot),
        baseline.uncoveredHarnessWarnings(contract, harnessRoot),
      );
      harnessComparisons += 1;
    }
  }

  // Type-only exports do not exist at runtime. Check their declarations too.
  const oldFile = ts.createSourceFile(relative, baselineText, ts.ScriptTarget.Latest, true);
  const originalTypes = oldFile.statements.filter((node) =>
    (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) &&
    node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword));
  const implementations = ["contract-model.ts", "contract-files.ts", "contract-scripts.ts"].map((file) =>
    ts.createSourceFile(file, fs.readFileSync(path.join(root, "extensions/pi-kernel-expert/kernel", file), "utf8"), ts.ScriptTarget.Latest, true));
  for (const declaration of originalTypes) {
    const moved = implementations.flatMap((file) => [...file.statements]).find((node) =>
      (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) && node.name.text === declaration.name.text);
    assert.ok(moved, `missing type ${declaration.name.text}`);
    assert.equal(moved.getText(), declaration.getText(), declaration.name.text);
  }

  console.log(JSON.stringify({
    baseline: "e770065",
    validContractComparisons: comparisons,
    invalidContractComparisons: invalid.length,
    harnessWarningComparisons: harnessComparisons,
    preservedTypeDeclarations: originalTypes.length,
    runtimeExportsPreserved: true,
    generatedArtifactsEqual: true,
  }, null, 2));
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
