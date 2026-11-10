# Spec: feature-kernel-expert-v2 / `evidence`

Module `evidence` of the capability map at `map.md`. Everything here answers one question: **is the
number in the ledger a measurement of the kernel?**

## Objective

A user running `kernel_flow` on a real GPU must be able to trust three things without auditing the
harness: the time recorded is the kernel's time and not Python dispatch, the number it is compared to
was taken the same way on the same machine, and correctness held across data distributions and not
just shapes. Today none of the three is enforceable — the contract has no field to record any of them.

Success: a deliberately bad benchmark (a 2 ms sleep on the host inside every timed call) is **refused
by name**, and a kernel that is correct on a typical input but wrong on a masked/degenerate one fails
the matrix.

## Implementation Decisions

- **The contract is the place the facts live.** `kernel.contract.json` gains `basis`
  (`device` | `e2e`), `harnessGlobs[]`, `cells[].groups[]`, and an optional `referenceCommand`. A
  contract written by an older version is refused with "regenerate" rather than silently upgraded —
  one schema version, one refusal, no migration code.
- **`goal.sh` emits one machine-readable reading block** (`=== KERNEL READING ===` + JSON +
  `=== END ===`) carrying: basis, GPU identity, SM/mem clocks at start and end, utilisation and other
  processes' memory at start, `hostEnqueueMs`, `deviceMs`, `hostBoundRatio`, per-cell per-group
  medians and spread, and the run's `CUDA_VISIBLE_DEVICES`. Absent fields are absent, never zero.
- **Host-bound is a precondition with three states, not a boolean.** `hostBoundRatio ≥ 0.5` on a
  plain basis is host-bound; a host-free basis (`cuda_graph`, `cupti_kernel_span`) is exempt; a reading
  with no enqueue clock is `unmeasured`. `kernel_candidate` refuses a keep whose basis is missing or
  whose verdict is host-bound. A refusal names the four host causes, so it teaches rather than blocks.
- **Pairing is opt-in by the task, mandatory by the gate.** When `referenceCommand` is present,
  `goal.sh` does 4 s burn-in with the kernel under test, then `ref, kernel, kernel, ref`, each side the
  mean of its two device readings, and reports a same-job ratio. When a paired ratio exists,
  `kernel_candidate` refuses a claim that rests on the cross-run baseline instead. When it does not
  exist, the record says `pairing: "absent"` and a cross-run ratio is still allowed — loudly labelled,
  because a missing reference is the normal state of an existing task, not a defect.
- **Input groups are structural.** Every non-boundary cell carries ≥3 groups (`name`, `intent`,
  `seed`), exported as `KERNEL_GROUP`; `goal.checks.sh` and `goal.sh` iterate cells × groups. A group
  with no `intent` is a contract error, not a warning.
- **Precision is a second judge.** The task's check command prints `max_diff`; a calibration run
  records the reference's own error per dtype; a keep is refused when
  `e_cand > 3·e_ref + max(ulp(dtype), 2^-17)`. This catches the class a tolerance cannot: right to
  `rtol`, wrong in a way the reference is not.
- **Harness paths are frozen, and the contract names them.** pi-goal already protects `goal.sh` /
  `goal.checks.sh` in sealed mode, intercepts shell writes, and enforces `scope_globs` / `test_globs`
  — that is the primary enforcement and it stays. What is missing is the *naming*: `scopeGlobs` is
  optional and defaults to the whole repo, so the task's comparator and bench harness are writable by
  default. The contract gains `harnessGlobs` (default: the comparator, the bench harness, the check
  runner) and `kernel_candidate` re-checks the diff's own `changedFiles` against it — a second, cheap
  check, not the first line of defence.
- **Archive provenance beats convenience.** A baseline is keyed by (op, shape, arch/cluster, basis,
  workload set, contract sha) in `.kernel/baselines/<key>.json`; a comparison whose provenance does not
  match is refused, not softened. `.kernel/baseline.tsv` stays as the human-readable view.
- **The extension records GPU state; it never writes it.** Every reading carries GPU identity, SM/mem
  clocks at start and end, utilisation, and the memory of other processes on the same card. A timing
  run requires an **exclusive card** (no foreign compute process); otherwise the reading is
  `contended: true` and may not support a promotion claim. Clock locking is the operator's action: when
  a run is locked, the reading carries `clockLocked: true` and the locked values, and it is comparable
  only to another locked reading.
- **Verification is on `h200-7` via `ssh builder`** (`hardware.md`), with a toolchain bootstrap ticket
  first. All timing acceptance runs happen on an exclusive card; if none is free, the ticket stays
  open and says so — an inconclusive environment is not a pass.

## Out of Scope

- The `plan` module (decision graph, typed gate lines, reviewer diagnosis) — separate spec.
- The `instruments` module (static SASS skills, KB container) — separate spec.
- Clock locking, GPU job transport, ssh job dispatch, depreciation of multi-run concurrency.
- The deny list / sealed reference / blackbox mode (research `SKIP`).
- Leaderboard submission, self-evolution, lever pricing.

