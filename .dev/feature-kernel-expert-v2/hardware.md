# Hardware probe: h200-7 (builder)

Probed 2026-11-09 from the build machine, read-only (`ssh builder '...'`). Raw readings, then what
they change.

## Identity and toolchain

| Item | Reading |
|---|---|
| hostname | `h200-7` |
| GPU | 8 × NVIDIA H200, 143 771 MiB each |
| driver | 580.178.04 |
| max SM clock (reported) | 1980 MHz |
| OS | Ubuntu 22.04.4 LTS |
| python3 | 3.10.12 (system `/usr/bin/python3`); `pip3`, `uv` present |
| CUDA | `/usr/local/cuda-13.0` → nvcc 13.0.88 (not on the non-interactive PATH) |
| Nsight Compute | `/opt/nvidia/nsight-compute/2025.3.1/ncu` (not on PATH) |
| torch | **absent** (`No module named 'torch'`) |
| docker | present |
| disk | `/` 867 G, 170 G free |
| sudo | passwordless (`sudo -n nvidia-smi -L` succeeds) |

Documented target in the repo is CUDA 13.2 + ncu 2026.3.1 (`README.md`); this node has CUDA 13.0 +
ncu 2025.3.1. Version asserts must be recorded, not declared.

## Contention at probe time (the decisive reading)

```
index, mem.used, mem.free, util, sm_clock
0, 124414 MiB, 18743 MiB, 100 %, 1530 MHz
1, 124606 MiB, 18551 MiB, 100 %, 1515 MHz
2, 124560 MiB, 18597 MiB, 100 %, 1575 MHz
3, 124528 MiB, 18629 MiB, 100 %, 1575 MHz
4, 124536 MiB, 18621 MiB, 100 %, 1515 MHz
5, 124514 MiB, 18643 MiB, 100 %, 1560 MHz
6, 124560 MiB, 18597 MiB, 100 %, 1605 MHz
7, 124080 MiB, 19077 MiB, 100 %, 1575 MHz
```

Two compute processes per GPU (1872 MiB + ~122 GiB) — someone's multi-GPU job on all eight cards.
SM clocks sitting 1515–1605 MHz against a 1980 MHz max.

## What this changes

1. **Correctness can be verified now; timing cannot.** ~18.5 GiB free per card is enough for small
   correctness kernels; 100% utilisation with a tenant job on the same SM slice means any latency
   number measured now is not a measurement. This is exactly the failure class `evidence` exists to
   refuse — the spec treats "a quiet GPU" as a precondition of a timing run, not as a hope.
2. **The first verification ticket needs a toolchain bootstrap** (`uv` venv, torch with CUDA 13.0,
   PATH for nvcc/ncu) because none of it exists. ~3 GB, 170 G free — fine, but it is a state change on
   a shared machine, so it is an Ask First item.
3. **8 cards, shared, passwordless sudo.** Clock locking is technically possible and *socially*
   destructive: `nvidia-smi -lgc` would change the other tenant's training throughput. Never without
   explicit confirmation; never "just for a quick run".
4. **GPU selection must be explicit.** `CUDA_VISIBLE_DEVICES` per run, and the reading must record
   which card, its util, its clocks, and the other processes' memory — otherwise two runs on this node
   are not comparable (the archive-provenance rule).
5. **sm_90 unblocks ADR 0003's deferred verification.** `docs/verify.md` can stop saying "deferred";
   Blackwell claims stay unverified here, as that ADR already states.

## Update (same day): the machine is ours

The user confirmed the whole 8-card machine is available for this work. The readings above stay as
recorded (they describe the node at probe time, not a permanent state); what changes is the policy
derived from them:

- A card is claimed explicitly (`CUDA_VISIBLE_DEVICES`) rather than waited for; `contended` now means
  "another compute process on this card", not "the node is busy".
- Clock locking becomes an operator action the tickets may use (`sudo -n` works), with the reading
  recording `clockLocked` so locked and unlocked numbers never mix in one comparison.
- The toolchain bootstrap no longer needs coordination; it is a normal ticket with an Ask First on the
  install location.
