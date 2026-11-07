# ADR 0005: The evidence gate lives in `kernel_candidate`, not a generated script

## Status

Accepted (2026-11-07).

## Context

The spec originally had `kernel_contract` generate an `evidence_check.sh` so
pi-goal's gate could refuse a stale profile. Two ways to enforce freshness:

1. A generated shell script (or a materialized Python file) that parses the
   ledger and the summary inside the gate.
2. A check inside `kernel_candidate`, which already sees the contract, the
   ledger, and the diff fingerprint.

## Decision

Option 2. `kernel_candidate` refuses:

- a keep missing any matrix cell's metric or below the contract's noise floor
  (unless forced with a recorded reason);
- a profile whose `contractSha` is not the current contract;
- a profile whose `diffHash` is not the current tree;
- a bottleneck claim whose metric is absent from the summary;
- a rejection without a reason.

`kernel_contract` still generates `goal.sh` and `goal.checks.sh` because those
run *inside* pi-goal's measurement and gate. Freshness is not a measurement; it
is a property of the record, so it belongs to the recorder.

## Consequences

- One enforcement point, no shell/JSON parsing, and the ledger format can change
  without regenerating every task's scripts.
- A keep can still be committed through pi-goal's `log_goal` alone, with no
  ledger entry. The skill makes `kernel_candidate` mandatory; the layer is not a
  sandbox. The review gate and the skill's rules are the backstop, as with any
  agent-facing convention.
- pi-goal remains the authority on the keep/discard commit; this tool is the
  authority on whether the recorded evidence supports the claim. The two can
  disagree, and the disagreement is visible in `goal.jsonl` vs `candidates.jsonl`.
- Re-profiling is the only repair for stale evidence; the refusal message names
  both hashes.