## Acceptance Criteria

- [check: `npm test` and `npm run typecheck` in `pi-kernel-expert`] — new tests cover: contract
  refuses a v1 contract and a group without `intent`; `kernel_candidate` refuses the four cases
  (no basis, host-bound, harness diff, missing cell×group); the reading-block parser round-trips a
  fixture with absent fields.
- [evidence: a run on an exclusive card of `h200-7` whose `benchmarkCommand` sleeps 2 ms on the host,
  recorded in `docs/verify.md` with the reading block and the refusal text] — proves the host-bound
  precondition fires on a real GPU with a real clock reading.
- [evidence: a timing run of the same kernel on an idle card twice, once unlocked and once with the
  operator's clock lock, each reading carrying its clocks and `clockLocked`] — proves the provenance
  rule separates a locked reading from an unlocked one.
- [evidence: a run of the same kernel with `referenceCommand` set, whose reading block carries
  `pairing: "mirrored"`, ≥2 ratios and a spread ≤5%] — proves same-job pairing works end to end.
- [evidence: a matrix run where the kernel is correct on group `typical` and wrong on group
  `zero_block`, with `goal.checks.sh` failing on the second and the candidate refused] — proves input
  groups are iterated and judged.
- [check: a contract whose `harnessGlobs` matches a file in the diff is refused by
  `kernel_candidate`, with the matched path named] — a fixture test plus one live run.
- [judgment: the user] — that the refusal messages are actionable enough to fix without reading the
  source (this is the one criterion code cannot settle).

## Ask First

- **Installing a toolchain on `builder`** (`uv` venv + torch cu13, ~3 GB) — a state change on the node.
- **Clock locking** (`nvidia-smi -lgc`) — now legitimate because the machine is ours, but it changes
  what a reading means: default is unlocked, and a locked run must record the lock and stay comparable
  only to locked runs.
- **Contract schema break** (v1 → v2, existing workspaces must regenerate) — a compatibility call.
- **Choosing a GPU** on a node where all eight are at 100% — which card, and whether to wait for the
  tenant job to end.
- Any change to the four refusal rules once a real run disagrees with them (the rules are the spec;
  softening one is a spec change, not a bug fix).

## Open Questions + Assumptions

Assumptions:

1. The whole 8-card machine is available for this work (confirmed by the user, 2026-11-09). A card is
   still claimed explicitly (`CUDA_VISIBLE_DEVICES`) and its state recorded; "available" does not mean
   "two runs may share a card".
2. sm_90 is the verification target (ADR 0003); Blackwell stays unverified in this module.
3. The extension keeps owning no loop: `goal.sh` still runs inside pi-goal, and the new reading block
   is a file, not a new phase.
4. Breaking the contract schema is acceptable at 0.x; the alternative — migrating old workspaces — is
   more code than regenerating them.

Open questions:

1. The honest bench on real hardware read `hostBoundRatio 0.4600` — 4% under the 0.5 threshold — for a
   4.5 µs kernel with a 2 µs enqueue path. The threshold is ForgeKernel's, calibrated on kernels three
   orders of magnitude larger. Recommendation: make it a contract field (`hostBoundRatio`, default
   0.5) so a µs-scale task can set 0.9 without weakening the rule for everyone; do not tune the
   default off one card. `runs/T-003/README.md` carries the reading.

1. Which card is the standing verification card, and may the bootstrap own a venv at `~/pkex-venv`?
2. Is `sudo` on `builder` ours, i.e. may a ticket run `nvidia-smi -lgc/-rgc` when the operator asks for
   a locked comparison?
3. `referenceCommand` — should it be a shell command (like `benchmarkCommand`) or a path+symbol
   (like pi's `cmd`)? Shell is simpler; a symbol avoids quoting bugs. Default: shell, same contract
   shape as the other two commands.
4. Where do archived baselines live — in the task repo (`.kernel/baselines/`, travels with the task) or
   in the user's agent dir (shared across tasks)? Default: the task repo, because a baseline is a
   property of the operator.

## Closure (2026-11-10)

All nine tickets closed; live evidence on `h200-7` card 3 for T-003, T-005, T-006, T-007, T-008,
T-009 (`runs/T-00*/`, summarised in the repo's `docs/verify.md`). The module ships at 216 tests.

Three things this module did **not** settle, carried into the next module:

- the host-bound threshold's fitness for µs-scale kernels (see Open Questions);
- the per-cell aggregate is a geomean over groups, and the cross-run baseline stores only that
  aggregate — a per-group baseline would catch a regression masked by the aggregate;
- a `pairing: "inadmissible"` reading is recorded but no rule refuses a keep that *also* lacks a
  usable cross-run baseline: today that keep would rest on nothing. It is a `plan`-module question
  because the answer is "which comparison is this decision allowed to rest on".
