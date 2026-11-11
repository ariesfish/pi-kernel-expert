# Live GPU integration verification

Task: `/var/folders/s1/fycz4h1s4cj63j43wgjhqj2r0000gn/T/pi-kernel-live-goal-TeiuDf`.
Remote artifacts: `builder:/root/pkex/live-goal-TeiuDf`.

The scripted driver loads both file-based extensions with pi's real resource loader and calls their registered tools through the nested tool pipeline. It exercises schemas, extension hooks, executable checks, journaling, automatic commit and rollback. It does not exercise model-selected tool use or the interactive TUI.

## Recorded outcome

- Human approval: `human-approval.json`; original artifact SHA256 `e60d35608a6ae75d24a12949b2844fa59a3fd36bcc01f6586907ab4aadc0d3a6`.
- GPU: NVIDIA H200, physical index 3, UUID `GPU-6a3efd05-f136-d6ea-9a2b-69740d42387c`, driver 580.178.04.
- CUDA 13.0.88, ncu 2025.3.1.0; pi CLI 1.5.2, SDK dependency 1.5.0; Node 24.21.0.
- Clocks unlocked; loaded SM sample 1980 MHz, memory 3201 MHz, no foreign GPU allocations at the recorded start/end samples. See `hardware.txt` and the reading blocks.
- One fp32 cell, three input groups, N=16777216 (tail adds 37), five repeats in each of two candidate windows: ten candidate samples per group, 100 launches per sample. Fixed CPU oracle, two check passes and reference-error calibration.
- Baseline and candidate pass correctness. Both readings report mirrored pairing and a thin host enqueue path.
- Corrected keep C2 carries `profile/saxpy_coalesced_recovery/summary.json`; the bound diff and contract hashes match the pre-commit candidate.
- The real keep commit is `cefe1c4e6a5814c4a5433f7a322ad1d1e1a673f6` in the task repository, with `Gate:` and `Criteria:` trailers (`git-log.txt`).
- The deliberately incorrect candidate fails the zero_block group with max_diff 1. The precision gate refuses its keep; C3 records the rejection. pi-goal logs `checks_failed`, saves `goal-state/researches/default/attempts/4.patch`, restores the accepted commit, and restored checks pass.

The strided baseline is deliberately inefficient. The recorded metric ratio is an integration control, not a production speedup claim. Raw medians, per-group spread and sample counts are in `runs/*.stdout`; the compact metric record is `runs/summary.json`.

## Defects exposed and fixes

1. The generated check timeout used the receiver's internal `timeoutSeconds` spelling. pi-goal expects `timeout_seconds`, so the frozen journal omitted the requested timeout. Fixed in pi-kernel-expert commit `4e9aa74`; regression includes the real peer input conversion (`kernel-timeout-integration.txt`). The already-approved live contract was not rewritten: its gate used the default timeout, and each observed check completed well inside the requested 180 seconds.
2. The explicit `:(exclude).goal` Git pathspec fails when `.goal/` is ignored. Fixed in the pi-goal checkout by commit `28f319a`, with real-git ignored/unignored regression tests. `pi-goal-fix.patch` records the tested initial fix.
3. The failed Git settlements still produced keep Run Results before that fix. The original entries and failed warnings are preserved in `goal-state/` and `runs/runtime/`. This is a separate fail-closed settlement defect: a failed commit must not become a kept Run Result or unblock the next iteration. It remains follow-up work; the successful retry does not erase it.

C1 and the first two goal log entries precede the Git fix and do not identify a newly committed candidate. C2 and goal log entry 3 are the verified, committed keep. Goal log entry 4 is the verified rejection/rollback.

## Profile limitations

The full `.ncu-rep`, key metrics, rules and per-source-line stalls are archived. Profiling used `--clock-control none`, separately from benchmark timing. The vendored timeline helper requires `IAction.timed_warp_samples`, unavailable in ncu 2025.3.1; its error is retained in `profile/saxpy_coalesced_recovery/helpers.stdout`. No timeline result is claimed. The summary's SM clock is a post-collection sample, not a locked profiling clock.

No Blackwell run, autonomous skill-routing evaluation, milestone attribution or knowledge publication is covered by this acceptance task. Vendored helper code was not edited.

## Reproduction and history

The task generator, CUDA fixtures and runtime driver are under `.dev/feature-live-goal/`. The pilot used `prepare`, then the human-approved `run`; `resume`, `repair`, and `finish` retained the same task and journal while debugging the driver and peer issues. The acceptance contract was frozen once. Synthetic timeout conversion tests use a disposable workspace and no GPU.

The temporary driver first asserted a nonexistent `details.ok` field; that assertion was corrected to inspect `details.record`. The profile helper then needed CUDA's bin directory on PATH; analysis resumed from the same report. These driver failures did not alter archived measurements.
