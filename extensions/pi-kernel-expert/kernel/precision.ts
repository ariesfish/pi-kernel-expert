/**
 * The precision gate: the reference's own error is the ruler.
 *
 * A tolerance answers "is the candidate close to the reference?". It cannot
 * answer the question that decides a promotion — *is the candidate's error the
 * same kind of error the reference makes?* A kernel can be right to `rtol`,
 * green on every group, and still be a precision regression: it rounds where
 * the reference does not, accumulates in the input dtype where the reference
 * accumulates in fp32, quantizes a transition the reference keeps. So the gate
 * measures the reference against itself (`calibrateCommand` prints
 * `max_diff=<number>`), records that error per dtype, and refuses a keep whose
 * error exceeds the reference's by more than a floor:
 *
 *     threshold(e_ref, dtype) = K_RATIO * e_ref + max(ulp(dtype), FLOOR_REL)
 *     refuse when e_cand > threshold
 *
 * The arithmetic is ForgeKernel's, copied rather than re-derived
 * (`src/forgekernel/card_template/eval/precision.py:77-98`, `:231-233`; research
 * `measure.md` §2.6). `ulp(dtype)` is the dtype's unit in the last place at
 * 1.0, i.e. 2^-significand_bits; `FLOOR_REL` is 2^-17 absolute, which is what
 * keeps a dtype with a tiny unit (fp64) from turning rounding noise into a
 * refusal, and what keeps an exact dtype (int8) from accepting a single ulp.
 * `>` and not `>=`: landing exactly on the threshold is the reference's own
 * error plus its floor, which is the definition of "as good as the reference",
 * not a regression.
 *
 * Two failure modes are named instead of defaulted:
 *
 * - An **unknown dtype** has no unit in the table. It falls back to fp32's
 *   2^-23 (the strict, common default) and the dtype string is listed in the
 *   warnings, because a silent fallback would let `fp4` pass on fp32's floor.
 * - A **row with no number** (`n/a`: the check printed no `max_diff`) is not
 *   compared at all. Zero would claim the candidate is exact; `n/a` says the
 *   check is not evidence of precision, which is the truth.
 *
 * Every function here is pure. `candidates.ts` reads the two files and parses
 * them through this module, so the arithmetic is unit-testable without a
 * workspace, a git repo, or a GPU.
 */
import { DEFAULT_GROUP, type KernelContract } from "./contract.ts";

/** Workspace-relative, like `.kernel/baseline.tsv`: the generated scripts use the literal. */
export const PRECISION_TSV_PATH = ".kernel/precision.tsv";
export const CALIBRATION_JSON_PATH = ".kernel/calibration.json";
export const PRECISION_SCHEMA_VERSION = 1;

/** How much worse than the reference a candidate may be before it is refused. */
export const K_RATIO = 3;

/**
 * The absolute part of the floor, 2^-17. ForgeKernel's `FLOOR_REL`: an error
 * below this is rounding at ~7 decimal digits, which is the noise level of a
 * fp32 accumulation and of any honest kernel on any dtype.
 */
export const FLOOR_REL = 2 ** -17;

/**
 * The dtype's unit in the last place at 1.0: 2^-significand_bits.
 *
 * Sources: fp64 53-bit significand, fp32 24-bit, tf32/fp16 11-bit (10 explicit
 * bits + the implicit one), bf16 8-bit, fp8_e4m3 4-bit, fp8_e5m2 3-bit. The
 * integer dtypes are exact, so their unit is 0 and the floor is FLOOR_REL.
 */
export const DTYPE_ULP: Readonly<Record<string, number>> = {
  fp64: 2 ** -52,
  fp32: 2 ** -23,
  tf32: 2 ** -11,
  fp16: 2 ** -11,
  bf16: 2 ** -8,
  fp8_e4m3: 2 ** -4,
  fp8_e5m2: 2 ** -3,
  int8: 0,
  uint8: 0,
  int32: 0,
};

/** fp32's unit: the strict default, and what an unknown dtype is charged. */
export const UNKNOWN_DTYPE_ULP = 2 ** -23;

/** The table keys, for a message that says what it does know. */
export const KNOWN_DTYPES = Object.keys(DTYPE_ULP);

