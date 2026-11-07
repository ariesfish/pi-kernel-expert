# pi-kernel-expert Domain Context

pi-kernel-expert makes kernel optimization work auditable inside pi: a kernel candidate is judged by executable correctness checks, a measured metric with a noise floor, and profile evidence that a reader can open.

## Language

**Kernel Task**:
A workspace with a baseline kernel implementation, a representative workload, a correctness oracle, and a measurable target.
_Avoid_: project, experiment.

**Task Contract** (Kernel Contract):
The frozen criteria that decide whether a candidate is promoted: the shape matrix, tolerances, the primary metric, guard criteria, and the evidence requirements.
_Avoid_: goal, spec.

**Shape Matrix**:
The set of input shapes and dtypes a candidate must be correct on, plus the tolerance per dtype. Generated, not remembered.
_Avoid_: test cases, workload.

**Reference Oracle**:
The command or artifact that defines expected output for the shape matrix. A candidate is compared against it, never against its own previous output.
_Avoid_: baseline when correctness is meant; baseline is the performance comparison point.

**Candidate**:
One implementation variant with a parent link, a diff hash, measured results, and a decision.
_Avoid_: attempt (an attempt is a reverted candidate), version, iteration.

**Promotion**:
A keep decision that passed the gate: correctness across the matrix, the primary metric above the noise floor, guard criteria intact, and profile evidence present when a bottleneck is claimed.
_Avoid_: merge, accept.

**Rejected Candidate**:
A candidate with a recorded reason and evidence pointer. The diff stays available; the decision does not disappear.
_Avoid_: failure, discard.

**Evidence Pointer**:
A path plus content hash that a later reader can open: a journal entry, a profile summary, a benchmark log line.
_Avoid_: result, output.

**Profile Run**:
One directory holding one ncu collection's harness, reports, analysis, and report.
_Avoid_: profile, dump.

**Profile Evidence**:
A profile run summary bound to a candidate diff hash. Stale evidence is not evidence.
_Avoid_: profiling output, trace.

**Noise Floor**:
The run-to-run variation of the primary metric under the recorded clock and GPU state. An improvement inside it is not an improvement.
_Avoid_: variance, jitter.

**Limiter**:
The resource the measured kernel is limited by, named from profiler counters (DRAM, L2, L1, compute, latency, occupancy), never guessed.
_Avoid_: bottleneck (used only when quoting a diagnosis).

**Wiki Citation**:
A KernelWiki page id plus its confidence label (`verified`, `source-reported`, `inferred`, `experimental`).
_Avoid_: reference, link.

**Pin**:
An exact upstream revision recorded with content digest. A pin change is a decision with a notice update, not a routine refresh.
_Avoid_: version.

## Relationships

- A **Kernel Task** has exactly one **Task Contract** before the first baseline run.
- A **Task Contract** owns one **Shape Matrix** and one primary metric.
- A **Candidate** has one parent **Candidate** (the baseline is the root) and at most one decision.
- A **Promotion** requires profile evidence whose **Profile Run** is newer than the candidate's diff.
- A **Rejected Candidate** keeps its reason and an **Evidence Pointer**.
- A **Profile Evidence** entry is invalidated, not deleted, when the contract changes.
- A **Wiki Citation** may support a direction or a diagnosis; it never supports a measurement.
- A **Pin** change requires a changelog entry and a notice check.

## Example dialogue

> **Dev:** "The candidate is 3% faster but the report is from before the change. Can we promote it?"
> **Domain expert:** "No. That is stale **Profile Evidence**; re-run the **Profile Run** against this diff, or promote without a bottleneck claim."

> **Dev:** "The new kernel matches the reference on the main shape. Ship it?"
> **Domain expert:** "The main shape is one cell of the **Shape Matrix**. Boundary shapes and the determinism re-run are part of the contract; a miss there is a rejection, not a note."

## Flagged ambiguities

- "baseline" meant both the performance comparison point and the correctness reference — resolved: **Baseline Snapshot** for performance, **Reference Oracle** for correctness.
- "profile" meant the act, the directory, and the artifact — resolved: **Profile Run** is the directory; **Profile Evidence** is the bound summary; profiling is the act.
- "test" meant both the executable check and the correctness comparison — resolved: a **Task Contract** criterion is executable; the **Shape Matrix** comparison is one such criterion.
