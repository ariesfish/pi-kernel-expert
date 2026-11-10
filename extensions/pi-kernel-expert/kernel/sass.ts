/**
 * Static SASS reads: what the compiler actually emitted, from a dump the caller
 * already has.
 *
 * The point is to replace inference with a reading. An agent that believes the
 * register budget is the binding constraint, or that `ptxas` kept the pipeline
 * overlapped, or that a cluster was launched, is usually wrong in one of those
 * places — and each of them is visible in the text of the dump at zero GPU cost.
 *
 * Three rules shape this module:
 *
 * - **One parser, two formats.** `cuobjdump -sass` writes an offset column and a
 *   hex encoding; `ncu --page source --print-source sass` writes an absolute
 *   address and, in CSV form, an execution count. Both are the same instruction
 *   list and the census must agree.
 * - **Never guess the kernel.** `kernels[0]` is not "our kernel": in a real dump
 *   it was `torch.randn`'s RNG kernel, and the histogram built from it was
 *   self-consistent nonsense. The caller names it, or the tool takes the one
 *   with the most executed instructions, or it refuses.
 * - **Every view says what it cannot see.** `struct` cannot see the algorithm,
 *   `launch` cannot see occupancy, `census` does not know which instruction is on
 *   the hot path. That line is part of the output because the failure mode here
 *   is a confident reading of the wrong thing.
 */

/** What makes an instruction "MMA" for the purposes of these reads. */
const MMA_OPCODES = ["HMMA", "IMMA", "BMMA", "DMMA", "QMMA", "OMMA"] as const;
const WGMMA = "WGMMA";
const UTCMMA = "UTCMMA";
/** Elementwise work: the arithmetic that a pipeline can overlap a load under. */
const EW_OPCODES = ["FFMA", "FADD", "FMUL", "FSEL", "F2F", "IADD3", "IMAD", "LOP3", "SHF", "ISETP", "FSETP"] as const;
/** Anything that waits for outstanding async work. */
const WAIT_OPCODES = ["DEPBAR", "SYNCS", "BAR", "NAMEDBAR", "MBAR"] as const;
const LDSM_OPCODES = ["LDSM"] as const;

/**
 * The serialization bands. A ratio of waits-per-wgmma-gap: `0` means every gap
 * is overlapped, `1` means the compiler put a wait between every pair. The
 * reference kernel sits near 0.15; a fallback (unprovable aliasing) lands near
 * 1.0. These numbers are a claim about what the ratio means, which is why they
 * live in one table and change by spec edit, not by code edit.
 */
export const SERIAL_BANDS = { severe: 0.9, elevated: 0.5, reference: 0.15 } as const;

export interface SassInstruction {
  /** As written: the hex offset for cuobjdump, the absolute address for ncu. */
  address: string;
  /** Byte offset from the first instruction of the kernel. */
  offset: number;
  predicates: string[];
  /** `LDG.E` — the opcode with its modifiers. */
  opcode: string;
  /** `LDG` — the opcode's family, which is what the views count. */
  family: string;
  operands: string[];
  /** The instruction without the address or the encoding. */
  text: string;
  encoding: string | null;
  /** From a CSV `Instructions Executed` column, when the dump carries one. */
  executed: number | null;
}

export interface SassKernel {
  name: string;
  instructions: SassInstruction[];
}

export type SassFormat = "cuobjdump" | "ncu";

export interface SassDump {
  format: SassFormat;
  /** `sm_90` when the dump says so; ncu pages do not. */
  arch: string | null;
  kernels: SassKernel[];
}

export interface ParseResult {
  dump: SassDump;
  /** Lines the parser could not place. Non-empty means the dump is not what it looked like. */
  unparsed: string[];
}

/** `cuobjdump -sass`: an offset in a leading block comment, the instruction, then the hex encoding. */
const CUOBJDUMP_LINE = /^\s*\/\*([0-9a-f]+)\*\/\s+(.+?)\s*(?:\/\*\s*(0x[0-9a-f]+)\s*\*\/)?\s*;?\s*$/i;
const CUOBJDUMP_FUNCTION = /^\s*Function\s*:\s*(.+?)\s*$/;
const CUOBJDUMP_ARCH = /^\s*code for\s+(\S+)\s*$/;

