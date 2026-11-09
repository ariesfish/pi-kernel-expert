/**
 * The refusals `kernel_candidate` applies to a keep.
 *
 * Each one answers a different question about the same number: *is it a
 * measurement of the kernel?* (basis, host path), *is it a measurement of a
 * change the apparatus allowed?* (harness), *is it a measurement of the whole
 * claim?* (cell x group), *is it the same number the reading printed?*
 * (metric-not-in-reading), *is it precise enough to be the same algorithm?*
 * (precision) and *is it a measurement of this code?* (profile).
 *
 * Two properties are deliberate:
 *
 * - **A refusal names the rule, the side it is charged to, and the fix.** The
 *   side matters: a fat host path and a missing clock are defects of the *run*
 *   (re-run it), an edited harness, an imprecise kernel and a stale profile are
 *   defects of the *candidate* (fix the change). Only the run-side ones may be
 *   forced — a human can accept a noisy run, but not a measurement taken
 *   through an apparatus the candidate edited.
 * - **Every function is pure.** It takes the numbers and paths it judges, never
 *   a workspace, so the same rules are unit-testable without a git repo and the
 *   recorder cannot accidentally ask the rules to go and measure something.
 *
 * Absent evidence is a refusal, never a pass: `unmeasured` fires `host-bound`
 * exactly like `host_bound` does, with a different fix.
 */
import { BASIS_VALUES, cellMetricName, DEFAULT_GROUP, type KernelContract } from "./contract.ts";
import { formatPrecisionValue, type PrecisionComparison } from "./precision.ts";

export const RULE_IDS = [
  "basis-missing",
  "host-bound",
  "harness-touched",
  "cell-group-uncovered",
  "reading-contract-mismatch",
  "metric-not-in-reading",
  "precision-regression",
  "profile-stale",
] as const;

export type RuleId = (typeof RULE_IDS)[number];

/** Who owns the defect: the run that produced the reading, or the candidate's change. */
export type ChargedTo = "run" | "candidate";

export interface Refusal {
  rule: RuleId;
  charged: ChargedTo;
  /** One line that starts with the rule id and the side it is charged to. */
  message: string;
  /** What the caller does next; never "try again". */
  fix: string;
  /**
   * Per-instance override of `isForceable(rule)`. `precision-regression` uses
   * it: with no calibration the ruler itself is missing (a run-side defect a
   * human may accept once), but a *measured* precision regression is the
   * candidate's arithmetic and is never forced — that is the whole gate.
   */
  forceable?: boolean;
}

/**
 * `forceWithReason` bypasses a run-level defect only. `harness-touched` and
 * `profile-stale` are not forceable: forcing them would let the candidate edit
 * the thing that judges it, or keep a candidate the profile never saw.
 * `precision-regression` is not here: it decides per instance (see
 * `Refusal.forceable`), because only its `unmeasured` form is a defect of the run.
 */
export const FORCEABLE_RULES: readonly RuleId[] = ["basis-missing", "host-bound", "cell-group-uncovered"];

export function isForceable(rule: RuleId): boolean {
  return FORCEABLE_RULES.includes(rule);
}

/** The rule level default, overridden by the instance when it says so. */
export function isRefusalForceable(entry: Refusal): boolean {
  return entry.forceable ?? isForceable(entry.rule);
}

/** The four causes a host-bound reading is diagnosed with, in the order to check them. */
export const HOST_CAUSES =
  "recompile/JIT per call, python-side allocation, extra launches, synchronize inside the call";

/** How many `cell/group` pairs a refusal prints before it summarises the rest. */
export const PAIR_CAP = 8;

/** The reading, as much of it as the rules read. Structural, so a fixture needs no parser. */
export interface ReadingView {
  contractSha?: string | null;
  basis?: string | null;
  hostBoundRatio?: number | null;
  hostBoundVerdict?: string | null;
  hostBoundReason?: string | null;
  /** Written by T-006; absent on a reading from a contract with no referenceCommand. */
  pairing?: string | null;
  cells?: ReadonlyArray<{ id?: string | null; group?: string | null; median?: number | null }>;
}

