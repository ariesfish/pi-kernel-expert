---
name: kernel-flow
description: >-
  Use when optimizing a CUDA kernel on an NVIDIA GPU: making a kernel faster,
  chasing a measured bottleneck with Nsight Compute, or iterating candidates
  against a correctness matrix. Runs the KDA flow on pi-goal: freeze the shape
  matrix and tolerances, record a baseline, profile with ncu, and promote only
  what passes the gate. Chinese triggers: 优化 CUDA kernel, kernel 加速,
  写 kernel, 性能调优, ncu 性能分析, 瓶颈定位, 延迟优化, 吞吐优化.
  Not for generic CUDA questions, host-side framework integration (serving,
  scheduling, model loading), distributed or multi-GPU work, or non-kernel
  optimization such as bundle size or web performance.
---

# Kernel flow

One kernel task = one frozen contract, one baseline, a chain of candidates, and
a verdict per candidate. The verdict is not a story: it is the correctness
matrix, the measured geomean, the guard cells, and the profile evidence.

This skill runs on **pi-goal**. That plugin owns the phase machine, the
contract hash, the gate, the journal, and the revert. This package owns the
kernel-shaped artifacts and the evidence. Do not re-implement the loop in prose.

## When to use

- "make this kernel faster", "optimize the attention kernel", "这个 kernel 为什么慢"
- A candidate must be judged against a reference implementation across shapes.
- A performance claim needs a profile before it can be believed.
- Optimizing CUDA C++, CuTe/CUTLASS, Triton, or inline PTX on an NVIDIA GPU.

## When not to use

- Generic CUDA Q&A with no target kernel and no measurement.
- Host-side work: request routing, batching policy, model loading, serving.
- Distributed or multi-GPU kernels (DeepEP/EPLB/DualPipe class).
- Non-kernel optimization (bundle size, web latency, test runtime): use
  pi-goal directly.

## The loop

| Step | Call | Artifact it leaves |
|---|---|---|
| 1. Contract | `kernel_init` | `docs/draft.md`, `docs/plan.md`, `profile/`, `candidates.jsonl`, `.kernel/` |
| 2. Plan draft | fill `docs/draft.md`; `kernel_wiki` for background | baseline, risks, ranked directions, exact commands, evidence required |
| 3. Executable plan | fill `docs/plan.md` | steps, evidence per step, stop conditions |
| 4. Freeze | `kernel_contract` → `freeze_criteria` | `kernel.contract.json`, `goal.sh`, `goal.checks.sh`, `kernel-freeze.json` |
| 5. Baseline | `run_goal` → `log_goal` (keep) | `.kernel/baseline.tsv`, `goal.jsonl` |
| 6. Candidate | edit → `run_goal` → `log_goal` | run entry + commit on keep, reverted attempt on reject |
| 7. Evidence | `kernel_profile` when the change rests on a bottleneck claim | `profile/<run>/summary.json` |
| 8. Lineage | `kernel_candidate` (keep or reject), passing the run's `reading` | `candidates.jsonl` |
| 9. Stop | stop conditions met | final candidate + its evidence pointers |

Order matters: **profile after the change, record the candidate before
`log_goal` commits it.** The summary is bound to the diff hash; a commit or a
later edit makes it stale.

### pi-goal's phase, briefly

`kernel_contract` produces the freeze payload. If pi-goal is still in
`framing`, derive at least two orthogonal directions from the draft's
"Candidate directions" section, `frame_goal` them, `probe_goal` each with a
cheap measured proxy (a single-cell timing, a `ncu --set basic` counter, a
compile-time check), then `freeze_criteria`. The payload already has exactly one
blocking metric criterion (`geomean_speedup`, higher) and one command criterion
(`bash goal.checks.sh`). Use `metric_name: geomean_speedup`, `direction:
higher`.

## Artifacts

| File | Owner | Read it when |
|---|---|---|
| `docs/draft.md` | you | before any code; the contract refuses placeholders |
| `docs/plan.md` | you | before each candidate; steps and stop conditions |
| `kernel.contract.json` | `kernel_contract` | the frozen matrix, tolerances, commands |
| `goal.sh` | generated | the measurement; do not hand-edit |
| `goal.checks.sh` | generated | the correctness matrix; do not hand-edit |
| `.kernel/precision.tsv` | `goal.checks.sh` | one `max_diff` per cell x group; `n/a` means the check printed no error |
| `.kernel/calibration.json` | `goal.checks.sh --calibrate` | the reference's own error per dtype — the precision ruler |
| `.kernel/baseline.tsv` | first `goal.sh` run | the comparison point |
| `profile/<run>/summary.json` | `kernel_profile` | the profile evidence; cite only what it lists |
| `candidates.jsonl` | `kernel_candidate` | lineage, decisions, reasons |
| `goal.jsonl` | pi-goal | the single source of truth for runs and commits |

## Hard rules

1. **Never hand-edit `goal.sh` or `goal.checks.sh`.** Regenerate with
   `kernel_contract force: true`; pi-goal protects them in sealed mode, so the
   human must run `/goal allow-benchmark` first.
