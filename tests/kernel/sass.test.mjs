import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";

import {
  SERIAL_BANDS,
  cannotSee,
  census,
  launch,
  live,
  operands,
  parseSass,
  resolveKernel,
  schedule,
  serial,
  struct,
} from "../../extensions/pi-kernel-expert/kernel/sass.ts";

const FIXTURES = path.resolve(new URL("../fixtures/sass", import.meta.url).pathname);
const read = (name) => fs.readFileSync(path.join(FIXTURES, name), "utf8");
const dump = (name) => parseSass(read(name));
const kernel = (name, requested) => {
  const resolved = resolveKernel(dump(name).dump, requested);
  assert.equal(resolved.ok, true, resolved.ok ? "" : resolved.reason);
  return resolved.kernel;
};

test("the same cubin parses from both formats, and the census agrees", () => {
  const fromCuobjdump = kernel("saxpy-bench-sm90-cuobjdump.sass", "saxpy_coalesced");
  const fromNcu = kernel("saxpy-sm90-ncu-source.txt", "saxpy_coalesced");
  assert.equal(fromCuobjdump.instructions.length, 32);
  assert.equal(fromNcu.instructions.length, 32);
  assert.deepEqual(census(fromCuobjdump).families, census(fromNcu).families);
  // Offsets count from the kernel's first instruction in both formats, even
  // though ncu writes absolute addresses.
  assert.equal(fromCuobjdump.instructions[0].offset, 0);
  assert.equal(fromNcu.instructions[0].offset, 0);
  assert.equal(census(fromCuobjdump).verdict, "SASS-OK");
});

test("the dump's own arch is read, and a fatbin header does not become an instruction", () => {
  const parsed = dump("saxpy-bench-sm90-cuobjdump.sass");
  assert.equal(parsed.dump.arch, "sm_90");
  assert.deepEqual(parsed.unparsed, [], "every line is either an instruction or recognizably not one");
  assert.equal(parsed.dump.kernels.length, 3);
});

test("the first kernel in a dump is never silently chosen", () => {
  const parsed = dump("saxpy-bench-sm90-cuobjdump.sass");
  const withoutName = resolveKernel(parsed.dump);
  assert.equal(withoutName.ok, false);
  assert.match(withoutName.reason, /3 kernels and counts no executions/);
  assert.match(withoutName.reason, /saxpy_coalesced/);
  assert.match(withoutName.reason, /32 instr/);

  // With execution counts, the most-executed kernel wins ... and a tie refuses.
  const counted = {
    ...parsed.dump,
    kernels: parsed.dump.kernels.map((entry) => ({
      ...entry,
      instructions: entry.instructions.map((instruction, index) => ({
        ...instruction,
        executed: entry.name.includes("coalesced") ? 100 : index === 0 ? 50 : 1,
      })),
    })),
  };
  const resolved = resolveKernel(counted);
  assert.equal(resolved.ok, true);
  assert.match(resolved.kernel.name, /coalesced/);
  assert.equal(resolved.how, "executed");

  const tie = { ...counted, kernels: counted.kernels.map((entry) => ({ ...entry, instructions: entry.instructions.map((i) => ({ ...i, executed: 0 })) })) };
  const refused = resolveKernel(tie);
  assert.equal(refused.ok, false);
  assert.match(refused.reason, /same instruction count/);
});

test("a name matches by substring, and an ambiguous name is refused with the candidates", () => {
  const parsed = dump("saxpy-bench-sm90-cuobjdump.sass");
  const saxpy = resolveKernel(parsed.dump, "saxpy");
  assert.equal(saxpy.ok, false);
  assert.match(saxpy.reason, /matches 2 kernels/);

  const exact = resolveKernel(parsed.dump, "saxpy_strided");
  assert.equal(exact.ok, true);
  assert.match(exact.kernel.name, /strided/);
});

