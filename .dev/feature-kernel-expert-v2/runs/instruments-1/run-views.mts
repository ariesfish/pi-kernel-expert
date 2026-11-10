/**
 * T-027: the six SASS reads on real dumps from h200-7, and the KB citation that
 * follows from them.
 * Run from this directory: node --experimental-strip-types run-views.mts
 */
import { execFileSync } from "node:child_process";
import * as path from "node:path";

import kernelExpertExtension from "../../../../extensions/pi-kernel-expert/index.ts";
import { fakeCommandContext, fakePi } from "../../../../tests/helpers/fake-host.mjs";

const ROOT = path.resolve(".");
const pi = fakePi({ exec: execFileSync as never });
kernelExpertExtension(pi);
const { ctx } = fakeCommandContext({ cwd: ROOT });
const call = async (name: string, params: Record<string, unknown>) => {
  const result = await pi.tools.get(name).execute("call", params, undefined, undefined, ctx);
  return result.content[0].text;
};

const say = (heading: string, body: string): void => {
  console.log(`\n${"=".repeat(72)}\n${heading}\n${"=".repeat(72)}\n${body.trim()}`);
};

const DUMP = "bench.sass";
const KERNEL = "saxpy_coalesced";

for (const view of ["census", "operands", "serial", "schedule", "live", "struct", "launch"]) {
  const params: Record<string, unknown> = { view, dump: DUMP, kernel: KERNEL };
  if (view === "launch") params.metrics = "details.csv";
  say(`${view} — ${DUMP}`, await call("kernel_sass", params));
}

say("the same reading for the transposed kernel, for contrast", await call("kernel_sass", { view: "census", dump: DUMP, kernel: "saxpy_strided" }));

say("lint, before the entry exists", await call("kernel_kb", { action: "lint" }));