2. **The matrix is the contract.** Adding a shape, tightening a tolerance, or
   changing the metric invalidates prior profiles and comparisons. Ask first.
3. **One candidate per iteration.** Two unrelated changes in one run means the
   number cannot be attributed; split them.
4. **A rejected candidate keeps its reason.** `kernel_candidate` refuses a
   rejection without one.
5. **A keep carries the run's reading block.** `kernel_candidate` takes the
   `reading` from the same run — `goal.sh` stdout, the block alone, or its JSON.
   Without it the keep is `unmeasured` and refused: the recorder checks the
   arithmetic (each cell's claimed value must be the geomean of that cell's
   group medians in the reading), binds the reading's contract sha to this
   task, and refuses a host-bound window, a diff that touched a harness glob,
   or a profile older than the tree.
5. **A bottleneck claim needs a fresh profile** and a metric that exists in
   `summary.json`. An absent metric is a finding, not zero.
6. **Do not compare across GPUs or clock states.** The summary records GPU
   identity and clocks; a number measured under another clock is another
   experiment.
7. **The gate decides.** A keep below the noise floor needs
   `force_with_reason`, and the reason is recorded.
8. **Cite knowledge as knowledge.** A KernelWiki page id and confidence
   (`verified` > `source-reported` > `inferred` > `experimental`) supports a
   direction or a diagnosis, never a measurement.

## Reading a failure

| Symptom | Meaning | Move |
|---|---|---|
| `goal.sh` exits 1 with `guard: cell X regressed` | a cell lost more than `guard_pct` | look at that cell; the aggregate lied |
| `goal.sh` exits 2 | `kernel.contract.json` changed under the scripts | regenerate, do not patch |
| `goal.checks.sh` reports `pass 1` | the cell is wrong | fix correctness before measuring |
| `goal.checks.sh` reports `pass 2` | order-dependent or stateful kernel | find the global/shared state |
| `goal.checks.sh` prints `no max_diff` for a group | the check is not a precision measurement; the row is `n/a` | have the comparator print `max_diff=<rel err>`, or accept that the precision gate cannot judge that group |
| `run_goal` says `checks_failed` | benchmark passed, correctness did not | log as `checks_failed`, never keep |
| `kernel_profile`: no `metrics_key` | analysis did not run | re-run without `reuse_analysis` |
| `kernel_profile`: `ncu_report` missing | helpers cannot import Nsight Compute | set `PYTHONPATH` to the ncu extras or profile on the GPU machine |
| `kernel_profile`: no stall report | no SourceCounters or no `-lineinfo` | collect `--set full` on a `-lineinfo` build |
| `kernel_candidate`: `basis-missing` | no reading, or none that says what was timed | re-run `goal.sh` and pass the block |
| `kernel_candidate`: `host-bound` | the timed window is mostly the host path | thin the host path (JIT per call, allocation, extra launches, an inner sync), then re-run |
| `kernel_candidate`: `harness-touched` | the diff edited a file that makes the number | revert it; a changed apparatus is not a changed kernel |
| `kernel_candidate`: `cell-group-uncovered` | a cell x group was never measured | re-run `goal.sh`; a cell you did not measure cannot be kept on |
| `kernel_candidate`: `reading-contract-mismatch` | the reading belongs to another contract | re-run under the current contract |
| `kernel_candidate`: `metric-not-in-reading` | the claimed cell value is not the geomean of the reading's groups | record the `METRIC` line `goal.sh` printed |
| `kernel_candidate`: `precision-regression` | the candidate's `max_diff` is past `3 * e_ref + max(ulp(dtype), 2^-17)` — right to `rtol`, wrong where the reference is not | match how the reference computes (fp32 accumulation, its upcast); the ratio is in the message |
| `kernel_candidate`: `precision-regression` says `e_ref is unmeasured` | nobody ran the calibration, so there is no ruler | `bash goal.checks.sh --calibrate`, or `force_with_reason` once and the ledger records it |
| `kernel_candidate`: `profile-stale` | code changed after profiling | re-profile this diff |
| `kernel_candidate`: metric not present | the claim cites a metric the report lacks | cite one that exists, or report the absence |

## Profiling discipline

Load `ncu-report-skill` before collecting: it owns the collection recipes, the
six analysis dimensions, and the diagnosis playbook. The short version:

- One run directory per collection, `-lineinfo` builds, `--set full`,
  `--import-source yes`, clocks recorded.
- Metrics and rule results first, diagnosis second; never a wall of fixes.
- PM sampling is the only way to see a tail effect.
- Name the limiter with the two or three metric values that back it.

## Escalation

Ask before changing: the metric or its direction, a tolerance, the shape
matrix, the check or benchmark command, or the target GPU. These invalidate
earlier evidence. Everything else — trying a direction, rejecting a candidate,
re-profiling — proceeds and is recorded.

## Stop conditions

- The promotion criteria are met and the last candidate has fresh evidence.
- The budget in `goal.config.json` is exhausted.
- A blocker needs a human: hardware, a contract change, or a correctness
  question the reference cannot settle.

Record the stop in `docs/plan.md` and leave the ledger and journal intact.
