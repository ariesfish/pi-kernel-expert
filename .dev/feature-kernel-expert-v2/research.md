# Research: ForgeKernel vs pi-kernel-expert — gaps and transferable mechanisms

Question: `pi-kernel-expert` (pi extension, TS, 0.4.0) and `ForgeKernel` (Python harness, self-evolving
kernel agent) both claim to make an agent write fast GPU kernels. Which mechanisms does ForgeKernel
have that pi-kernel-expert lacks, and which of them are worth porting into a pi extension?

Scope:
- A = `/Users/ariesfish/Projects/github/dev-skills/pi-kernel-expert` (extension source, kernel-flow
  skill, ADRs, CONTEXT.md) — 10 579 LOC
- B = `/Users/ariesfish/Projects/github/dev-skills/ForgeKernel` (Python harness + skills + hw_kb +
  meta prompts + docs) — 181 645 LOC
- Out of scope: re-benchmarking either system; GPU verification (no GPU on this machine).

Method: five parallel readers against primary sources, one note per cluster
(`notes/loop.md`, `notes/measure.md`, `notes/kb.md`, `notes/skills.md`, `notes/method.md`), then this
synthesis. Every claim below carries a file:line in the cluster note it came from.

## Findings

### Verdict

They are not the same product at different quality. They own different layers.

| Layer | pi-kernel-expert | ForgeKernel |
|---|---|---|
| What is fixed | **acceptance**: shape matrix, tolerance, metric, guard, noise floor, evidence freshness | **path**: a walkable decision graph (M0 architecture → Mk levers) plus acceptance |
| Who measures | the task's `benchmark_command`; the extension never sees the numbers' provenance | the harness owns the GPU job: windows, pairing, clock, launches, profiler |
| What is recorded | a candidate ledger keyed by diff hash | iteration/meta ledgers keyed by decision id, sha, cluster |
| What the agent knows | a pinned upstream corpus (KernelWiki) + a vendored ncu playbook | a probe-certified, per-arch KB with symptom index and measured prices |
| Loop | delegated to pi-goal; one level (candidate → gate → keep/revert) | two levels (student edits kernel, teacher edits the plan) |

So "porting ForgeKernel" is not the move. The move is to port ~6 invariants and 1 toolkit that sit
above pi-goal's gate, and to refuse the ~90% of ForgeKernel that exists to run an unattended
multi-hour loop on someone else's GPU.

### The gap inventory

Cost = rough person-days for a pi-native port. "P" = portable as an invariant, "R" = re-derive the
contract but not the code, "S" = skip (infra / different product).

**A. Measurement validity — the sharpest gap, because it invalidates claims rather than slowing work**

| # | Capability | A today | B mechanism | Verdict | Cost |
|---|---|---|---|---|---|
| A1 | Timed-window basis + host-bound precondition | `benchmark_command` prints one number; no basis field, no enqueue/device ratio, no "unmeasured" state | `e2e` vs `device` windows, `host_enqueue_ms/device_median_ms` ratio, host-bound at ≥0.5, tri-state `measured` (`timing_audit.py:60-131`) | **P** | 0.5–1d |
| A2 | Paired same-job measurement | ratio vs `.kernel/baseline.tsv` recorded in an earlier run; run-to-run drift is inside the claimed gain | burn-in 4 s + mirrored A B B A + mean of two readings + admissibility ≥2 ratios, spread ≤5% (`timing.py:403-530`, `driver.py:2679-2697`) | **P** | 1–2d |
| A3 | Harness immutability | `scopeGlobs` scopes the *diff hash*; nothing forbids a candidate from editing the check/bench apparatus | delivery diff touching `eval/`, `gpu_entry.sh`, `ref_bin/` → REVERT before a job is bought; per-job byte overlay (`harness_guard.py:36`, `driver.py:2054-2130`) | **P** | 0.5d |
| A4 | Reading-validity fields | none | rotating/shifted input pointers, prep-mutation snapshot, L2 flush, empty-graph 5% floor, unstable-pair 1.2× (`timing.py:353-370`, `:811-829`) | **P** (as required fields, not implementations) | 1d |
| A5 | Archive provenance with refusal | baseline is per task, no machine/basis/window stamp | baseline archive keyed by (op, shape, hardware, cluster, basis, workload set), refuses a mismatched comparison (`baseline.py:188-250`) | **P** | 1d |
| A6 | Clock state | profile records GPU + clocks; the benchmark does not | lock + read-back ±50 MHz + refuse the run (`leaderboard.py:839-960`) | **R** (require the field; cannot lock) | 0.5d |
| A7 | Precision gate | task comparator owns tolerance; comparator can always exit 0 (ADR 0004 says so) | second judge: `e_cand > 3·e_ref + max(u(dtype), 2^-17)` (`precision_gate.py`) | **P** | 1–2d |

