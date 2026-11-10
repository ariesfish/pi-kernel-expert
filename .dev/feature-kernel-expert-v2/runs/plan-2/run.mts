/**
 * T-011 evidence: the M0 freeze on a real milestone file, through the real tool.
 * Run from this directory: node --experimental-strip-types run.mts
 */
import * as fs from "node:fs";
import * as path from "node:path";

import kernelExpertExtension from "../../../../extensions/pi-kernel-expert/index.ts";
import { fakeCommandContext, fakePi } from "../../../../tests/helpers/fake-host.mjs";

const root = path.resolve(".work");
fs.rmSync(root, { recursive: true, force: true });
fs.mkdirSync(root, { recursive: true });
fs.mkdirSync(path.join(root, "docs"));
fs.copyFileSync("milestone.md", path.join(root, "docs", "milestone.md"));
const file = path.join(root, "docs", "milestone.md");

const pi = fakePi();
kernelExpertExtension(pi);
const tool = pi.tools.get("kernel_milestone");
const { ctx } = fakeCommandContext({ cwd: root });
const run = async (params: Record<string, unknown>) => {
  const result = await tool.execute("call", params, undefined, undefined, ctx);
  return result.content[0].text;
};

const say = (heading: string, body: string): void => {
  console.log(`\n${"=".repeat(72)}\n${heading}\n${"=".repeat(72)}\n${body}`);
};

say("1. validate the milestone as written", await run({}));
say("2. lock: freeze the ### M0 Contract block", await run({ lock: true }));
say("3. the lock file", fs.readFileSync(path.join(root, ".kernel", "milestone.lock.json"), "utf8").split("\n").slice(0, 6).join("\n") + " …");

// The thaw: two items edited, one added, one removed.
const before = fs.readFileSync(file, "utf8");
const after = before
  .replace("- register budget: 32 (the kernel is 11 instructions)", "- register budget: 40 (room for a pair of in-flight loads)")
  .replace("- tile: 1024 elements per block, 256 threads, 4 per thread\n", "- tile: 2048 elements per block, 256 threads, 8 per thread\n- vector width: 4 x fp32\n");
fs.writeFileSync(file, after);
fs.writeFileSync("thaw.diff", "");
fs.writeFileSync("/tmp/thaw-before.md", before);
fs.writeFileSync("/tmp/thaw-after.md", after);

say("4. the same file, three M0 items changed, validated", await run({}));
say("5. re-locking is not a way to absorb the edit", await run({ lock: true }));
say("6. unlock without a reason", await run({ unlock: true }));
say("7. unlock with a reason", await run({ unlock: true, reason: "the register budget was measured on an sm80 card at 256 threads; sm90 at 512 threads needs 40" }));
say("8. validated after the thaw", await run({}));
say("9. what the unlock left in ## 4. Dead Ends", fs.readFileSync(file, "utf8").split("## 4. Dead Ends")[1].split("## 5.")[0].trim());
say("10. re-lock the block as it now stands", await run({ lock: true }));
console.log(`\nworkspace: ${root}`);
