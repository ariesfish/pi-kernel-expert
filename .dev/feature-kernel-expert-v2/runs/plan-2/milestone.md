# Milestone: SAXPY on an H200

## 1. Problem and Target
SAXPY at N=16.7M is memory bound: 128 MB in, 128 MB out, 64 MB of L2. The target is
the ring's own streaming bandwidth, measured on the reference, not the spec sheet's peak.

## 2. Contract
- basis: device
- cells: n8m, n32m, n128m
- groups: typical, tail

## 3. DAG and Phase Order
M0 Contract, then M0 Architecture (the address mapping), then M1 Levers.

### M0 Contract
- tile: 1024 elements per block, 256 threads, 4 per thread
- smem: none, the mapping needs no staging
- warp roles: none, every warp loads and stores the same way
- register budget: 32 (the kernel is 11 instructions)
- issue order: index, load, fma, store
- accumulator precision: fp32

### M0 Architecture
#### D0.1 Map consecutive threads to consecutive elements
- Action: index element i as blockIdx.x * blockDim.x + threadIdx.x
- Purpose: make one warp request 4 sectors instead of 128
- Trigger: ncu sectors per request above 4 on n128m/typical
- Cost: nothing, the arithmetic is the same instruction count
- Depends on: none

#### D0.2 Split the ring into cells by working set
- Action: benchmark at 8 MB, 32 MB and 128 MB so L2 residency is a variable, not an assumption
- Purpose: separate a request-amplification cost from a residency cost
- Trigger: the speedup differs by more than 2x between the smallest and largest cell
- Cost: three cells instead of one, so three times the run time
- Depends on: ⇐ D0.1

### M0 Gate
- device_ms on n128m/typical drops by at least 8x with goal.checks.sh green [VERIFY: ncu-direct profile:run1]
- every cell and group still matches the reference within its dtype epsilon [VERIFY: correctness]
- one warp request reads four sectors, not 128 [VERIFY: ncu-derived profile:run1]
- the request amplification is gone, which is why the number moved [VERIFY: mechanism]

## 4. Dead Ends
- D0.2 | a 128-bit vector load changed nothing, the cost was never instruction count | profile:run2

## 5. Global Gate
Every cell and group holds the M0 gate, and goal.checks.sh is green on the promoted kernel.

## 6. Rules
A decision is a five-tuple. A gate line carries exactly one VERIFY class and its pointer.
M0 is frozen once the plan is agreed; a thaw is a recorded diagnosis, not an edit.
