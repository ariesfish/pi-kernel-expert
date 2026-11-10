# T-003 evidence — a reading block from a real, idle H200

Date **2026-11-09** (UTC, as the node reported it). Host **h200-7** (`ssh builder`).

| | |
|---|---|
| GPU | 8x NVIDIA H200 139.8 GiB, sm_90. **Only card 3 used**, claimed with `CUDA_VISIBLE_DEVICES=3` |
| Driver | 580.178.04 |
| CUDA | 13.0, `nvcc` V13.0.88 (`/usr/local/cuda-13.0/bin/nvcc`) |
| torch | 2.14.1+cu130 at `/root/pkex/venv/bin/python` — installed, **not used by this fixture** |
| Clocks | unlocked. No `nvidia-smi -lgc` / `-rgc` was run; no system package was installed |
| Workspace | `/root/pkex/ws-t003`, kernel_init layout (`docs/ .kernel/ profile/ runs/`) |
| Contract | sha256 `d3191f6eb124a9e985433c5bbfcc139c5cc1a5831e5a43968f3437d6ed992747`, schema v2, basis `device`, 1 cell x 3 groups |
| Generator | this checkout at 2026-11-09T09:16Z: HEAD `3436fdc` plus the uncommitted working tree of the moment (another agent was editing `contract.ts` for T-008). The generated files are archived, so nothing here depends on the tree: `goal.sh` sha256 `5c2e5af2f4d339f41540592b3dfbd437057891d04210ffadeaf55e1e28b8bb91`, `goal.checks.sh` sha256 `28178d3a3063bd2ce6d21d7f39e93a7464f668e3aed2c2cac4801efc30e856e3`, both byte-identical on the node |

## Commands actually run

```bash
# fixture, on the node
cd ~/pkex/fixtures/saxpy
/usr/local/cuda-13.0/bin/nvcc -O3 -arch=sm_90 -o verify kernel.cu     # max_diff 1.192092896e-07 on typical
/usr/local/cuda-13.0/bin/nvcc -O3 -arch=sm_90 -o bench  bench.cu

# contract, generated locally with the extension's own code
node make-workspace.mts --root .../ws-t003 --bench "/root/pkex/ws-t003/bench --n 1048576"

# (c) reading, on the node, one card, nvidia-smi sampled alongside
~/pkex/runs/T-003/run-reading.sh /root/pkex/ws-t003 honest-run1 3   # first run: records the baseline
~/pkex/runs/T-003/run-reading.sh /root/pkex/ws-t003 honest-run2 3   # second run: compares (this is the archive)

# (d) the group that fails
cd ~/pkex/ws-t003 && CUDA_VISIBLE_DEVICES=3 bash goal.checks.sh     # exit 1
```

## What the GPU was doing

`gpu.txt` is `nvidia-smi -i 3 --query-gpu=index,memory.used,utilization.gpu,clocks.sm,clocks.mem`
sampled every 100 ms while run 2 ran, plus one all-card snapshot before and after.
The distinct samples for card 3:

| state | samples | meaning |
|---|---|---|
| `345 MHz, 3201 MHz, 0 %, 0 MiB` | 149 (+1 at 1 MiB after the run) | idle; SM clock parked |
| `345→360→390→420 MHz` | 3 | boost ramp once the bench started |
| `1980 MHz, 3201 MHz, 0–4 %, 0–527 MiB` | 49 | load; our own context is the only memory on the card (202 samples total for card 3: 150 parked, 3 ramping, 49 boosted) |
| `foreignProcessMiB` in the block | `0` at start and end | no foreign compute process; the reading is not contended |

Cards 0–7 were all `0 MiB, 0 %, 345 MHz` before and after: the node was idle and only card 3 was used.

## The reading (run 2, full stdout in `reading-honest.txt`)

```
METRIC latency_us_saxpy_typical=4.473
METRIC latency_us_saxpy_zero_block=4.561
METRIC latency_us_saxpy_tail=4.476
METRIC latency_us_saxpy=4.503149335
METRIC geomean_speedup=0.9997405793
```

| field | value |
|---|---|
| `basis` / `basisSource` | `device` / `task-reported` |
| `gpu.name` / `index` / `visible` | `NVIDIA H200` / `3` / `"3"` |
| `gpu.start` | SM 345 MHz, mem 3201 MHz, util 0 %, foreign 0 MiB |
| `gpu.end` | SM 1980 MHz, mem 3201 MHz, util 1 %, foreign 0 MiB |
| `hostEnqueueMs` | 0.002059 ms |
| `deviceMs` | 0.004476 ms |
| `hostBoundRatio` | 0.46000893655 |
| `hostBoundVerdict` | `ok` |
| `pairing` | `absent` (the contract names no `referenceCommand`) |
| per-group medians | 4.473 / 4.561 / 4.476 µs, spread 2.64 / 4.03 / 2.79 %, 5 samples each |
| `shellMs` | 16795 (the shell's own clock around the whole run — not device time) |
| `warnings` | `[]` |
| exit code | 0 |

## Artifacts, one line each

| file | what it is |
|---|---|
| `reading-honest.txt` | **(c)** full stdout of run 2: METRIC lines + the `=== KERNEL READING ===` block. Parses with `parseReadingBlock` → basis device, ratio 0.4600, verdict `ok`, 3 cells, 5 samples each, no warnings. |
| `reading-honest.stderr.txt` | run 2 stderr: empty. |
| `reading-baseline.txt` | run 1, the baseline run: same shape, ratio 0.4664, `geomean_speedup=1 by construction` warning. Archived to show the reading is reproduced, not a one-off. |
| `gpu.txt` | nvidia-smi alongside run 2 (see the clock table above). |
| `checks-zero-block.txt` | **(d)** `goal.checks.sh` output: `FAIL cell saxpy group zero_block pass 1`, `max_diff=0.9999853373`, exit 1. |
| `baseline.tsv` | `.kernel/baseline.tsv` written by run 1: `saxpy  latency_us  4.501981125  lower`. |
| `refusals-honest.txt` | the archived block replayed through `collectRefusals`: **0 refusals** — the honest reading is admissible. |
| `saxpy.kernel.contract.json` | the contract the reading was taken under (sha matches `contractSha` in the block). |
| `saxpy.kernel-freeze.json` | the freeze payload generated with it. |
| `goal.sh`, `goal.checks.sh` | the exact generated scripts that ran (reproducible from the contract + this build). |

## What this settles, and what it does not

Settles: the block is emitted on a real sm_90 node, `hostEnqueueMs`/`deviceMs`/`hostBoundRatio` come
from the task's own `METRIC` lines, clocks move from parked to boosted inside one run, no foreign
process held the card, and the parser accepts the block and agrees with its verdict.

Does not settle: the honest ratio is **0.46**, i.e. 4 % below the 0.5 threshold. At N=2^20 the
enqueue cost is 0.0021 ms against a 0.0045 ms kernel, so this reading sits close to host-bound by
nature. A locked-clock comparison and a `referenceCommand` pairing are separate criteria; neither was
run here.