export interface ProfileStaleness {
  runId: string;
  problem: "diff" | "contract";
  measuredDiff?: string;
  currentDiff?: string;
  measuredContract?: string;
  currentContract?: string;
}

export interface RefusalContext {
  contract: KernelContract;
  /** The contract file's current sha, to bind the reading to this task. */
  contractSha?: string | null;
  /** `null` when the ledger holds no usable reading at all. */
  reading: ReadingView | null;
  /** Why there is no reading: the parser's reason, or "none was supplied". */
  readingReason?: string | null;
  /** `diffFingerprint().changedFiles` — the candidate's own diff. */
  changedFiles: readonly string[];
  /** The `METRIC` names the run printed, including one aggregate per cell. */
  metrics: Record<string, number>;
  /** The precision gate's verdict over `.kernel/precision.tsv` and `calibration.json`. */
  precision?: PrecisionComparison | null;
  profile?: ProfileStaleness | null;
}

function refusal(rule: RuleId, charged: ChargedTo, body: string, fix: string, forceable?: boolean): Refusal {
  const entry: Refusal = { rule, charged, message: `${rule} (charged to the ${charged}): ${body}`, fix };
  if (forceable !== undefined) entry.forceable = forceable;
  return entry;
}

function short(sha: string | undefined): string {
  return sha ? sha.slice(0, 12) : "(unknown)";
}

/** 1. No basis, no claim: the reading is missing, unusable, or says nothing about what it timed. */
export function basisMissing(ctx: RefusalContext): Refusal | null {
  const fix = "re-run goal.sh on a build that emits a reading block";
  if (ctx.reading === null) {
    const why = ctx.readingReason?.trim() ? ` (${ctx.readingReason.trim()})` : "";
    return refusal(
      "basis-missing",
      "run",
      `the ledger has no reading, so the keep rests on numbers nobody recorded${why}`,
      fix,
    );
  }
  if (!(BASIS_VALUES as readonly unknown[]).includes(ctx.reading.basis)) {
    return refusal(
      "basis-missing",
      "run",
      `the reading carries no basis (got ${JSON.stringify(ctx.reading.basis ?? null)}), so nothing in it says whether the number is the kernel's device time or the whole host-to-device call`,
      fix,
    );
  }
  return null;
}

/**
 * 2. The host path is fat. On a plain basis this is the candidate's defect and
 * the message teaches the four causes; `unmeasured` is the run's defect, because
 * the bench never printed the clock the ratio needs.
 */
export function hostBound(ctx: RefusalContext): Refusal | null {
  if (ctx.reading === null) return null;
  const verdict = ctx.reading.hostBoundVerdict ?? "unmeasured";
  const basis = typeof ctx.reading.basis === "string" ? ctx.reading.basis : "plain";

  if (verdict === "host_bound") {
    const ratio = ctx.reading.hostBoundRatio;
    const shown =
      typeof ratio === "number" && Number.isFinite(ratio)
        ? `hostBoundRatio ${ratio}`
        : "hostBoundRatio at or above 0.5";
    return refusal(
      "host-bound",
      "candidate",
      `${shown} on a ${basis} basis: the timed window is mostly the host path, so this speedup measures dispatch, not the kernel. Check the four host causes, in order: ${HOST_CAUSES}.`,
      "thin the host path — build the arguments and outputs once, launch once, and drop any synchronize inside the timed call — then re-run goal.sh; the same kernel behind a thinner host path is the number to keep",
    );
  }
  if (verdict === "unmeasured") {
    const why = ctx.reading.hostBoundReason?.trim() ? `: ${ctx.reading.hostBoundReason.trim()}` : "";
    return refusal(
      "host-bound",
      "run",
      `hostBoundVerdict is "unmeasured"${why}; an unmeasured host share is not a pass, so the keep cannot rest on this reading`,
      "make the bench print METRIC device_ms= and METRIC host_enqueue_ms= next to its number, then re-run goal.sh so the ratio exists",
    );
  }
  return null;
}