test("ncu's repeated sections are one kernel, not an ambiguity", () => {
  const parsed = dump("saxpy-sm90-ncu-source.txt");
  assert.equal(parsed.dump.kernels.length, 4, "the fixture collected four sections");
  const resolved = resolveKernel(parsed.dump, "saxpy_coalesced");
  assert.equal(resolved.ok, true, resolved.ok ? "" : resolved.reason);
});

test("operands: a register operand and a descriptor operand are different facts", () => {
  const wgmma = operands(kernel("wgmma-sm90-synthetic.sass"));
  assert.equal(wgmma.mmaTotal, 5, "3 WGMMA + 2 HMMA");
  assert.equal(wgmma.aReg, 5);
  assert.equal(wgmma.aDesc, 0);

  const descriptor = parseSass(`	code for sm_90
		Function : k
        /*0000*/                   WGMMA.64x128x16.F32.BF16 desc[UR4], desc[UR8], desc[UR12] ;
`).dump.kernels[0];
  const view = operands(descriptor);
  assert.equal(view.aDesc, 1);
  assert.equal(view.aReg, 0);
});

test("serial: a wait between wgmma pairs is the reference's, none is not", () => {
  assert.equal(SERIAL_BANDS.severe, 0.9);
  const overlapped = serial(kernel("wgmma-sm90-synthetic.sass"));
  assert.equal(overlapped.wgmma, 3);
  assert.equal(overlapped.waits, 0);
  assert.equal(overlapped.ratio, 0);
  assert.equal(overlapped.band, "overlapped");

  const serialized = parseSass(`	code for sm_90
		Function : k
        /*0000*/                   WGMMA.64x128x16.F32.BF16 desc[UR4], R4, desc[UR8] ;
        /*0010*/                   DEPBAR.LE SB0, 0x0 ;
        /*0020*/                   WGMMA.64x128x16.F32.BF16 desc[UR4], R4, desc[UR8] ;
        /*0030*/                   DEPBAR.LE SB0, 0x0 ;
        /*0040*/                   WGMMA.64x128x16.F32.BF16 desc[UR4], R4, desc[UR8] ;
`).dump.kernels[0];
  const view = serial(serialized);
  assert.equal(view.ratio, 1);
  assert.equal(view.band, "severe");
  assert.equal(view.verdict, "WGMMA-SERIAL");

  const none = serial(kernel("tcgen05-sm100-synthetic.sass"));
  assert.equal(none.verdict, "WGMMA-SKIP");
});

test("schedule: the overlap fact is the wait before an elementwise run, and tcgen05 has its own fields", () => {
  const sm90 = schedule(kernel("wgmma-sm90-synthetic.sass"));
  assert.equal(sm90.isa, "wgmma");
  assert.equal(sm90.ldsm, 2);
  assert.equal(sm90.barriers, 1);
  assert.deepEqual(sm90.depbarBeforeEachEw, [1], "the FFMA run is preceded by a wait");

  const noMma = schedule(kernel("saxpy-bench-sm90-cuobjdump.sass", "saxpy_coalesced"));
  assert.equal(noMma.verdict, "SCHED-SKIP", "a kernel with no matrix multiply is not a failed schedule");

  const tcgen05 = schedule(kernel("tcgen05-sm100-synthetic.sass"));
  assert.equal(tcgen05.isa, "tcgen05");
  assert.equal(tcgen05.commits, 2);
  assert.equal(tcgen05.mbarWaits, 3);
  assert.equal(tcgen05.utcmma, 3, "three UTCMMA instructions in two runs");
  assert.equal(tcgen05.mmaRuns, 2);
});

test("live: peak registers against a budget, and no band without one", () => {
  const k = kernel("wgmma-sm90-synthetic.sass");
  const withBudget = live(k, 168);
  assert.equal(withBudget.peak, 26);
  assert.equal(withBudget.over, -142);
  assert.equal(withBudget.verdict, "LIVE-OK");

  const over = live(k, 16);
  assert.equal(over.verdict, "LIVE-FAIL");
  assert.equal(over.over, 10);

  const unknown = live(k, null);
  assert.equal(unknown.budget, null);
  assert.equal(unknown.over, null);
  assert.equal(unknown.verdict, "LIVE-OK", "no contract means no band, never an invented one");
});

