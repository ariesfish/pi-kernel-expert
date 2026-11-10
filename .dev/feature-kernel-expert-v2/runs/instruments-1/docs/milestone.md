# Milestone: SAXPY on an H200 (instruments pass)

## 1. Problem and Target
At N=16.7M the kernel moves 128 MB in and 128 MB out against a 60 MB L2, so the only
thing that matters is how the warp's requests land. Target: the coalesced mapping, and
the structural reading that makes the claim checkable without a run.

## 2. Contract
- basis: device
- cells: n128m
- groups: typical, zero_block, tail
- harness: goal.sh, goal.checks.sh

## 3. DAG and Phase Order
M0 Contract, then M0 Architecture.

### M0 Contract
- tile: 1 element per thread, 256 threads, one block per 256 elements (the dump, not the draft)
- smem: none
- warp roles: none, every warp loads and stores the same way
- register budget: 168
- issue order: index, load, fma, store
- accumulator precision: fp32

### M0 Architecture
#### D0.1 Map consecutive threads to consecutive elements
- Action: index element i as blockIdx.x * blockDim.x + threadIdx.x
- Purpose: make one warp request four sectors instead of 128
- Trigger: ncu sectors per request above 4 on n128m/typical
- Cost: nothing, the arithmetic is the same instruction count
- Depends on: none

### M0 Gate
- device_ms on n128m/typical drops by at least 8x with goal.checks.sh green [VERIFY: ncu-direct profile:run1]
- every cell and group still matches the reference within its epsilon [VERIFY: correctness cell-group: n128m/typical]
- the two mappings carry the same loads, fma and store, and differ in the addressing `IMAD`: the census does not separate them and the time does [VERIFY: sass-derived][PRICED: 11.39x on the mapping, KB:identical-census-different-addressing]
- the request amplification is gone, which is why device_ms moved [VERIFY: mechanism]

## 4. Dead Ends
- D0.1 | a 128-bit vector load changed nothing, the cost was never instruction count | profile:run2

## 5. Global Gate
Every cell and group holds the gate, and goal.checks.sh is green on the promoted kernel.

## 6. Rules
A candidate may not edit goal.sh or goal.checks.sh.