/** 3. The diff edits the apparatus. A candidate may not move the ruler. */
export function harnessTouched(ctx: RefusalContext): Refusal | null {
  const matched = [...new Set(ctx.changedFiles.filter((file) => ctx.contract.harnessGlobs.some((glob) => harnessGlobMatches(glob, file))))].sort();
  if (matched.length === 0) return null;
  const subject = matched.length === 1 ? "file" : "files";
  return refusal(
    "harness-touched",
    "candidate",
    `the diff edits harness ${subject} ${matched.join(", ")}, protected by harnessGlobs (${ctx.contract.harnessGlobs.join(", ")}); a change to the apparatus invalidates every number the apparatus took.`,
    `revert ${matched.length === 1 ? "that path" : "those paths"} (git checkout HEAD -- ${matched.join(" ")}) and keep the change in the kernel. A harness that genuinely must change is a new contract, not a candidate`,
  );
}

/**
 * 4. The matrix is the claim. A cell x group with no reading entry, or a cell
 * with no aggregate `METRIC <metric>_<cellId>`, was never measured.
 *
 * A cell with no groups is measured as `default`: that is what the generated
 * scripts export for a boundary probe, and expecting the empty string here would
 * refuse every boundary cell.
 */
export function cellGroupUncovered(ctx: RefusalContext): Refusal | null {
  const measured = new Set<string>();
  for (const cell of ctx.reading?.cells ?? []) {
    if (typeof cell.id !== "string" || cell.id === "") continue;
    measured.add(pairKey(cell.id, cell.group));
  }

  const missingPairs: string[] = [];
  for (const cell of ctx.contract.cells) {
    const groups = cell.groups.length > 0 ? cell.groups.map((group) => group.name) : [DEFAULT_GROUP];
    for (const group of groups) {
      if (!measured.has(pairKey(cell.id, group))) missingPairs.push(`${cell.id}/${group}`);
    }
  }

  const missingAggregates = ctx.contract.cells
    .filter((cell) => ctx.metrics[cellMetricName(ctx.contract, cell)] === undefined)
    .map((cell) => `${cell.id} (METRIC ${cellMetricName(ctx.contract, cell)})`);

  if (missingPairs.length === 0 && missingAggregates.length === 0) return null;

  const parts: string[] = [];
  if (missingPairs.length > 0) {
    parts.push(`${missingPairs.length} cell/group pair(s) have no reading entry: ${capped(missingPairs)}`);
  }
  if (missingAggregates.length > 0) {
    parts.push(`${missingAggregates.length} cell(s) carry no aggregate: ${capped(missingAggregates)}`);
  }

  return refusal(
    "cell-group-uncovered",
    "run",
    `${parts.join("; ")} — the matrix is the claim, and a cell or group with no entry was never judged.`,
    "re-run goal.sh so every cell x group is measured (it exports KERNEL_GROUP per group) and every cell prints its aggregate METRIC line; a cell you did not measure cannot be kept on",
  );
}

/**
 * 5. The reading was taken under another contract. A number measured against a
 * different matrix, tolerance, or target is not evidence for this one, and the
 * arithmetic cannot be reconciled by adding a force reason.
 */
export function readingContractMismatch(ctx: RefusalContext): Refusal | null {
  const measured = ctx.reading?.contractSha;
  const current = ctx.contractSha;
  if (!measured || !current) return null;
  if (measured === current) return null;
  return refusal(
    "reading-contract-mismatch",
    "run",
    `the reading was taken under contract ${short(measured)}, this task is ${short(current)}; the numbers describe a different matrix or tolerance`,
    "re-run goal.sh under the current contract and pass that reading; a contract change invalidates every earlier reading",
  );
}

/**
 * 6. The claimed cell aggregate is not what the reading's own groups say. The
 * recorder does the arithmetic instead of trusting the caller: a metric typed
 * into `metrics` that no measurement produced is the exact failure a ledger
 * exists to prevent. Compared to 1e-6 relative because both sides are printed
 * at %.10g.
 */
