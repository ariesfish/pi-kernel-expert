---
id: identical-census-different-addressing
arch: sm90
---

**Certification source:** `cuobjdump -sass bench` on h200-7 (2026-11-10) for the two kernels, and the fixture's reading block in `runs/corpus-1/` (2026-11-09) for the time
**Certification covers:** the structural claim on sm90 — the mapping lives in one `IMAD`, and the rest of the instruction list is shared
**Uncertified:** any other kernel shape, any other card, and the percentage itself

- Status: MEASURED NVIDIA H200 2026-11-09

## Purpose

Stop reading a matching census as "the change did nothing". Two mappings 11x apart
compile to the same number of instructions of the same families; what separates them
is the arithmetic that computes the address, and that is one visible instruction.

## When needed (trigger)

A census comes back identical between two variants, or you are about to compare
kernels by instruction count.

## Mechanism

Both kernels carry the same opcode families and the same four real operations —
two `LDG.E`, one `FFMA`, one `STG.E`. The strided one is 40 instructions against 32
because it loops (`BRA`), and the eight extra instructions are `NOP` padding and
constant loads. The count does not separate them; the index does:

```
coalesced: IMAD R7, R7, UR4, R0      # thread * blockDim + tid  (warp-contiguous)
strided:   IMAD R0, R0, UR4, R3      # tid * blockDim + block   (warp-strided)
```

Same opcode, same count, different operands. The first makes a warp request four
sectors; the second makes it request the whole grid's worth of addresses.

## Measured footprint and cost

Free: `cuobjdump -sass` on the binary, no run.

The mapping these two instructions produce is worth 11.39x at N=16.7M under this
structure — 61.30 us coalesced against 698.36 us transposed — and that number is the
mapping's, on this card, on one day.

## Gotchas

`NOP` is 12 of 32 in the coalesced kernel and 15 of 40 in the strided one: it means
nothing, and comparing totals across kernels compares padding. A near-matching census
is not a matching kernel; a differing census is not a differing cost.

## Certification boundary

One card, one driver, one kernel shape, one night. The structural claim (the mapping
is one `IMAD`) travels; the 11.39x does not, and no architecture beyond sm90 was read.