/** `ncu --page source`: `0x7efd537a0b00           LDC R1, c[0x0][0x28]`. */
const NCU_LINE = /^\s*(0x[0-9a-f]+)\s+(.+?)\s*$/i;
const NCU_KERNEL = /^Kernel Name\s+(.+?)\s*$/;
const NCU_HEADER = /^(Address|Source|Instructions Executed)\b/i;

/** A CSV row: address, source text, and an optional execution count. */
function csvCells(line: string): string[] | null {
  if (!line.trim().startsWith('"')) return null;
  const cells: string[] = [];
  let current = "";
  let quoted = false;
  for (const char of line) {
    if (char === '"') {
      quoted = !quoted;
      continue;
    }
    if (char === "," && !quoted) {
      cells.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  cells.push(current);
  return cells;
}

/**
 * Parse a dump in either format. `format` may be forced; otherwise the first
 * instruction line decides, and a text with no instruction at all is an error
 * the caller reports rather than an empty success.
 */
export function parseSass(text: string, format?: SassFormat): ParseResult {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const detected = format ?? detectFormat(lines);
  return detected === "ncu" ? parseNcu(lines) : parseCuobjdump(lines);
}

function detectFormat(lines: readonly string[]): SassFormat {
  for (const line of lines) {
    if (CUOBJDUMP_FUNCTION.test(line) || CUOBJDUMP_ARCH.test(line)) return "cuobjdump";
    if (NCU_KERNEL.test(line)) return "ncu";
    if (CUOBJDUMP_LINE.test(line)) return "cuobjdump";
    const cells = csvCells(line);
    if (cells && /^0x[0-9a-f]+$/i.test(cells[0] ?? "")) return "ncu";
    if (NCU_LINE.test(line)) return "ncu";
  }
  return "cuobjdump";
}

function parseCuobjdump(lines: readonly string[]): ParseResult {
  const kernels: SassKernel[] = [];
  const unparsed: string[] = [];
  let arch: string | null = null;
  let kernel: SassKernel | null = null;
  let base: number | null = null;

  for (const line of lines) {
    const archMatch = CUOBJDUMP_ARCH.exec(line);
    if (archMatch) {
      arch = archMatch[1];
      continue;
    }
    if (/^\s*\.(target|headerflags|section|text|global|align|file)\b/.test(line)) continue;
    // A dump of a whole binary starts with the fatbin header, not with code.
    if (/^\s*Fatbin\b/.test(line) || /^=+\s*$/.test(line) || /^\s*arch = /.test(line)) {
      const fatbinArch = /^\s*arch = (\S+)/.exec(line);
      if (fatbinArch) arch = fatbinArch[1];
      continue;
    }
    if (/^\s*(code version|host|compile_size|ptxasOptions)\s*=/.test(line)) continue;
    if (/^\s*compressed\s*$/.test(line)) continue;
    const functionMatch = CUOBJDUMP_FUNCTION.exec(line);
    if (functionMatch) {
      kernel = { name: functionMatch[1], instructions: [] };
      kernels.push(kernel);
      base = null;
      continue;
    }
    const instruction = CUOBJDUMP_LINE.exec(line);
    if (instruction && kernel) {
      const address = instruction[1];
      const offset = Number.parseInt(address, 16);
      if (base === null) base = offset;
      kernel.instructions.push({
        address,
        offset: offset - base,
        encoding: instruction[3] ?? null,
        executed: null,
        ...instructionParts(instruction[2]),
      });
      continue;
    }
    // The encoding wraps onto its own line: a bare hex block comment.
    if (/^\s*\/\*\s*0x[0-9a-f]+\s*\*\/\s*$/i.test(line)) continue;
    if (line.trim() === "") continue;
    if (/^\s*code for\b/.test(line)) continue;
    // cuobjdump elides repeated code with a row of dots.
    if (/^\s*\.{2,}\s*$/.test(line)) continue;
    unparsed.push(line);
  }
  return { dump: { format: "cuobjdump", arch, kernels }, unparsed };
}

function parseNcu(lines: readonly string[]): ParseResult {
  const kernels: SassKernel[] = [];
  const unparsed: string[] = [];
  let kernel: SassKernel | null = null;
  let base: number | null = null;
  let executedColumn: number | null = null;

  for (const line of lines) {
    const kernelMatch = NCU_KERNEL.exec(line.trim());
    if (kernelMatch) {
      kernel = { name: kernelMatch[1], instructions: [] };
      kernels.push(kernel);
      base = null;
      executedColumn = null;
      continue;
    }
    if (line.trim() === "" || /^-+\s+-+$/.test(line.trim()) || NCU_HEADER.test(line.trim())) {
      if (/Instructions Executed/i.test(line)) executedColumn = 2;
      continue;
    }
    const cells = csvCells(line);
    if (cells && /^0x[0-9a-f]+$/i.test(cells[0] ?? "")) {
      if (!kernel) {
        kernel = { name: "unknown", instructions: [] };
        kernels.push(kernel);
        base = null;
      }
      const address = cells[0];
      const offset = Number.parseInt(address, 16);
      if (base === null) base = offset;
      const source = cells[1] ?? "";
      const collected = cells[2] ?? "";
      const executed = /^\d+$/.test(collected.trim()) ? Number.parseInt(collected, 10) : null;
      kernel.instructions.push({ address, offset: offset - base, encoding: null, executed, ...instructionParts(source) });
      continue;
    }
    const lineMatch = NCU_LINE.exec(line);
    if (lineMatch && kernel) {
      const address = lineMatch[1];
      const offset = Number.parseInt(address, 16);
      if (base === null) base = offset;
      kernel.instructions.push({ address, offset: offset - base, encoding: null, executed: null, ...instructionParts(lineMatch[2]) });
      continue;
    }
    // A bare CSV row when the header was not seen (older ncu).
    void executedColumn;
    if (line.trim() !== "") unparsed.push(line);
  }
  return { dump: { format: "ncu", arch: null, kernels }, unparsed };
}

function instructionParts(source: string): Pick<SassInstruction, "text" | "opcode" | "family" | "operands" | "predicates"> {
  let text = source.trim().replace(/;+$/, "").trim();
  const predicates: string[] = [];
  while (/^@!?P\d+\b/i.test(text)) {
    const [predicate, ...rest] = text.split(/\s+/);
    predicates.push(predicate);
    text = rest.join(" ").trim();
  }
  const [opcode = "", ...rest] = text.split(/\s+/);
  const operandsText = rest.join(" ");
  return {
    text,
    opcode,
    family: opcode.split(".")[0].toUpperCase(),
    operands: operandsText
      .split(",")
      .map((operand) => operand.trim())
      .filter((operand) => operand !== ""),
    predicates,
  };
}

/** The kernel a caller means. `null` when the dump has none at all. */
export type KernelResolution =
  | { ok: true; kernel: SassKernel; how: "named" | "executed" | "only" }
  | { ok: false; reason: string };

/**
 * `--kernel` wins, matched exactly or by substring against the name as written
 * (a cuobjdump name is mangled, an ncu name carries the signature, and a caller
 * typing `saxpy` should not have to know which). Without a name: the kernel with
 * the most executed instructions when the dump counts them, otherwise a refusal
 * that lists what it could have picked.
 */
export function resolveKernel(dump: SassDump, requested?: string | null): KernelResolution {
  const wanted = requested?.trim() ?? "";
  if (dump.kernels.length === 0) {
    return { ok: false, reason: "the dump holds no kernel: no `Function :` line and no instruction row was found" };
  }
  if (wanted !== "") {
    // A CSV export carries no kernel name; one unnamed kernel is still the one
    // the caller asked for, and refusing it would make every CSV unusable.
    if (dump.kernels.length === 1 && dump.kernels[0].name === "unknown") {
      return { ok: true, kernel: { ...dump.kernels[0], name: wanted }, how: "named" };
    }
    const lowered = wanted.toLowerCase();
    const exact = dump.kernels.filter((kernel) => kernel.name.toLowerCase() === lowered);
    const matches = exact.length > 0 ? exact : dump.kernels.filter((kernel) => kernel.name.toLowerCase().includes(lowered));
    if (matches.length === 1) return { ok: true, kernel: matches[0], how: "named" };
    // ncu writes one section per collected launch: the same kernel four times is
    // one kernel measured four times, and refusing that would make every
    // multi-launch collection unusable.
    const signatures = new Set(matches.map(signatureOf));
    if (matches.length > 1 && signatures.size === 1) return { ok: true, kernel: matches[0], how: "named" };
    if (matches.length === 0) {
      return {
        ok: false,
        reason: `no kernel matches ${JSON.stringify(wanted)}; the dump has ${dump.kernels.map((kernel) => `${kernel.name} (${kernel.instructions.length} instr)`).join(", ")}`,
      };
    }
    return {
      ok: false,
      reason: `${JSON.stringify(wanted)} matches ${matches.length} kernels: ${matches.map((kernel) => kernel.name).join(", ")}. Name one exactly.`,
    };
  }

  const counted = dump.kernels.filter((kernel) => kernel.instructions.some((instruction) => instruction.executed !== null));
  if (counted.length === dump.kernels.length) {
    const executedTotal = (kernel: SassKernel): number =>
      kernel.instructions.reduce((total, instruction) => total + (instruction.executed ?? 0), 0);
    const ranked = [...counted].sort((left, right) => executedTotal(right) - executedTotal(left));
    if (ranked.length > 1 && executedTotal(ranked[0]) === executedTotal(ranked[1])) {
      return {
        ok: false,
        reason: `${ranked[0].name} and ${ranked[1].name} executed the same instruction count (${executedTotal(ranked[0])}); pass the kernel name`,
      };
    }
    return { ok: true, kernel: ranked[0], how: "executed" };
  }

  if (dump.kernels.length === 1) return { ok: true, kernel: dump.kernels[0], how: "only" };
  return {
    ok: false,
    reason: `the dump holds ${dump.kernels.length} kernels and counts no executions: pass the kernel name. Candidates: ${dump.kernels
          .map((kernel) => `${kernel.name} (${kernel.instructions.length} instr)`)
          .join(", ")}`,
  };
}

// --- the six views ---------------------------------------------------------

export interface CensusView {
  kernel: string;
  instructions: number;
  families: Array<{ family: string; count: number }>;
  /** `SASS-OK` when the kernel has instructions; `SASS-FAIL` when it has none. */
  verdict: "SASS-OK" | "SASS-FAIL";
}

export function census(kernel: SassKernel): CensusView {
  const counts = new Map<string, number>();
  for (const instruction of kernel.instructions) {
    counts.set(instruction.family, (counts.get(instruction.family) ?? 0) + 1);
  }
  const families = [...counts.entries()]
    .map(([family, count]) => ({ family, count }))
    .sort((left, right) => right.count - left.count || left.family.localeCompare(right.family));
  return {
    kernel: kernel.name,
    instructions: kernel.instructions.length,
    families,
    verdict: kernel.instructions.length === 0 ? "SASS-FAIL" : "SASS-OK",
  };
}

export interface OperandView {
  kernel: string;
  mmaTotal: number;
  /** MMA whose A operand is a register. */
  aReg: number;
  /** MMA whose A operand is a shared-memory descriptor. */
  aDesc: number;
  aOther: number;
  verdict: "OPERANDS" | "OPERANDS-FAIL";
}

/** Operand census: "budget reserved" and "path built" are different facts. */
export function operands(kernel: SassKernel): OperandView {
  let mmaTotal = 0;
  let aReg = 0;
  let aDesc = 0;
  let aOther = 0;
  for (const instruction of kernel.instructions) {
    if (!isMmaLike(instruction.family)) continue;
    if (instruction.opcode.toUpperCase().includes("COMMIT")) continue;
    mmaTotal += 1;
    const a = instruction.operands[1] ?? "";
    if (/desc\s*\[/i.test(a)) aDesc += 1;
    else if (/^(U?R)\d/i.test(a)) aReg += 1;
    else aOther += 1;
  }
  return {
    kernel: kernel.name,
    mmaTotal,
    aReg,
    aDesc,
    aOther,
    verdict: mmaTotal === 0 ? "OPERANDS" : aOther > 0 ? "OPERANDS-FAIL" : "OPERANDS",
  };
}

export interface SerialView {
  kernel: string;
  wgmma: number;
  /** Gaps between consecutive wgmma that contain a wait. */
  waits: number;
  gaps: number;
  ratio: number | null;
  band: "severe" | "elevated" | "overlapped" | null;
  verdict: "WGMMA-SERIAL" | "WGMMA-SKIP";
}

/**
 * Did `ptxas` serialize the consumer pipeline? A wait between consecutive
 * `WGMMA`s means the compiler could not prove the accumulator untouched, and it
 * inserts one for the whole function. That is a property of the compiler's
 * aliasing proof, not of the algorithm, so banning the direction over it
 * mis-attributes the regression.
 */
export function serial(kernel: SassKernel): SerialView {
  const positions: number[] = [];
  kernel.instructions.forEach((instruction, index) => {
    if (instruction.family === WGMMA) positions.push(index);
  });
  if (positions.length < 2) {
    return { kernel: kernel.name, wgmma: positions.length, waits: 0, gaps: 0, ratio: null, band: null, verdict: "WGMMA-SKIP" };
  }
  let waits = 0;
  for (let index = 1; index < positions.length; index += 1) {
    const between = kernel.instructions.slice(positions[index - 1] + 1, positions[index]);
    if (between.some((instruction) => isWait(instruction.family))) waits += 1;
  }
  const gaps = positions.length - 1;
  const ratio = waits / gaps;
  const band = ratio >= SERIAL_BANDS.severe ? "severe" : ratio >= SERIAL_BANDS.elevated ? "elevated" : "overlapped";
  return { kernel: kernel.name, wgmma: positions.length, waits, gaps, ratio, band, verdict: "WGMMA-SERIAL" };
}

export interface ScheduleView {
  kernel: string;
  isa: "mma_sync" | "wgmma" | "tcgen05" | "none";
  mmaRuns: number;
  barriers: number;
  ldsm: number;
  /** UTCMMA instructions, not runs: `mmaRuns` counts runs, and two fields with one meaning is a bug waiting. */
  utcmma: number;
  commits: number;
  mbarWaits: number;
  /** Runs of elementwise work between MMA runs, in order. */
  ewRuns: number;
  /** For each elementwise run, whether a wait sits between it and the MMA before it. */
  depbarBeforeEachEw: number[];
  verdict: "SCHED-OK" | "SCHED-FAIL" | "SCHED-SKIP";
}

/**
 * How the phases are interleaved. `depbarBeforeEachEw = 1` means the loop drains
 * everything before the elementwise run; `0` means a chain was deliberately left
 * in flight. That is the overlap fact, and it is invisible to a percentage.
 */
export function schedule(kernel: SassKernel): ScheduleView {
  let isa: ScheduleView["isa"] = "none";
  let mmaRuns = 0;
  let barriers = 0;
  let ldsm = 0;
  let utcmma = 0;
  let commits = 0;
  let mbarWaits = 0;
  let ewRuns = 0;
  let inMma = false;
  let inEw = false;
  const depbarBeforeEachEw: number[] = [];
  let waitSinceLastMma = false;

  for (const instruction of kernel.instructions) {
    const family = instruction.family;
    if (instruction.opcode.toUpperCase().includes("COMMIT")) {
      commits += 1;
      continue;
    }
    if (UTCMMA === family) {
      isa = "tcgen05";
      if (!inMma) {
        mmaRuns += 1;
        inMma = true;
        inEw = false;
      }
      utcmma += 1;
      waitSinceLastMma = false;
      continue;
    }
    if (isMma(family) || family === WGMMA) {
      if (isa === "none") isa = family === WGMMA ? "wgmma" : "mma_sync";
      if (!inMma) {
        mmaRuns += 1;
        inMma = true;
        inEw = false;
      }
      waitSinceLastMma = false;
      continue;
    }
    if (isWait(family)) {
      if (family === "BAR" || family === "NAMEDBAR") barriers += 1;
      if (family === "MBAR" || /^SYNCS/.test(family)) mbarWaits += 1;
      waitSinceLastMma = true;
      if (inEw) depbarBeforeEachEw[depbarBeforeEachEw.length - 1] = 1;
      continue;
    }
    if (LDSM_OPCODES.includes(family as (typeof LDSM_OPCODES)[number])) ldsm += 1;
    if ((EW_OPCODES as readonly string[]).includes(family)) {
      if (!inEw) {
        ewRuns += 1;
        depbarBeforeEachEw.push(waitSinceLastMma ? 1 : 0);
        inEw = true;
        inMma = false;
      }
    }
  }
  return {
    kernel: kernel.name,
    isa,
    mmaRuns,
    barriers,
    ldsm,
    utcmma,
    commits,
    mbarWaits,
    ewRuns,
    depbarBeforeEachEw,
    // A kernel with no matrix multiply has no phase to interleave: that is not a
    // failed schedule, and calling it one teaches a reader to ignore the word.
    verdict: mmaRuns === 0 ? "SCHED-SKIP" : "SCHED-OK",
  };
}

export interface LiveView {
  kernel: string;
  /** Highest register index used, plus one. */
  peak: number;
  /** Highest uniform register index used, plus one. */
  uniformRegs: number;
  budget: number | null;
  verdict: "LIVE-OK" | "LIVE-FAIL";
  /** The band applied, or null when no contract budget was available. */
  over: number | null;
}

/**
 * The schedule's register price. `peak` is read from the highest register index
 * the kernel actually names — there is no ptxas metadata in a dump, so there is
 * no honest "guessed fraction" to report and this view does not print one.
 */
export function live(kernel: SassKernel, budget: number | null): LiveView {
  let peak = 0;
  let uniform = 0;
  for (const instruction of kernel.instructions) {
    for (const operand of instruction.operands) {
      for (const match of operand.matchAll(/\bU?R(\d+)/g)) {
        const index = Number.parseInt(match[1], 10);
        if (/^U/i.test(match[0])) uniform = Math.max(uniform, index + 1);
        else peak = Math.max(peak, index + 1);
      }
    }
    if (peak === 0 && instruction.predicates.length > 0) peak = Math.max(peak, 0);
  }
  const over = budget === null ? null : peak - budget;
  return {
    kernel: kernel.name,
    peak,
    uniformRegs: uniform,
    budget,
    over,
    verdict: over !== null && over > 0 ? "LIVE-FAIL" : "LIVE-OK",
  };
}

export interface StructView {
  kernel: string;
  /** Branch-delimited blocks. */
  regions: number;
  /** Barrier-delimited segments. */
  segments: number;
  /** From the MMA opcode's modifiers, never from source text. */
  precision: string | null;
  /** The MMA tile, e.g. `16816`. */
  granule: string | null;
  warpSpecialized: boolean;
  verdict: "STRUCT-OK" | "STRUCT-FAIL";
}

/** How each phase is built: block shape, precision, warp specialization. */
export function struct(kernel: SassKernel): StructView {
  const targets = new Set<string>();
  for (const instruction of kernel.instructions) {
    if (instruction.family !== "BRA" && instruction.family !== "BRX") continue;
    const target = instruction.operands[instruction.operands.length - 1] ?? "";
    if (target !== "") targets.add(target);
  }
  let segments = 1;
  let warpSpecialized = false;
  let precision: string | null = null;
  let granule: string | null = null;
  for (const instruction of kernel.instructions) {
    if (instruction.family === "BAR" || instruction.family === "NAMEDBAR") segments += 1;
    if (instruction.operands.some((operand) => /SR_WARPID|SR_LANEID/.test(operand))) warpSpecialized = true;
    if (!isMmaLike(instruction.family)) continue;
    if (precision === null) {
      const parts = instruction.opcode.split(".").slice(1);
      // `16816` on an HMMA, `64x128x16` on a WGMMA: both are the tile.
      granule = parts.find((part) => /^\d{2,5}(?:x\d+)*$/.test(part)) ?? null;
      const dtypes = parts.filter((part) => /^(F|BF|TF|E\d|S|U)\d*[A-Z0-9]*$/.test(part));
      if (dtypes.length > 0) precision = dtypes.join("/");
    }
  }
  return {
    kernel: kernel.name,
    regions: Math.max(targets.size, 1),
    segments,
    precision,
    granule,
    warpSpecialized,
    verdict: kernel.instructions.length === 0 ? "STRUCT-FAIL" : "STRUCT-OK",
  };
}

export interface LaunchView {
  kernel: string;
  grid: string | null;
  block: string | null;
  ctas: string | null;
  cluster: string | null;
  clusterMaxActive: string | null;
  registersPerThread: string | null;
  dynamicSmem: string | null;
  /** Fields the input did not carry. A launch shape read off the grid is the fallacy this view prevents. */
  missing: string[];
  verdict: "LAUNCH-OK" | "LAUNCH-PARTIAL";
}

const LAUNCH_FIELDS = [
  ["grid", ["grid size", "launch__grid_size"]],
  ["block", ["block size", "launch__block_size"]],
  ["ctas", ["ctas per cga", "launch__ctas_per_cga"]],
  ["cluster", ["cluster size", "launch__cluster_dim_x"]],
  ["clusterMaxActive", ["max active clusters", "launch__cluster_max_active_clusters"]],
  ["registersPerThread", ["registers per thread", "launch__registers_per_thread"]],
  ["dynamicSmem", ["dynamic shared memory per block", "launch__smem_dynamic_size"]],
] as const;

function firstOf(needles: readonly string[], read: (needle: string) => string | null | undefined): string | null {
  for (const needle of needles) {
    const value = read(needle);
    if (value !== null && value !== undefined && value !== "") return value;
  }
  return null;
}

/**
 * Launch shape, from metrics rather than from the dump's own instruction text: a
 * flat grid with `launch__cluster_dim_x = 16` is a clustered launch, and reading
 * "no cluster" off the grid shape made a real kernel 16x slower.
 */
export function launch(kernel: SassKernel, metricsText: string): LaunchView {
  const metrics = metricMap(metricsText);
  const table = csvLaunchTable(metricsText);
  const found: Record<string, string | null> = {};
  for (const [field, needles] of LAUNCH_FIELDS) {
    found[field] = firstOf(needles, (needle) => metrics.get(needle) ?? readTable(table, needle));
  }
  const missing = LAUNCH_FIELDS.filter(([field]) => found[field] === null).map(([field]) => field);
  return {
    kernel: kernel.name,
    grid: found.grid,
    block: found.block,
    ctas: found.ctas,
    cluster: found.cluster,
    clusterMaxActive: found.clusterMaxActive,
    registersPerThread: found.registersPerThread,
    dynamicSmem: found.dynamicSmem,
    missing,
    verdict: missing.length === 0 ? "LAUNCH-OK" : "LAUNCH-PARTIAL",
  };
}

/**
 * An ncu details export carries the launch shape as *columns* on every row
 * (`Grid Size`, `Block Size`, `Cluster Size`, `Registers Per Thread`), not as
 * metrics. Reading it as `key = value` returns the next header instead, which is
 * how a launch view invents a grid of "Device".
 */
function csvLaunchTable(text: string): { header: string[]; row: string[] } | null {
  const lines = text.split("\n").filter((line) => line.trim() !== "");
  for (let index = 0; index < lines.length; index += 1) {
    const header = csvCells(lines[index]);
    if (!header) continue;
    if (!header.some((cell) => /^grid size$/i.test(cell.trim()))) continue;
    const data = csvCells(lines[index + 1] ?? "");
    if (!data) continue;
    return { header: header.map((cell) => cell.trim()), row: data.map((cell) => cell.trim()) };
  }
  return null;
}

function readTable(table: { header: string[]; row: string[] } | null, needle: string): string | null {
  if (table === null) return null;
  const index = table.header.findIndex((cell) => cell.toLowerCase() === needle);
  if (index === -1) return null;
  const value = table.row[index] ?? "";
  return value === "" ? null : value;
}

/**
 * `Metric Name` -> `Metric Value` from an ncu details CSV, plus every
 * `key = value` line. The two shapes are the same fact written two ways.
 */
function metricMap(text: string): Map<string, string> {
  const map = new Map<string, string>();
  let metricColumn: number | null = null;
  let valueColumn: number | null = null;
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    const cells = csvCells(line);
    if (cells) {
      const names = cells.map((cell) => cell.trim().toLowerCase());
      const metric = names.indexOf("metric name");
      const value = names.indexOf("metric value");
      if (metric !== -1 && value !== -1) {
        metricColumn = metric;
        valueColumn = value;
        continue;
      }
      if (metricColumn === null || valueColumn === null) continue;
      const name = cells[metricColumn]?.trim().toLowerCase();
      const collected = cells[valueColumn]?.trim();
      if (name && collected !== undefined && collected !== "" && !map.has(name)) map.set(name, collected);
      continue;
    }
    const pair = /^\s*([A-Za-z0-9_.]+)\s*[=:]\s*(\S+)\s*$/.exec(line);
    if (pair && !map.has(pair[1].toLowerCase())) map.set(pair[1].toLowerCase(), pair[2]);
  }
  return map;
}

// --- helpers ---------------------------------------------------------------

/** Two sections describe the same kernel when their names and instruction lists agree. */
function signatureOf(kernel: SassKernel): string {
  return `${kernel.name}\u0000${kernel.instructions.map((instruction) => instruction.text).join("\n")}`;
}

/** Every instruction that issues a matrix multiply, whichever path it takes. */
function isMmaLike(family: string): boolean {
  return isMma(family) || family === WGMMA || family === UTCMMA;
}

function isMma(family: string): boolean {
  return (MMA_OPCODES as readonly string[]).includes(family);
}

function isWait(family: string): boolean {
  return (WAIT_OPCODES as readonly string[]).includes(family);
}

/** The one-line limit each view must state alongside its verdict. */
export function cannotSee(view: string): string {
  switch (view) {
    case "census":
      return "census cannot tell which instruction is on the hot path: a large count is not a large cost.";
    case "operands":
      return "operands cannot tell whether the operand path is fast, only which one was built.";
    case "serial":
      return "serial reads the wait placement, not the reason: a wait can be the aliasing proof or a genuine dependency.";
    case "schedule":
      return "schedule cannot see memory-level parallelism: two schedules with the same waits can still differ by the cache.";
    case "live":
      return "live counts the registers the kernel names, not the ones ptxas allocated — a dump carries no allocation metadata. The ncu details page reports registers per thread; `launch` reads it.";
    case "struct":
      return "struct reads the opcodes, not the algorithm: the same tiles can implement a different kernel.";
    case "launch":
      return "launch reads the shape that ran, not the occupancy it achieved.";
    default:
      return "";
  }
}

// --- rendering ---------------------------------------------------------------

export type SassView =
  | CensusView
  | OperandView
  | SerialView
  | ScheduleView
  | LiveView
  | StructView
  | LaunchView;

/** The one machine line per view: the shape a reader (or a grep) can rely on. */
export function describeView(view: SassView): string {
  if ("instructions" in view) {
    const top = view.families
      .slice(0, 5)
      .map((entry) => `${entry.family}:${entry.count}`)
      .join(" ");
    return `${view.verdict} kernel=${view.kernel} instructions=${view.instructions} families=${view.families.length} top=${top}`;
  }
  if ("mmaTotal" in view) {
    return `${view.verdict} kernel=${view.kernel} mma_total=${view.mmaTotal} a_reg=${view.aReg} a_desc=${view.aDesc} a_other=${view.aOther}`;
  }
  if ("wgmma" in view) {
    if (view.verdict === "WGMMA-SKIP") return `WGMMA-SKIP kernel=${view.kernel} wgmma=${view.wgmma}`;
    return `${view.verdict} kernel=${view.kernel} wgmma=${view.wgmma} depbar0=${view.waits} tight=${view.gaps} ratio=${view.ratio?.toFixed(3)} band=${view.band}`;
  }
  if ("depbarBeforeEachEw" in view) {
    const isa =
      view.isa === "tcgen05"
        ? `utcmma=${view.utcmma} commits=${view.commits} mbar_waits=${view.mbarWaits}`
        : `mma_runs=${view.mmaRuns} barriers=${view.barriers} ldsm=${view.ldsm}`;
    return `${view.verdict} kernel=${view.kernel} isa=${view.isa} ${isa} ew_runs=${view.ewRuns} depbar_before_each_ew=[${view.depbarBeforeEachEw.join(",")}]`;
  }
  if ("uniformRegs" in view) {
    const band = view.budget === null ? "budget=unknown (no band applied)" : `budget=${view.budget} over=${view.over}`;
    return `${view.verdict} kernel=${view.kernel} peak=${view.peak} uniform=${view.uniformRegs} ${band}`;
  }
  if ("regions" in view) {
    return `${view.verdict} kernel=${view.kernel} regions=${view.regions} segments=${view.segments} precision=${view.precision ?? "unknown"} granule=${view.granule ?? "unknown"} warp_specialized=${view.warpSpecialized ? "yes" : "no"}`;
  }
  const missing = view.missing.length === 0 ? "" : ` missing=${view.missing.join(",")}`;
  return `${view.verdict} kernel=${view.kernel} grid=${view.grid ?? "?"} block=${view.block ?? "?"} ctas=${view.ctas ?? "?"} cluster=${view.cluster ?? "?"} cluster_max_active=${view.clusterMaxActive ?? "?"} regs=${view.registersPerThread ?? "?"} smem_dyn=${view.dynamicSmem ?? "?"}${missing}`;
}

/** The launch view's readable table, for the caller who wants more than the line. */
export function describeLaunch(view: SassView): string[] {
  if (!("missing" in view)) return [];
  if (view.missing.length === 0) {
    return [
      view.cluster === "0"
        ? "  launch: cluster 0 — this launch used no cluster. A cluster is read from the metrics, never from the grid shape."
        : `  launch: cluster ${view.cluster ?? "?"} — read from the metrics, not from the grid shape.`,
    ];
  }
  return [
    `  launch: ${view.missing.join(", ")} absent from the input. A shape read off the grid is the fallacy this view prevents — pass the details page or the launch__* metrics.`,
  ];
}