**B. Correctness surface**

| # | Capability | A today | B mechanism | Verdict | Cost |
|---|---|---|---|---|---|
| B1 | Input groups per shape | one input per cell; `vars` + `boundary` only | ≥3 input groups per shape, each with an `intent`, generated deterministically from a seed; all shapes × all groups judged and timed (`task.py:88`, `judge.py:186-201`) | **P** | 1–2d |
| B2 | Judge authored independently of the answer, then calibrated | user writes the check command; the plugin "cannot validate the comparator" (ADR 0004) | teacher writes judge from `description.md` alone; calibrated against the reference; tolerance = 2× worst observed, floored per dtype, frozen once (`judge.py`, `launch.py:475-503`) | **R** (a `kernel_calibrate` tool + a rule) | 2d |
| B3 | Determinism / state | checks run every cell twice; pass-2-only reported | first-call-only, round-0, repeat, non-reproducibility classes (`trajectory.py`, monitor) | **ALREADY AT PARITY** on the cheap half | — |
| B4 | End-of-run correctness monitor (OOD input profiles) | none | 10 input profiles (seed/amp/tiny/spikes/zero_block/const_rows/int_edges), alarm/warn/info, advisory except the exit code (`docs/correctness-monitor.md`) | **R** | 1–2d |

**C. The plan layer — the biggest methodological gap**

| # | Capability | A today | B mechanism | Verdict | Cost |
|---|---|---|---|---|---|
| C1 | Decision graph as a validated artifact | `docs/plan.md` = 3 headings of prose, checked only for placeholders (`workspace/layout.ts:8-12`) | `D<x>.<y>` rows with five-tuple `Action/Purpose/Trigger/Cost/Depends on`, `⇐/⊗/⇒` DAG, per-milestone gate blocks, validator (`milestone.py:53`, `:249-457`) | **P** | 3–4d |
| C2 | Architecture freeze (M0) then levers | none; every candidate can retile | M0 carries the resource-topology contract, freezes at its gate; M1+ only levers, reopening M0 is priced and capped (`docs/milestones-template.md:54-134`) | **P** (as a contract section + validator) | included in C1 |
| C3 | Typed gate lines | metric + `bottleneck_metric` only | `[VERIFY: ncu-direct/ncu-derived/sass-derived/correctness/none]`, `[MEASURED, job N]`, `[PRICED:]`, `none` may not enter a gate (`milestone.py:64-65`, `:607`) | **P** | 1d |
| C4 | Dead-end table with bundle semantics | rejections keep a reason; no retry precondition | failed bundle bans the combination, not its members; retry with a changed precondition is legal (`meta_milestone.md:372-390`) | **P** | 0.5d |
| C5 | Decision ids on candidates | ledger has `description`, no id | one iteration = one decision (or declared bundle), gate row is its own row | **P** | 0.5d |
| C6 | Prefix-reuse / reopen-closure invalidation | none (no trajectory) | `compute_resume` cuts at the earliest affected decision; `compute_reopen` computes the dependency+companion closure and names what to keep (`resume/invalidation.py:56`, `:90`) | **P**, but only after C1 | 1d |
| C7 | Plateau / infeasible arithmetic | stop conditions are prose | plateau = 3 iterations, 1.5%; INFEASIBLE only with `floor_opt > max(target, threshold) × 1.20` after ≥1 diagnosis (`driver.py:3103`) | **P** | 0.5d |

