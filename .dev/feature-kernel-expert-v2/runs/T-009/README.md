# T-009 — clock lock recorded and corroborated, loaded sample, sample counts

Card 3 on `h200-7`, driver 580.178.04, clocks unlocked except where stated. Fixture:
`.dev/feature-kernel-expert-v2/fixtures/saxpy`, workspace generated with
`make-workspace.mts --clock-sm 1500 --clock-mem 3201`.

| Run | What | Result |
|---|---|---|
| `locked.stdout` | `sudo nvidia-smi -i 3 -lgc 1500`, then `CUDA_VISIBLE_DEVICES=3 bash goal.sh` | `clockLocked {declaredSmMhz 1500, declaredMemMhz 3201, observedSmMhz 1500, held: true}`; `gpu.loaded {clocksSmMhz 1500, clocksMaxSmMhz 1980, utilPct 2}`; `start` also 1500; `hostEnqueueSamples 15`, `deviceSamples 15` |
| `unlocked-claim.stdout` | `-rgc`, same contract, same command | `clockLocked {declared 1500, observedSmMhz 1980, held: false}` + warning "clock lock declared at 1500 MHz but the loaded sample read 1980 MHz: the lock did not hold" |

The second run is the point: the declaration is **checked against the loaded sample**, not trusted.
A declaration is not evidence; a declaration that survived the run is.

## Why `gpu.loaded` exists

`gpu.start` is sampled before any work, so on an idle card it reads the parked clock (345 MHz
unlocked). Without a loaded sample the block can say what the card was doing before and after, and
nothing about what it ran at.

## What is still not detectable

`nvidia-smi` exposes no "lock in force" field on this driver (`-q -d CLOCK` reports
`Applications Clocks Setting: Not Active` regardless of `-lgc`). An *undeclared* lock is therefore
invisible, which is why `clockLocked` is absent — not `held: false` — when no lock is declared: the
reading says "not declared", never "not locked".

The generic warning (busy card far below its own max clock) is suppressed when a lock is declared,
since it would only restate the declaration; it exists for the unlocked case where a power or
thermal cap would otherwise read as ordinary load.
