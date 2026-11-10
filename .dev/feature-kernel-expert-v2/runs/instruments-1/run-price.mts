/**
 * T-026: a KB price on a gate line, accepted for a measured entry and refused for
 * the same entry downgraded to UNVERIFIED — the refusal quoting the citation tool.
 * Run from this directory: node --experimental-strip-types run-price.mts
 */
import * as fs from "node:fs";
import * as path from "node:path";

import kernelExpertExtension from "../../../../extensions/pi-kernel-expert/index.ts";
import { fakeCommandContext, fakePi } from "../../../../tests/helpers/fake-host.mjs";

const ROOT = path.resolve(".");
const ENTRY = "kb/sm90/identical-census-different-addressing.md";
const pi = fakePi();
kernelExpertExtension(pi);
const { ctx } = fakeCommandContext({ cwd: ROOT });
const call = async (name: string, params: Record<string, unknown>) => {
  const result = await pi.tools.get(name).execute("call", params, undefined, undefined, ctx);
  return result.content[0].text;
};
const say = (heading: string, body: string): void => {
  console.log(`\n${"=".repeat(72)}\n${heading}\n${"=".repeat(72)}\n${body.trim()}`);
};

say("1. the entry as measured: cite, then the gate line", await call("kernel_kb", { action: "cite", entry: "identical-census-different-addressing" }));
const clean = await call("kernel_milestone", {});
say("   the milestone", clean.split("\n").slice(0, 3).join("\n") + "\n" + clean.split("\n").find((line) => line.includes("M0 Gate:3") && line.includes("PRICED"))!);

const original = fs.readFileSync(ENTRY, "utf8");
fs.writeFileSync(ENTRY, original.replace("- Status: MEASURED NVIDIA H200 2026-11-09", "- Status: UNVERIFIED — one card, one kernel shape, no sm120 run"));
say("2. the same entry, downgraded to UNVERIFIED: cite", await call("kernel_kb", { action: "cite", entry: "identical-census-different-addressing" }));
say("3. and the gate line that priced itself with it", await call("kernel_milestone", {}));

fs.writeFileSync(ENTRY, original);
say("4. restored, the milestone validates again", (await call("kernel_milestone", {})).split("\n")[0]);