**D. The outer loop and roles**

| # | Capability | A today | B mechanism | Verdict | Cost |
|---|---|---|---|---|---|
| D1 | Second loop that edits the plan | none; at a plateau the only move is another candidate | teacher diagnoses G1–G5/R1/R2, patches the milestone (additive/structural/split), patch must differ byte-wise and name real `changed_entries` (`driver.py:6906`) | **P** via a pi skill + subagent + C1 validator | 2–3d |
| D2 | M0 audit at first green | none | mandatory independent audit turn asking "is the milestone consistent with hardware truth", `OK` allowed (`m0_audit_prompt.md`) | **P** via subagent | 0.5d |
| D3 | Pre-registered verdict probe | profile evidence binds a claim, but there is no experiment protocol | `PROBE_REQUEST` → `PROBE PASS max_diff=…` / `FAIL`, registered before the run | **P** | 0.5d |
| D4 | Info barrier (deny list, sealed reference) | none; the agent can read the repo it optimizes | derived deny list + OS sandbox + `deny` can only add (`launch.py:330-351`, `agent_policy.py:1-64`) | **S** for sealing; **R** for a `deny` list if the user wants an unbiased reproduction experiment | 1d |
| D5 | Refusal discipline (named rule + attribution + fix + exit code) | good at "no", thinner at "who pays and what fixes it" | every refusal names the rule, the side charged, the fix (`blackbox-guard.sh:126-136`) | **P** | 0.5d |

**E. Knowledge**

| # | Capability | A today | B mechanism | Verdict | Cost |
|---|---|---|---|---|---|
| E1 | Symptom-indexed KB | KernelWiki = NL search + 4-value source-trust label | `index.md` "look up by symptom first" (64–74 rows), entry per mechanism (`hw_kb/cuda/sm100/index.md:17`) | **P** (container) | 1d |
| E2 | Entry schema that separates "works" from "pays" | one confidence label | `✅ Verified` + `[UNVERIFIED-BOUNDARY]`, `## Load-bearing conditions`, `## Measured footprint and cost`, `## Gotchas`, negative readings recorded (`ring_depth_lever.md:138-145`) | **P** (format) | 1d |
| E3 | KB lint (leak + structural) | conflict scan on KernelWiki registration only (`knowledge/conflicts.ts`, 72 LOC) | 4 leak rules + 3 structural, fail-closed on missing tree, exam-surface walk (`kb_lint.py`, ~455 LOC) | **P** | 2–3d |
| E4 | `KB:<entry>` citation that can be refused | wiki page id + label, no refusal | a `KB:` pointer resolves only inside the arch dir and only if the text carries a certification mark (`driver.py:3168, 3252-3265`) | **P** | 0.5d |
| E5 | Certification by GPU probe | none (cannot; no runner) | recipe → probe → `PROBE PASS` → harvest → lint, two-layer provenance (`docs/kb-harvest.md`) | **R** (manual protocol + a lint; no executor) | 1d + GPU time |

**F. Analysis instruments**

| # | Capability | A today | B mechanism | Verdict | Cost |
|---|---|---|---|---|---|
| F1 | Static SASS reads (no GPU) | none | `sass_tools` + `sass_census` + `launch_tools` + `struct_tools` + `sched_live_tools` + `orch_tools` ≈ 1 800 LOC stdlib Python: MMA operand census, ptxas serialization ratio 0.9/0.5, launch shape from metrics with refusal, barrier identity by def-chain, register liveness 96≤peak≤256, supply-order fingerprint | **P** (wholesale) | 2–3d |
| F2 | Per-PC stall attribution with coverage | top-30 source lines by samples (`extract_stall_hotspots.py`), no coverage guarantee, no PC→instruction join | rows until cumulative ≥90%, `MIN_SAMPLES=500`, join floor 0.50, segment ledger with DEPBAR state (`stall_tools.py:105-130, 531-621`) | **R** | 3–5d |
| F3 | Lever pricing with a coupling lattice | none | 2N+2 variants in one job, noise floor from the student's own spread, `coupled/dependent/harmful/null/unstacked/noop` (`lever_pricing_run.py:1220`) | **R** (contract + one bench script; a pi port is a rewrite) | 3–5d |
| F4 | Timeline / PM sampling / source-instrumented markers | none | `pm_timeline_tools`, `timeline_probe` (1696 LOC, 5 validity checks) | **S** until F2 exists | — |
| F5 | Job-env check | none | 78 LOC stdlib; run on the GPU node before trusting any tool | **P** | 0.2d |

