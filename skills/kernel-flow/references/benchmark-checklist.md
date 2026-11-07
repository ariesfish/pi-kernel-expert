# Benchmark checklist (GPU kernels)

Adapted from the `benchmark-checklist` in pi-dev-mode, with the GPU cases that
matter for kernel work. Answer each question with evidence from a run, not a
guess about the code. The generated `goal.sh` already answers 4, 5, and 7 in
part; it cannot answer 1, 2, 3, or 6 for you.

## Before you run

- Write the claim in the words you would ship: "decode attention is 18% faster
  at seq 8192 on B200, bf16, geomean over the matrix". The questions test that
  sentence.
- Read the harness and `goal.sh`. Note what is timed: one launch, a batch of
  launches, or the whole call including host-side setup and copies.
- Record machine state: GPU model, driver, CUDA, ncu version, SM and memory
  clocks, power limit, and whether another process shares the GPU
  (`nvidia-smi`, `nvidia-smi pmon`).
- profiling run and measurement run are different runs: ncu serializes and
  replays kernels, so never quote a duration measured under ncu.

## The questions

1. **Name the limiter.** Profile in a run you do not report. Use `kernel_profile`
   for the counters: DRAM/L2/L1 throughput, SM utilization, tensor-core
   utilization, occupancy, and the stall mix. Watch the host too — a kernel can
   appear slow because the feed, the copies, or a synchronization dominates.
   If a change did not move the number, the limiter explains why.
2. **Was it tuned?** Every side must run as production runs it: release build,
   the target arch (`-arch=sm_90a` for Hopper wgmma, `sm_100a` for Blackwell
   tcgen05), the same library versions, the same input distribution, warm
   caches, and enough work to amortize launch overhead. A debug build or a
   fallback dispatch means you compared configurations, not kernels.
3. **Did it break limits?** Do the arithmetic: bytes/s against HBM bandwidth,
   FLOP/s against the dtype's peak, occupancy against register and shared
   memory limits. A piece that took 10% of the time can make the kernel at most
   ~11% faster. A result past a hardware limit measured something else — a
   cache, a skipped launch, or a bug.
4. **Did it error?** Count mismatches, NaNs, overflow, and races, across the
   whole matrix, not just the headline cell. `goal.checks.sh` does this twice
   per cell; a pass-2-only failure is a real finding.
5. **Does it reproduce?** `goal.sh` runs warmup plus `repeats` and reports the
   median; compare medians, and keep the spread in mind. Lock clocks or record
   them; a run at another clock is a different experiment. A gap smaller than
   the run-to-run variation is no measurable difference.
6. **Does it matter?** Measure the path the user waits on: the whole op, the
   layer, or the step, not only the microbenchmark. A kernel that is 5% of the
   step can improve the step at most 5%.
7. **Did it even happen?** Confirm the intended kernel launched and did the
   work: `ncu` launch stats show the kernel name and grid; the compiler did not
   fall back to a reference path; the output was consumed; the timed region
   contains the launch plus the synchronization that waits for it. Lazy or
   skipped work produces a fast number for nothing.

## Report

- Verdict first: faster, slower, no measurable difference, or inconclusive.
- The number with unit, run count, range, limiter, and the GPU/clock context:
  "median 41 µs → 33 µs over 5 runs per side, range 32–35 µs, DRAM-bound on one
  SM partition, B200 at 1965 MHz".
- Inconclusive is the right verdict when you cannot name the limiter, when a
  side ran untuned, or when questions 4 and 7 are unanswered. Name the gap.