/**
 * A dtype string arrives from a contract, from torch, from a harness: `bf16`,
 * `bfloat16`, `torch.bfloat16`, `fp16*`, `float16`, `float8_e4m3fn`. The table
 * is keyed on the dtype itself, so normalize on the leading token after
 * stripping a known vendor prefix — never on a substring, because `float8`
 * appears in both fp8 flavours.
 */
const DTYPE_ALIASES: Readonly<Record<string, string>> = {
  float64: "fp64",
  double: "fp64",
  f64: "fp64",
  float32: "fp32",
  float: "fp32",
  f32: "fp32",
  single: "fp32",
  float16: "fp16",
  half: "fp16",
  f16: "fp16",
  bfloat16: "bf16",
  tf32: "tf32",
  float8_e4m3: "fp8_e4m3",
  float8_e4m3fn: "fp8_e4m3",
  float8_e4m3fnuz: "fp8_e4m3",
  fp8_e4m3fn: "fp8_e4m3",
  e4m3: "fp8_e4m3",
  float8_e5m2: "fp8_e5m2",
  float8_e5m2fnuz: "fp8_e5m2",
  fp8_e5m2fn: "fp8_e5m2",
  e5m2: "fp8_e5m2",
};

const VENDOR_PREFIX = /^(torch|aten|np|numpy|ml_dtypes|cupy)\./;