export function metricNotInReading(ctx: RefusalContext): Refusal | null {
  const cells = ctx.reading?.cells;
  if (!cells || cells.length === 0) return null;

  const byCell = new Map<string, number[]>();
  for (const cell of cells) {
    if (typeof cell.id !== "string" || cell.id === "") continue;
    if (typeof cell.median !== "number" || !Number.isFinite(cell.median) || cell.median <= 0) continue;
    const values = byCell.get(cell.id) ?? [];
    values.push(cell.median);
    byCell.set(cell.id, values);
  }

  const mismatches: string[] = [];
  for (const cell of ctx.contract.cells) {
    const values = byCell.get(cell.id);
    if (!values || values.length === 0) continue; // rule 4 owns a missing cell
    const derived = Math.exp(values.reduce((sum, value) => sum + Math.log(value), 0) / values.length);
    const claimed = ctx.metrics[cellMetricName(ctx.contract, cell)];
    if (claimed === undefined) continue; // rule 4 owns a missing aggregate
    const relative = Math.abs(claimed - derived) / derived;
    if (relative > 1e-6) {
      mismatches.push(`${cell.id}: claimed ${claimed}, the reading's ${values.length} group(s) give ${Number(derived.toPrecision(10))}`);
    }
  }

  if (mismatches.length === 0) return null;
  return refusal(
    "metric-not-in-reading",
    "candidate",
    `the claimed cell value does not match the reading's own groups — ${capped(mismatches)}. A number that no measurement produced cannot be promoted.`,
    "record the METRIC line goal.sh printed, or fix the aggregation; the per-cell value is the geomean of that cell's group medians",
  );
}

/**
 * 7. The candidate is less precise than the reference, in the way a tolerance
 * cannot see: `e_cand > 3 * e_ref + max(ulp(dtype), 2^-17)`. A kernel that is
 * green to `rtol` and 4x the reference's own error is a different algorithm
 * wearing the same test result.
 *
 * Two shapes of the same rule:
 *
 * - **measured regression** — the numbers exist and the candidate lost. Not
 *   forceable: the gate's whole point is that a human cannot wave this through.
 * - **unmeasured** — no calibration, so the reference's own error (the ruler)
 *   was never measured. Forceable once, with the reason recorded: defaulting
 *   `e_ref` to 0 would instead refuse every candidate and teach nothing.
 */
export function precisionRegression(ctx: RefusalContext): Refusal | null {
  const comparison = ctx.precision;
  if (!comparison || !comparison.armed) return null;
  const { regressions, unmeasured, skippedPairs, unknownDtypes } = comparison;
  if (regressions.length === 0 && unmeasured.length === 0) return null;

  const parts: string[] = [];
  for (const entry of regressions) {
    const floorFrom = entry.known ? `ulp(${entry.key})` : `fp32's 2^-23, the dtype is unknown`;
    const ratio = entry.ratio === null ? "" : `; ${entry.ratio.toFixed(2)}x the reference's own error`;
    const worst = entry.worst.length > 0 ? ` (worst group(s) ${capped(entry.worst)})` : "";
    parts.push(
      `dtype ${entry.dtype}: e_cand ${formatPrecisionValue(entry.eCand)} > threshold ${formatPrecisionValue(entry.threshold)} = 3 * e_ref ${formatPrecisionValue(entry.eRef)} + floor ${formatPrecisionValue(entry.floor)} (max(${floorFrom}, 2^-17))${ratio}${worst}`,
    );
  }
  for (const entry of unmeasured) {
    parts.push(`dtype ${entry.dtype}: e_ref is unmeasured — ${entry.reason}`);
  }
  if (skippedPairs.length > 0) {
    parts.push(
      `${skippedPairs.length} cell/group row(s) recorded n/a and were not compared (${capped(skippedPairs)}) — a non-numeric check is not evidence of precision`,
    );
  }
  if (unknownDtypes.length > 0) {
    parts.push(
      `dtype(s) ${unknownDtypes.join(", ")} name no unit in the last place this build knows, so their floor is fp32's 2^-23 = ${formatPrecisionValue(2 ** -23)}`,
    );
  }

  if (regressions.length > 0) {
    return refusal(
      "precision-regression",
      "candidate",
      `${parts.join("; ")}. The reference's own error is the ruler: past this threshold the candidate is not the same algorithm at a different speed.`,
      "bring max_diff back under 3x the reference's by computing the way the reference does — accumulate in fp32, keep its upcast, drop a lossy fast path — then re-run goal.checks.sh; a candidate that is 4x the reference's error is a different result, not a faster one",
      false,
    );
  }
  return refusal(
    "precision-regression",
    "candidate",
    `${parts.join("; ")}. With no ruler there is no verdict, and an unmeasured reference is not a pass.`,
    "run bash goal.checks.sh --calibrate so .kernel/calibration.json records the reference's own max_diff per dtype, then re-run the checks; force_with_reason accepts an unmeasured reference once, and the ledger records that it was forced",
    true,
  );
}