**G. Product / engineering**

| # | Capability | A today | B mechanism | Verdict | Cost |
|---|---|---|---|---|---|
| G1 | Self-evolution (promote best to next reference) | none; baseline resets per task | `self_evolve.py` 125 LOC: new task dir, best kernel as reference, target = step × new ref, plateau at noise floor | **P** | 1d |
| G2 | GPU job transport / ssh / tmux / GPU lock / clock lock | none | whole sub-system | **S** (pi is a session, not a daemon) | — |
| G3 | Leaderboard submission and board scoring | none | `submit/`, `leaderboard.py` | **S** | — |
| G4 | ~45 anti-cheat guards | none | see measure note §3 | **S** mostly; 6 of the 45 are validity guards, not anti-cheat | — |

### The five that are actually wrong to lack

Ranked by "a claim this system currently makes can be false" rather than by ambition:

1. **A1 host-bound precondition.** `noiseFloorPct` controls variance, not validity. A pipelined
   "device" reading behind a thick Python path reports dispatch cost under a device label,
   reproducibly, with correctness passing — this is not hypothetical: it produced a 1.86×-too-loose
   target and an uncitable 11.5-hour run (`timing_audit.py:1-33`). pi-kernel-expert's contract has
   no field in which that fact could even be recorded.
2. **A2 paired same-job measurement.** Every pi-kernel-expert speedup is a ratio against a baseline
   measured in an earlier run on an unknown machine state. ForgeKernel measured the bias this leaves
   in: first window 3–5% fast, later windows drift 2.7% — "more than half of a 5% equivalence margin"
   (`timing.py:371-400`).
3. **B1 input groups.** A shape matrix with one input per shape tests the shape, not the data. The
   kernels that matter (attention with masks, MoE with ragged routing, sparse indexers) are wrong on
   *distributions*, and pi-kernel-expert's contract cannot express a second input for the same cell.
4. **A3 harness immutability.** `scopeGlobs` decides what counts as the candidate's diff; it does not
   stop the diff from editing the comparator it is judged by. ADR 0004 already states the exposure:
   "a comparator that always exits 0 produces green checks." The guard is a list plus a diff check.
5. **C1 + C3 the decision graph and typed gate lines.** Without an addressable plan, a plateau is
   indistinguishable from "the agent has not thought of the next idea", and a green number cannot be
   separated from "the mechanism landed". This is the cheapest structural fix that changes how the
   agent spends its next hour.

### What not to port

- **The job runner** (ssh/tmux/GPU lock/agent sessions/resume across process death). pi is an
  interactive session; ADR 0001 already delegates the loop. Owning a daemon would be a different
  product.
- **Sealed references and blackbox sealing** (`sealref`, `closed_ref`, fence lists, key handling).
  These exist to make a *paper claim* about reproduction from a description. A user optimizing their
  own kernel does not need the reference hidden from themselves.
- **Most of the 45 anti-cheat guards.** They defend a benchmark against an agent with no stake in it.
  The portable subset is the validity subset (A1–A4), not the adversarial subset.
- **The 700-line distillation policy** (`meta_milestone.md`). Much of it encodes fixes for failure
  modes of a 4-hour unattended loop with a weak model. Port the schema and the five rules that
  survived, not the museum.
- **`timeline_probe` / `pm_timeline` / `lever_pricing_run` code.** Re-derive the contract (verdict
  line + coverage floor + noise floor); a copy would arrive with the run-directory layout attached.

### Where pi-kernel-expert is already ahead (do not regress)