/** The leading token of a dtype string: `torch.bfloat16*` → `bfloat16`. */
export function dtypeToken(dtype: string): string {
  const text = dtype
    .trim()
    .toLowerCase()
    .replace(/^['"`]|['"`]$/g, "")
    .replace(VENDOR_PREFIX, "");
  const match = /^[a-z0-9_]+/.exec(text);
  return match ? match[0] : "";
}

export interface DtypeUnit {
  /** The table key this dtype resolves to, or null when it names no known unit. */
  key: string | null;
  /** ulp at 1.0. The fp32 fallback when `key` is null. */
  ulp: number;
  known: boolean;
}

/** The dtype's unit in the last place at 1.0, with the fallback made explicit. */
export function dtypeUnit(dtype: string): DtypeUnit {
  const token = dtypeToken(dtype);
  const key = DTYPE_ALIASES[token] ?? (Object.hasOwn(DTYPE_ULP, token) ? token : null);
  if (key === null) return { key: null, ulp: UNKNOWN_DTYPE_ULP, known: false };
  return { key, ulp: DTYPE_ULP[key], known: true };
}

/** `max(ulp(dtype), 2^-17)`: the part of the threshold the reference does not supply. */
export function precisionFloor(dtype: string): number {
  return Math.max(dtypeUnit(dtype).ulp, FLOOR_REL);
}

/** `K_RATIO * e_ref + max(ulp(dtype), 2^-17)`; refuse when `e_cand > this`. */
export function precisionThreshold(eRef: number, dtype: string): number {
  return K_RATIO * eRef + precisionFloor(dtype);
}

/** One comparable number: three significant digits, in one deterministic shape. */
export function formatPrecisionValue(value: number | null): string {
  if (value === null) return "unmeasured";
  if (!Number.isFinite(value)) return String(value);
  if (value === 0) return "0";
  return value.toExponential(3);
}

// --- .kernel/precision.tsv --------------------------------------------------

export interface PrecisionRow {
  cell: string;
  group: string;
  /** null when the row recorded `n/a`: the check printed no `max_diff`. */
  maxDiff: number | null;
  raw: string;
}

export interface PrecisionTable {
  rows: PrecisionRow[];
  /** Rows whose third field was neither a number nor `n/a`; kept out of the comparison. */
  problems: string[];
}

/**
 * `cell\tgroup\tmax_diff`, one row per cell x group, written by
 * `goal.checks.sh`. A `#` line is the header and is skipped; a row with `n/a`
 * or no readable third field is kept as a row with `maxDiff: null` so the
 * comparison can say "not evidence" instead of "zero".
 */
export function parsePrecisionTsv(text: string): PrecisionTable {
  const rows: PrecisionRow[] = [];
  const problems: string[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const fields = line.split("\t");
    if (fields.length < 3) {
      problems.push(`"${trimmed.slice(0, 60)}" is not a cell<TAB>group<TAB>max_diff row`);
      continue;
    }
    const cell = fields[0].trim();
    const group = fields[1].trim();
    const raw = fields[2].trim();
    if (cell === "") {
      problems.push(`"${trimmed.slice(0, 60)}" has no cell id`);
      continue;
    }
    const value = Number(raw);
    if (raw.toLowerCase() === "n/a" || raw === "") {
      rows.push({ cell, group: group === "" ? DEFAULT_GROUP : group, maxDiff: null, raw });
      continue;
    }
    if (!Number.isFinite(value) || value < 0) {
      problems.push(`row ${cell}/${group} has max_diff "${raw}", which is not a non-negative number; it is not compared`);
      rows.push({ cell, group: group === "" ? DEFAULT_GROUP : group, maxDiff: null, raw });
      continue;
    }
    rows.push({ cell, group: group === "" ? DEFAULT_GROUP : group, maxDiff: value, raw });
  }
  return { rows, problems };
}

// --- .kernel/calibration.json ----------------------------------------------

export interface CalibrationEntry {
  /** The dtype string as the contract wrote it. */
  dtype: string;
  /** The normalized table key, when this build knows the dtype. */
  key: string | null;
  /** The reference's own error; null when the calibration run printed no number. */
  maxDiff: number | null;
}

export type CalibrationOutcome =
  | { ok: true; entries: CalibrationEntry[]; problems: string[] }
  | { ok: false; reason: string };

/**
 * `{"schemaVersion":1,"contractSha":"…","entries":[{"dtype":"bf16","maxDiff":…}]}`,
 * written by `goal.checks.sh --calibrate`. A hand-written `{"dtypes":{"bf16":…}}`
 * map is accepted too: the file's job is to hold one number per dtype, and
 * refusing the readable form would send a human back to bash to write it.
 */
export function parseCalibrationJson(text: string): CalibrationOutcome {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { ok: false, reason: `${CALIBRATION_JSON_PATH} is not valid JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (parsed === null || typeof parsed !== "object") {
    return { ok: false, reason: `${CALIBRATION_JSON_PATH} must be a JSON object` };
  }
  const body = parsed as { entries?: unknown; dtypes?: unknown };
  const entries: CalibrationEntry[] = [];
  const problems: string[] = [];

  if (Array.isArray(body.entries)) {
    for (const [index, raw] of body.entries.entries()) {
      const entry = (raw ?? {}) as { dtype?: unknown; maxDiff?: unknown; max_diff?: unknown };
      const dtype = typeof entry.dtype === "string" ? entry.dtype.trim() : "";
      if (dtype === "") {
        problems.push(`entries[${index}] has no dtype`);
        continue;
      }
      const value = entry.maxDiff ?? entry.max_diff;
      entries.push(calibrationEntry(dtype, value, `entries[${index}] (${dtype})`, problems));
    }
    return { ok: true, entries, problems };
  }
  if (body.dtypes !== undefined && body.dtypes !== null && typeof body.dtypes === "object") {
    for (const [dtype, value] of Object.entries(body.dtypes as Record<string, unknown>)) {
      entries.push(calibrationEntry(dtype, value, `dtypes.${dtype}`, problems));
    }
    return { ok: true, entries, problems };
  }
  return {
    ok: false,
    reason: `${CALIBRATION_JSON_PATH} has neither an entries[] array nor a dtypes{} map; regenerate it with bash goal.checks.sh --calibrate`,
  };
}

function calibrationEntry(dtype: string, value: unknown, where: string, problems: string[]): CalibrationEntry {
  const unit = dtypeUnit(dtype);
  if (value === null || value === undefined) return { dtype, key: unit.key, maxDiff: null };
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number) || number < 0) {
    problems.push(`${where}: maxDiff ${JSON.stringify(value)} is not a non-negative number; this dtype stays unmeasured`);
    return { dtype, key: unit.key, maxDiff: null };
  }
  return { dtype, key: unit.key, maxDiff: number };
}

// --- the comparison ---------------------------------------------------------

/** What `candidates.ts` reads off disk; null means "the file is not there". */
export interface PrecisionEvidence {
  rows: PrecisionRow[] | null;
  calibration: CalibrationEntry[] | null;
  /** Why the calibration is missing or unusable, for the `unmeasured` message. */
  calibrationReason?: string | null;
}

/** One dtype's verdict: the numbers the refusal prints, not a boolean. */
export interface DtypePrecision {
  /** The dtype as the contract wrote it. */
  dtype: string;
  /** The table key, or null when the dtype names no known unit. */
  key: string | null;
  known: boolean;
  /** `max(ulp(dtype), 2^-17)`. */
  floor: number;
  /** The worst `max_diff` across the candidate's groups for this dtype. */
  eCand: number | null;
  /** The calibrated reference error for the same dtype. */
  eRef: number | null;
  /** `K_RATIO * eRef + floor`, or null when either side is unmeasured. */
  threshold: number | null;
  /** `eCand / eRef` when the reference error is above zero. */
  ratio: number | null;
  regressed: boolean;
  /** Rows compared. */
  groups: number;
  /** Rows recorded `n/a`. */
  skipped: number;
  /** Cell x group pairs with no row at all. */
  missing: number;
  /** The `cell/group` labels that produced `eCand`. */
  worst: string[];
}

export interface PrecisionComparison {
  /**
   * Whether the gate has anything to say: the contract named a
   * `calibrateCommand`, or a precision/calibration file exists. A task that
   * never wired precision is `armed: false` — the normal state of an existing
   * task, and legal — rather than "every candidate refused".
   */
  armed: boolean;
  dtypes: DtypePrecision[];
  /** Dtypes whose `e_cand` beat their threshold. */
  regressions: DtypePrecision[];
  /** Dtypes this rule cannot judge, with the reason it prints. */
  unmeasured: Array<{ dtype: string; reason: string }>;
  /** Dtypes that fell back to fp32's unit. */
  unknownDtypes: string[];
  /** `cell/group` rows recorded `n/a`. */
  skippedPairs: string[];
  /** `cell/group` pairs with no row; `cell-group-uncovered` owns a missing measurement. */
  missingPairs: string[];
  warnings: string[];
}

/**
 * The whole gate in one pure call: contract (dtype per cell, and whether the
 * task is armed) + the two files, out comes the per-dtype verdict.
 */
export function comparePrecision(input: { contract: KernelContract; evidence: PrecisionEvidence }): PrecisionComparison {
  const { contract, evidence } = input;
  const rows = evidence.rows ?? [];
  const warnings: string[] = [];
  const skippedPairs: string[] = [];
  const missingPairs: string[] = [];
  const unknownDtypes: string[] = [];
  const unmeasured: Array<{ dtype: string; reason: string }> = [];

  // Truthiness, not `!== null`: a contract written before `calibrateCommand`
  // existed carries no such key, and reading `undefined !== null` as armed would
  // refuse every keep in every existing workspace.
  const armed = Boolean(contract.calibrateCommand) || evidence.rows !== null || evidence.calibration !== null;

  const byPair = new Map<string, PrecisionRow>();
  for (const row of rows) byPair.set(pairKey(row.cell, row.group), row);

  interface Bucket {
    dtype: string;
    values: Array<{ group: string; value: number }>;
    skipped: number;
    missing: number;
  }
  const buckets = new Map<string, Bucket>();
  for (const cell of contract.cells) {
    let bucket = buckets.get(cell.dtype);
    if (!bucket) {
      bucket = { dtype: cell.dtype, values: [], skipped: 0, missing: 0 };
      buckets.set(cell.dtype, bucket);
    }
    const names = cell.groups.length > 0 ? cell.groups.map((group) => group.name) : [DEFAULT_GROUP];
    for (const name of names) {
      const row = byPair.get(pairKey(cell.id, name));
      const label = `${cell.id}/${name}`;
      if (!row) {
        bucket.missing += 1;
        missingPairs.push(label);
        continue;
      }
      if (row.maxDiff === null) {
        bucket.skipped += 1;
        skippedPairs.push(label);
        continue;
      }
      bucket.values.push({ group: label, value: row.maxDiff });
    }
  }

  const dtypes: DtypePrecision[] = [];
  for (const bucket of buckets.values()) {
    const unit = dtypeUnit(bucket.dtype);
    const floor = Math.max(unit.ulp, FLOOR_REL);
    if (!unit.known) {
      unknownDtypes.push(bucket.dtype);
      warnings.push(
        `dtype "${bucket.dtype}" names no unit in the last place this build knows (${KNOWN_DTYPES.join(", ")}); its floor is fp32's 2^-23 = ${formatPrecisionValue(UNKNOWN_DTYPE_ULP)}, which is strict — add the dtype to the table rather than living with the fallback`,
      );
    }

    let eCand: number | null = null;
    let worst: string[] = [];
    if (bucket.values.length > 0) {
      eCand = bucket.values.reduce((max, entry) => Math.max(max, entry.value), 0);
      worst = bucket.values.filter((entry) => entry.value === eCand).map((entry) => entry.group);
    }
    const ref = lookupCalibration(evidence.calibration, bucket.dtype);
    const eRef = ref.maxDiff;
    const threshold = eCand !== null && eRef !== null ? K_RATIO * eRef + floor : null;
    const regressed = eCand !== null && threshold !== null && eCand > threshold;

    dtypes.push({
      dtype: bucket.dtype,
      key: unit.key,
      known: unit.known,
      floor,
      eCand,
      eRef,
      threshold,
      ratio: eCand !== null && eRef !== null && eRef > 0 ? eCand / eRef : null,
      regressed,
      groups: bucket.values.length,
      skipped: bucket.skipped,
      missing: bucket.missing,
      worst,
    });

    if (!armed) continue;
    if (eCand === null) {
      const silence =
        evidence.rows === null
          ? `${PRECISION_TSV_PATH} does not exist — no run recorded a max_diff for this dtype`
          : `${PRECISION_TSV_PATH} holds no number for this dtype (${bucket.skipped + bucket.missing} group(s) recorded n/a or not at all)`;
      unmeasured.push({ dtype: bucket.dtype, reason: silence });
      continue;
    }
    if (eRef === null) {
      unmeasured.push({
        dtype: bucket.dtype,
        reason:
          ref.reason ??
          `${CALIBRATION_JSON_PATH} has no usable entry for this dtype, so the reference's own error — the ruler — was never measured`,
      });
    }
  }

  if (skippedPairs.length > 0) {
    warnings.push(
      `${skippedPairs.length} cell/group row(s) recorded n/a (${capped(skippedPairs)}): the check printed no max_diff, so they are not compared — a non-numeric check is not evidence of precision`,
    );
  }

  return {
    armed,
    dtypes,
    regressions: dtypes.filter((entry) => entry.regressed),
    unmeasured,
    unknownDtypes,
    skippedPairs,
    missingPairs,
    warnings,
  };
}