/** 8. The profile is older than the tree it is cited for. */
export function profileStale(ctx: RefusalContext): Refusal | null {
  const profile = ctx.profile;
  if (!profile) return null;
  if (profile.problem === "contract") {
    return refusal(
      "profile-stale",
      "candidate",
      `profile ${profile.runId} was taken under contract ${short(profile.measuredContract ?? undefined)}, current is ${short(profile.currentContract ?? undefined)}; the metrics describe a different task`,
      "re-profile the current contract and cite that run, or drop the bottleneck claim",
    );
  }
  return refusal(
    "profile-stale",
    "candidate",
    `profile ${profile.runId} is stale: it measured diff ${short(profile.measuredDiff)}, the tree is now ${short(profile.currentDiff)} — the profile and the keep are not the same code`,
    "re-profile the tree you are keeping and pass that profile_run; a profile of another tree is not evidence for this one",
  );
}

/**
 * All of them, in rule order, then refuse once. A keep with three problems says
 * three, because fixing one and re-running to discover the next is how a loop
 * spends an hour learning nothing.
 */
export function collectRefusals(ctx: RefusalContext): Refusal[] {
  return [
    basisMissing,
    hostBound,
    harnessTouched,
    cellGroupUncovered,
    readingContractMismatch,
    metricNotInReading,
    precisionRegression,
    profileStale,
  ]
    .map((rule) => rule(ctx))
    .filter((entry): entry is Refusal => entry !== null);
}

/** One printable line per refusal: rule, side, message, fix. */
export function formatRefusal(entry: Refusal): string {
  return `${entry.message} Fix: ${entry.fix}`;
}

/** The blocking subset under `forceWithReason`, plus the rules the force bypassed. */
export function applyForce(
  refusals: Refusal[],
  forceReason: string | null | undefined,
): { blocking: Refusal[]; forcedRules: RuleId[] } {
  if (!forceReason?.trim()) return { blocking: refusals, forcedRules: [] };
  return {
    blocking: refusals.filter((entry) => !isRefusalForceable(entry)),
    forcedRules: refusals.filter((entry) => isRefusalForceable(entry)).map((entry) => entry.rule),
  };
}

function pairKey(id: string, group: string | null | undefined): string {
  return `${id}\u0000${group ?? DEFAULT_GROUP}`;
}

function capped(values: string[]): string {
  const shown = values.slice(0, PAIR_CAP).join(", ");
  if (values.length <= PAIR_CAP) return shown;
  return `${shown} and ${values.length - PAIR_CAP} more`;
}

/**
 * Enough glob for harness paths: `*`, `?`, and `**`. `contract.ts` has the same
 * matcher but keeps it private; a harness path that matched one and not the
 * other would be worse than the duplication.
 */
export function harnessGlobMatches(glob: string, relativePath: string): boolean {
  return globToRegExp(glob.replace(/^\.\//, "")).test(relativePath.replace(/^\.\//, ""));
}

function globToRegExp(glob: string): RegExp {
  let source = "";
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index];
    if (char === "*") {
      if (glob[index + 1] === "*") {
        index += 1;
        if (glob[index + 1] === "/") {
          index += 1;
          source += "(?:.*/)?";
        } else {
          source += ".*";
        }
      } else {
        source += "[^/]*";
      }
      continue;
    }
    if (char === "?") {
      source += "[^/]";
      continue;
    }
    source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${source}$`);
}
