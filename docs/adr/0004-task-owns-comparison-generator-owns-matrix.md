# ADR 0004: The task owns comparison commands; the generator owns the matrix

## Status

Accepted (2026-11-07).

## Context

Correctness for a kernel is task-specific: a fused attention kernel, a quantized
GEMM, and a reduction compare different values with different tolerances and
different reference implementations. A generator that ships its own tensor
comparison would have to assume a storage format (`.npz`, `.pt`, raw buffers),
a framework, and a definition of "close enough" — and it would be wrong for the
next task.

## Decision

The task supplies two commands:

- `check_command`: per cell, exits non-zero on a mismatch. It gets
  `KERNEL_CELL`, `KERNEL_DTYPE`, `KERNEL_RTOL`, `KERNEL_ATOL`, `KERNEL_BOUNDARY`,
  and the cell's vars, so the comparison logic can read tolerances from the
  contract instead of hardcoding them.
- `benchmark_command`: per cell, prints one number or a `METRIC` line.

The generator owns everything that must be identical across tasks:

- the shape matrix and its frozen tolerances;
- warmup/repeat/median measurement;
- the baseline snapshot and the geomean across cells;
- the per-cell regression guard;
- two-pass checks that expose order-dependent kernels;
- the contract hash both scripts verify;
- the `freeze_criteria` payload with exactly one blocking metric criterion.

## Consequences

- No framework or file-format assumptions leak into the plugin; a Triton
  harness and a CUTLASS harness use the same contract.
- The task must write a real comparator. The plugin can report that a cell
  failed, not why; the comparator's stderr is surfaced in the failure block.
- Tolerances live in the frozen contract and are exported to the comparator, so
  tightening a tolerance is a contract change, not an edit to a check script.
- The generator cannot validate the comparator itself; a comparator that always
  exits 0 produces green checks. The ncu knowledge skill and the review gate
  are the backstops, not this layer.
