# Milestone: fused attention epilogue on H200

## 1. Problem and Target
Decode attention at m1024 is 1.9 ms; the epilogue writes the accumulator to smem
and reads it back, which the profile attributes to 20% of the kernel. Target: the
epilogue disappears from the top-3 stalls, and geomean improves 15%.

## 2. Contract
- basis: device
- cells: a, b
- groups: typical, zero_block, tail
- harness: goal.sh, goal.checks.sh (generated; never edited by a candidate)

## 3. DAG and Phase Order
M0 Contract, then M0 Architecture, then M1 Levers. M1 is blocked on M0's gate.

### M0 Contract
- tile: 128x128 bf16
- smem: 64 KiB, 2 stages
- warp roles: 4 mma warps, 4 copy warps
- register budget: 168
- issue order: cp.async, ldmatrix, mma, st.global
- accumulator precision: fp32

### M0 Architecture
#### D0.1 Fuse the epilogue into registers
- Action: keep the accumulator in registers and write the output once
- Purpose: remove the smem round trip the epilogue costs
- Trigger: ncu reports epilogue time above 20% of the kernel
- Cost: half a day, one new register window
- Depends on: none

#### D0.2 Stage two tiles through cp.async
- Action: prefetch tile k+1 while the mma of tile k issues
- Purpose: hide the global load behind the mma
- Trigger: long scoreboard above 40% on a/typical
- Cost: one day
- Depends on: ⇐ D0.1

### M0 Gate
- epilogue time drops below 5% of the kernel on a/typical [VERIFY: ncu-direct profile:run1]
- every group still matches the reference within its epsilon [VERIFY: correctness]
- the accumulator never leaves the register file [VERIFY: sass-derived][PRICED: -4% issue slots, measured on the sm90 box]
- the epilogue is gone, which is why device_ms moved [VERIFY: mechanism]

### M1 Levers
#### D1.1 Split the K loop across two warps
- Action: split the reduction over two warps and combine through smem
- Purpose: halve the per-warp K length
- Trigger: ncu reports L1 hit rate below 60% on b/tail
- Cost: two days, a new reduction
- Depends on: ⇐ D0.2

### M1 Gate
- L1 hit rate on b/tail clears 70% [VERIFY: ncu-derived profile:run4]
- the two-warp reduction lands and max_diff stays under 3x the reference's own [VERIFY: mechanism]

## 4. Dead Ends
- D0.1+D0.2 | the pair spills 190 registers at 128x128 | profile:run2
- D1.1 | two-warp reduction loses 8% at m1024 because the combine pass costs a barrier | profile:run5

### Diagnosis plateau-1
- class: missing-decision
- decision: D1.2 split the output writeback across all 8 warps so each warp holds half the accumulator and the fused epilogue fits the frozen 168-register budget without spilling
- measurement: `ncu --metrics launch__registers_per_thread,l1tex__t_sectors_pipe_lsu_mem_local_op_ld.sum,l1tex__t_sectors_pipe_lsu_mem_local_op_st.sum ./goal.sh a typical` => registers_per_thread 168 with local ld/st sectors > 0 means missing-decision, local sectors = 0 at <=168 registers while short-scoreboard stays ~31-34% and geomean stays flat means wrong-decision
- abandon: epilogue-instruction edits under D0.1 (C2 store widening, C3 kernel hoist) and the D0.1 register-budget-thaw route (C4); none changes the 190-register footprint at 128x128, and the thaw half already regressed (waves/SM 1.12 to 0.75, geomean 0.94)
- citations: milestone.md:59, milestone.md:21, candidates.jsonl#C4, loop-log.txt:10, loop-log.txt:11, profile/run1/summary.json:1

## 5. Global Gate
Both phase gates hold on every cell and group, and goal.checks.sh is green.

## 6. Rules
A decision is a five-tuple. A gate line carries exactly one VERIFY class and its pointer.
M0 is frozen; a thaw is a recorded diagnosis, not an edit.