test("struct: precision comes from the opcodes, and the granule has two spellings", () => {
  const sm90 = struct(kernel("wgmma-sm90-synthetic.sass"));
  assert.equal(sm90.precision, "F32/BF16");
  assert.equal(sm90.granule, "64x128x16");
  assert.equal(sm90.segments, 2, "one barrier splits the kernel in two");

  const tcgen05 = struct(kernel("tcgen05-sm100-synthetic.sass"));
  assert.equal(tcgen05.precision, "F32/E4M3/E4M3");
  assert.equal(tcgen05.granule, "16816");
});

test("launch: a cluster comes from the metrics, and missing fields are named", () => {
  const k = kernel("saxpy-sm90-ncu-source.txt", "saxpy_coalesced");
  const full = launch(
    k,
    ["launch__grid_size = 128", "launch__block_size = 256", "launch__ctas_per_cga = 1", "launch__cluster_dim_x = 16", "launch__cluster_max_active_clusters = 8", "launch__registers_per_thread = 24", "launch__smem_dynamic_size = 0"].join("\n"),
  );
  assert.equal(full.grid, "128");
  assert.equal(full.cluster, "16");
  assert.equal(full.missing.length, 0);
  assert.equal(full.verdict, "LAUNCH-OK");

  const partial = launch(k, 'launch__grid_size = 128');
  assert.equal(partial.verdict, "LAUNCH-PARTIAL");
  assert.deepEqual(partial.missing, ["block", "ctas", "cluster", "clusterMaxActive", "registersPerThread", "dynamicSmem"]);
  assert.equal(partial.cluster, null, "no cluster is not the same as cluster 1");
});

test("every view states the inference a reader is likely to over-make", () => {
  for (const view of ["census", "operands", "serial", "schedule", "live", "struct", "launch"]) {
    assert.ok(cannotSee(view).length > 20, view);
  }
  assert.equal(cannotSee("nope"), "");
});

test("through the tool: the reading carries the dump's sha, and a dump it cannot place is refused", async () => {
  const os = await import("node:os");
  const { fakePi, fakeCommandContext } = await import("../helpers/fake-host.mjs");
  const kernelExpertExtension = (await import("../../extensions/pi-kernel-expert/index.ts")).default;

  const pi = fakePi();
  kernelExpertExtension(pi);
  const { ctx } = fakeCommandContext({ cwd: FIXTURES });
  const tool = pi.tools.get("kernel_sass");

  const ok = await tool.execute("c", { view: "census", dump: "saxpy-bench-sm90-cuobjdump.sass", kernel: "saxpy_coalesced" }, undefined, undefined, ctx);
  const text = ok.content[0].text;
  assert.match(text, /^SASS-OK kernel=_Z15saxpy_coalescedifPKfPf instructions=32/);
  assert.match(text, /sha256 [0-9a-f]{16}/, "a reading names the file it read, by hash");
  assert.match(text, /census cannot tell which instruction is on the hot path/);

  const ambiguous = await tool.execute("c", { view: "census", dump: "saxpy-bench-sm90-cuobjdump.sass" }, undefined, undefined, ctx);
  assert.equal(ambiguous.details.ok, false);
  assert.equal(ambiguous.details.refusals[0].rule, "sass-kernel-ambiguous");
  assert.match(ambiguous.content[0].text, /saxpy_strided/);

  const none = await tool.execute("c", { view: "census" }, undefined, undefined, ctx);
  assert.equal(none.details.ok, false);
  assert.match(none.content[0].text, /needs a dump/);

  const missing = await tool.execute("c", { view: "census", dump: "nope.sass" }, undefined, undefined, ctx);
  assert.match(missing.content[0].text, /There is no dump at nope\.sass/);
  void os;
});