/** Exact dtype first, then the normalized key: a hand-written file may say `bfloat16`. */
function lookupCalibration(
  entries: CalibrationEntry[] | null,
  dtype: string,
): { maxDiff: number | null; reason: string | null } {
  if (entries === null) {
    return { maxDiff: null, reason: `${CALIBRATION_JSON_PATH} does not exist — run bash goal.checks.sh --calibrate so the reference's own error is recorded per dtype` };
  }
  const exact = entries.find((entry) => entry.dtype === dtype);
  if (exact) return { maxDiff: exact.maxDiff, reason: null };
  const unit = dtypeUnit(dtype);
  if (unit.key !== null) {
    const aliased = entries.find((entry) => entry.key === unit.key);
    if (aliased) return { maxDiff: aliased.maxDiff, reason: null };
  }
  return {
    maxDiff: null,
    reason: `${CALIBRATION_JSON_PATH} has no entry for dtype "${dtype}" (it holds ${entries.length === 0 ? "no entries" : [...new Set(entries.map((entry) => entry.dtype))].join(", ")}), so the reference's own error — the ruler — was never measured`,
  };
}

function pairKey(cell: string, group: string): string {
  return `${cell}\u0000${group}`;
}

function capped(values: string[], limit = 8): string {
  const shown = values.slice(0, limit).join(", ");
  return values.length <= limit ? shown : `${shown} and ${values.length - limit} more`;
}
