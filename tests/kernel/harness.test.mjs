import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { normalizeContract, uncoveredHarnessWarnings } from "../../extensions/pi-kernel-expert/kernel/contract.ts";
import { harnessGlobMatches, harnessTouched } from "../../extensions/pi-kernel-expert/kernel/refusals.ts";

const CASES = [
  ["exact path", "eval/bench.py", "eval/bench.py", true],
  ["leading ./ in glob", "./eval/bench.py", "eval/bench.py", true],
  ["single star", "eval/*.py", "eval/bench.py", true],
  ["single star stops at directory", "eval/*.py", "eval/nested/bench.py", false],
  ["recursive star", "eval/**", "eval/nested/bench.py", true],
  ["recursive star includes root files", "**/*.py", "bench.py", true],
  ["recursive star includes nested files", "eval/**/*.py", "eval/nested/deep/bench.py", true],
  ["optional directory", "eval/**/*.py", "eval/bench.py", true],
  ["question mark", "eval/bench?.py", "eval/bench1.py", true],
  ["question mark matches one character", "eval/bench?.py", "eval/bench12.py", false],
  ["question mark stops at directory", "eval/bench?.py", "eval/bench/.py", false],
  ["directory name stays literal", "eval/*", "evalX/bench.py", false],
  ["regex punctuation stays literal", "eval/bench+[1].py", "eval/bench+[1].py", true],
  ["regex punctuation is escaped", "eval/bench+[1].py", "eval/bench1.py", false],
  ["extension dot stays literal", "eval/bench.py", "eval/benchXpy", false],
];

for (const [name, glob, file, covered] of CASES) {
  test(`harness warnings and refusals agree: ${name}`, (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kernel-harness-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const absolute = path.join(root, file);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, "# harness fixture\n");
    const normalized = normalizeContract({
      objective: "protect the measurement harness",
      checkCommand: `python './${file}'`,
      benchmarkCommand: `python './${file}'`,
      cells: [{ id: "edge", dtype: "bf16", boundary: true }],
      tolerance: { rtol: 0.01, atol: 0.001 },
      harnessGlobs: [glob],
    });
    assert.deepEqual(normalized.errors, []);
    const contract = normalized.contract;
    assert.ok(contract);

    const warnings = uncoveredHarnessWarnings(contract, root);
    assert.equal(warnings.length, covered ? 0 : 1, "an uncovered harness is warned once across both commands");
    if (!covered) assert.ok(warnings[0].startsWith(`${file} (called by benchmarkCommand)`));
    assert.equal(harnessGlobMatches(glob, file), covered);
    assert.equal(harnessGlobMatches(glob, `./${file}`), covered);

    for (const changedFile of [file, `./${file}`]) {
      const refusal = harnessTouched({ contract, changedFiles: [changedFile] });
      assert.equal(refusal !== null, covered, "only a protected harness path blocks a candidate");
      if (covered) {
        assert.equal(refusal.rule, "harness-touched");
        assert.ok(refusal.message.includes(changedFile));
      }
    }
  });
}

test("harness path prefixes are normalized once at each input reader", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kernel-harness-prefix-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "eval"));
  fs.writeFileSync(path.join(root, "eval/bench.py"), "# harness fixture\n");
  const { contract, errors } = normalizeContract({
    objective: "preserve path prefix handling",
    checkCommand: "python ././eval/bench.py",
    benchmarkCommand: "python ././eval/bench.py",
    cells: [{ id: "edge", dtype: "bf16", boundary: true }],
    tolerance: { rtol: 0.01, atol: 0.001 },
    harnessGlobs: ["eval/**"],
  });
  assert.deepEqual(errors, []);
  const warnings = uncoveredHarnessWarnings(contract, root);
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0].startsWith("./eval/bench.py (called by benchmarkCommand)"));
  assert.equal(harnessGlobMatches("eval/**", "./eval/bench.py"), true);
  assert.equal(harnessGlobMatches("eval/**", "././eval/bench.py"), false);
});
