# ADR 0003: v1 is verified on sm_90, while the knowledge skills cover Blackwell

## Status

Accepted (2026-11-07).

## Context

The upstream material is Blackwell-first: KernelWiki targets SM100/SM103 and the ncu skill's curated metric table is Blackwell-specific. The available verification target for v1 is sm_90 (Hopper) with CUDA 13.2 and Nsight Compute 2026.3.1. No GPU exists on the build machine today.

Options: gate the build on a Blackwell machine, restrict v1 to Blackwell on paper and verify nothing, or parameterize the target and verify on sm_90.

## Decision

Parameterize the target architecture. v1 acceptance runs on sm_90; the fixture takes the arch as configuration, and the GPU smoke test records the GPU identity, clock state, CUDA, and ncu versions it actually finds rather than asserting a target.

Claims follow the evidence: sm_90 behavior may be called verified once the smoke test runs; Blackwell behavior is carried by upstream skills and marked unverified here.

## Consequences

- The build is not blocked on hardware that does not exist; hardware-dependent acceptance is deferred, not faked.
- Some Blackwell-specific ncu metric names return nothing on sm_90. The helpers' `safe()` accessor degrades to "missing" — the summary must report absence, never infer a value.
- A later Blackwell run is a configuration change plus a fresh acceptance record, not a rewrite.
- The docs must keep the boundary visible: a verified sm_90 number is not evidence for sm_100.