- **Contract hash + generated scripts that refuse a hand edit.** ForgeKernel has no equivalent
  refusal at the artifact level; its guards are runtime checks.
- **Evidence bound to a diff hash.** ForgeKernel binds a reading to an iteration record and a sha, but
  the "this profile is stale for this tree" refusal (`kernel_candidate`) is a cleaner separation of
  measurement from record than anything in ForgeKernel.
- **A pinned, sanitized, license-audited external corpus.** `hw_kb` is first-party only; there is no
  notion of a third-party pin, a restricted file pruned at fetch, or a conflict scan on registration.
- **Distribution.** One package, one install, no Python venv, no GPU-side setup.

### Phased plan (each phase ends in a refusal that did not exist before)

**P0 — make the reading valid (≈3–4d).** Contract gains `basis`, `referenceCommand?`, `harnessGlobs`,
and the reading record gains `hostEnqueueMs` / `deviceMedianMs` / `hostBoundRatio` / `clocks`.
`goal.sh` emits them; `kernel_candidate` refuses a keep whose reading lacks a basis, whose
`hostBoundRatio ≥ 0.5` without a host-free basis, or whose diff touches `harnessGlobs`. Acceptance: a
run with a deliberately thin-Python bench is refused with a named rule; a run that edits
`goal.checks.sh` is refused before profiling.

**P1 — make the data surface real (≈3–4d).** `cells[].groups[]` (name, intent, seed) with ≥3
enforced per non-boundary cell; `KERNEL_GROUP` exported; checks run every group; precision gate on
`max_diff` vs a calibrated reference error. Acceptance: a kernel that is correct on the typical draw
and wrong on the `zero_block` draw fails the matrix.

**P2 — make the plan addressable (≈5–6d).** `kernel_milestone` validates `docs/milestone.md`
(sections, five-tuple, DAG, gate blocks, `[VERIFY:]`/`[MEASURED:]`, no `none` in a gate); candidates
carry `decision`; rejections append to a dead-end table with bundle semantics; a `kernel-diagnose`
skill dispatches a readonly subagent for the G/R diagnosis + patch class when the ledger shows a
plateau. Acceptance: a candidate without a decision id is refused; a milestone with a dangling
`Depends on` is refused; a plateau triggers a diagnosis record instead of another candidate.

**P3 — give the agent instruments (≈4–6d).** Vendor the static SASS half under
`third_party_licenses/` (Apache-2.0, NOTICE updated) as 6 pi skills, each with one verdict line and a
fail-closed floor; add `job-env-check`; add the KB container (symptom index + 5-section schema + lint
+ `KB:` citation refusal) and seed it with 3–5 entries re-verified on the target arch, or explicitly
marked `UNVERIFIED`. Acceptance: a Blackwell kernel's "ptxas collapsed my wgmma" claim is answered by
a tool, not by prose; a KB citation that has no certification mark is refused.

**Deliberately deferred:** F2 per-PC coverage join, F3 lever pricing, D4 deny list/sealing, G1
self-evolution. Each needs either a GPU runner or a user with a reproduction-experiment goal.

### Gaps and honesty notes

- No GPU, `ncu`, or `nvcc` on this machine: nothing hardware-dependent here was executed. All
  ForgeKernel readings quoted are its own recorded numbers, not reproduced.
- No KernelWiki checkout exists at `~/.pi/agent/kernel-expert/cache`, so the KernelWiki side of the
  contrast is from pi-kernel-expert's own metadata (`CONTEXT.md:60-61`, `tools/wiki.ts:94-99`),
  not from page contents.
- ForgeKernel line numbers come from this checkout; its driver is ~11 700 lines and line numbers
  move between commits.
- `hw_kb` entry counts and confidence-tag counts in `notes/kb.md` are grep counts over this checkout.
- License: ForgeKernel is Apache-2.0. Vendoring its Python tools requires the NOTICE + per-file
  attribution that `third_party_licenses/` already exists to carry; the hw_kb *content* additionally
  requires re-verification, by its own rule (`hw_kb/cuda/README.md:14-22`).
