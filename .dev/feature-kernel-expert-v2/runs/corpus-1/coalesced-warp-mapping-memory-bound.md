---
id: coalesced-warp-mapping-memory-bound
title: "A transposed warp mapping costs ~10x even when the working set fits in L2"
type: technique
architectures: [sm90]
tags: [coalescing, memory-bound, saxpy]
confidence: verified
sources: [contract:523e38b2f233]
---

## Mechanism

The grid-stride was transposed: thread t walked element t*gridDim.x + blockIdx.x, so the 32 lanes of one warp touched 32 addresses a full grid apart and every load became 32 sectors instead of four. Mapping consecutive threads to consecutive elements cuts the request amplification by 8x with the same arithmetic, the same bytes, and no extra registers or smem.

## Trigger

sectors per request above the ideal (4 for a 4-byte load, 8 for 8-byte) while achieved occupancy is already high and the kernel is near the memory system's limit

## Measured footprint and cost

no extra registers, smem or bandwidth; the index arithmetic is the same instruction count, so the change is free to keep and free to revert

## Load-bearing conditions

measured at 8 MB, 32 MB and 128 MB working sets, all sm90; the amplification is per warp request, so it survives L2 residency — what would prevent the fix is a mapping forced by the caller's tensor layout, which needs a transpose and pays the same traffic back

## Gotchas

The transposed mapping is still numerically correct, so only a benchmark or a sectors-per-request reading catches it. And it does not look like a bandwidth problem: DRAM throughput can read near peak in both versions, because the cost is the number of sectors requested, not the bytes moved.

## Negative readings

My first hypothesis was wrong: I expected the gap to collapse once the working set fit L2, and recorded that as a condition before measuring it. Measured: 9.9x at 8 MB, 13.7x at 32 MB, 11.4x at 128 MB on a 60 MB L2 — L2 residency reduces latency but not the sector count, so the effect is a request-amplification fact, not a DRAM-bandwidth fact. The condition in the first draft was written from expectation; the three-number sweep is what replaced it.
