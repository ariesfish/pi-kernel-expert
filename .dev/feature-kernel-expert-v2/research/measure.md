# ForgeKernel: how it measures, judges, and defends the measurement

Source: `/Users/ariesfish/Projects/github/dev-skills/ForgeKernel` (paths below are relative to that root).
Purpose: evidence base for comparing against `pi-kernel-expert` (contract cells, geomean speedup,
`noiseFloorPct`, profile evidence bound to a diff hash, candidate ledger).

One-line thesis: ForgeKernel's measurement layer is a **protocol with preconditions and provenance**,
not a number. Every reading carries the *window* it was taken in, the *basis* of that window, the
*enqueue clock's* verdict on whether the window is even valid, the *cluster* it came from, and the
*workload set* it covers — and every consumer refuses a reading whose provenance does not match the
thing it is being compared to.

---

## 1. Measurement protocol

### 1.1 Two windows, deliberately not interchangeable

`src/forgekernel/card_template/eval/timing.py:1-60` (module doc), constants at `timing.py:120-125`:

| window | how it is taken | what it is | constants |
|---|---|---|---|
| **e2e** | `record / call / record / synchronize` per rep; stream idle each rep | single-call latency, host tax included | `WARMUP_ITERS=20`, `E2E_ITERS=50` (`timing.py:120-121`, `time_e2e` `:140`) |
| **device** | one event pair around `N` back-to-back calls, ÷ N; stream never drains | ≈ pure device time, *provided the host can enqueue faster than the device drains* | `DEVICE_BATCH=50`, `DEVICE_REPS=5` (`:122-123`, `time_device` `:157`) |

Same cuDNN attention reads 0.28 ms in the first and 0.25 ms in the second (`timing.py:5`;
`baseline.py:71`) — so ratios may only divide readings from the *same* window
(`timing.py:60-70`: "an e2e ratio is a call-latency claim and only the device ratio is a
kernel-vs-kernel claim").

Default gate window is **device**: `GATE_WINDOW_DEVICE = "device"`;
`GATE_WINDOW_DEFAULT = GATE_WINDOW_DEVICE` (`src/forgekernel/inner/trajectory.py:147-148`).

Map into the eval JSON as `bwd_median_ms` (e2e), `device_median_ms`, `host_enqueue_ms`,
`host_bound_ratio`, `device_window_basis` (read back in `src/forgekernel/loop/parse.py:329-334`).

### 1.2 The device window ships with its own precondition check

This is the load-bearing idea. `time_host_enqueue` (`timing.py:185-205`) times **enqueue only**
(N calls, no synchronize inside the loop), then:

```
host_bound_ratio = host_enqueue_ms / device_median_ms        # timing.py:206-214
```

- `HOST_BOUND_RATIO_WARN = 0.5`, mirrored in `src/forgekernel/timing_audit.py:60` (the card
  template is copied verbatim into job tarballs and may not import the driver package —
  `timing.py:127-132`, `timing_audit.py:56-60`).
- Verdict: host-bound iff `host_enqueue/device - 0.5 >= 0` (`timing_audit.py:110-131`, `classify`).
- **Tri-state, not boolean**: `HostBoundVerdict.measured` (`timing_audit.py:69-96`). No enqueue
  clock ⇒ `ratio=None, measured=False`, and the code says so explicitly: "an absent verdict, never
  a passing one" (`timing.py:208-213`, `timing_audit.py:74-79`).
- The live failure this exists for: reference read 0.4889 ms in the pipelined window, 0.2598 ms
  under CUDA-graph replay, 46% of the "device time" was per-call Python; the resulting target was
  1.86× too loose and an 11.5-hour run produced an uncitable result (`timing_audit.py:1-33`,
  `timing.py:17-30`).

**Basis exemption.** `baseline.py:46-54`: `BASIS_PLAIN="plain_batch"`, `BASIS_GRAPH="cuda_graph"`,
`BASIS_CUPTI="cupti_kernel_span"`, `HOST_FREE_BASES=(cuda_graph, cupti_kernel_span)`. On a host-free
basis the two timings are **never divided** — `classify` returns `measured=True, host_bound=False,
ratio=None, basis=...` (`timing_audit.py:110-131`). A pretzel worth remembering: a bench that prints
`host_bound_ratio: 4.25` alongside `basis=cupti_kernel_span` is *not* host-bound; the driver used to
divide them anyway and told the student its gate reading was "inflated by the host" three rounds
running (dsa_sparse on B200: span 0.01522 ms, enqueue 0.06463 ms; `timing_audit.py:34-52`,
`tests/test_timing_audit.py:150-205`).

**The two sides get opposite treatment** (`timing_audit.py:20-40`, `driver.py:1950-2001`):

| side | verdict | what happens |
|---|---|---|
| reference host-bound | measurement defect | **blocks target derivation** (`reference_blocker`, `timing_audit.py:247-274`) unless a host-free reading is archived; never told to the student (teaching "thin python wins" = teaching metric-gaming) |
| student host-bound | real defect | diagnosed to the student, naming four host causes: recompile/JIT per call, python-side allocation, extra launches, synchronize inside the call (`student_feedback`, `timing_audit.py:277-294`) |
| host-free basis | exempt | deployment note only, explicitly "not part of the gate" (`host_path_note`/`host_path_feedback`, `timing_audit.py:134-185`) |

### 1.3 Paired same-job measurement: burn-in + mirroring

When the reference rides the student job, two bare `measure_windows` calls in a row are forbidden
("never two bare `measure_windows` calls in a row", `timing.py:74-82`). `measure_paired`
(`timing.py:471-530`) does:

1. **burn-in** — `BURN_IN_S = 4.0` seconds with the *kernel under test* before any measured window
   (`timing.py:403-418`). Rationale measured: the first window of a job is 3-5% fastest; later
   windows drift thermally ~2.7% (`timing.py:371-400`).
2. **A B B A order** — ref, kernel, kernel, ref; `order` returned verbatim
   (`timing.py:471-530`; pinned by `tests/test_template_paired_timing.py:47-53`).
3. **each side keeps the mean of its two device readings**; e2e keeps the first window, and
   `host_bound_ratio` is recomputed against the mean the gate actually reads (`_mirrored`,
   `timing.py:452-468`; test `test_device_is_the_mean_of_the_pair_...`).
4. A reference that raises yields `ref=None` + `ref_error`, never a half pair, and then **no
   `ref_*`/`vs_*` keys at all** (`timing.py:49-58` single-ref contract; `paired_performance`
   `:546-596`; tests `test_a_reference_that_fails_its_second_window_yields_no_half_pair`).

Self-ratio of the same callable through `measure_paired` is ~1.000000; through two naive windows it
is measurably off (`tests/test_template_paired_timing.py:100-125`).

### 1.4 Statistics actually used

| quantity | aggregation | source |
|---|---|---|
| e2e reading | **median** of 50 per-call samples; `min_ms` kept alongside | `_measure`, `timing.py:314-327` |
| device reading | median of 5 amortized windows | `time_device` `:157-183` |
| paired device reading | **mean of the two mirrored readings** | `_mirrored` `:452-468` |
| multi-workload verdict | **geometric mean** over 3 workloads; ratio = geomean of per-workload ratios | `PERF_WORKLOADS=3` `:611`; `_geomean` `:613-620`; `workloads_performance` `:714-800` |
| host-bound audit over workloads | **worst** workload (`max`), never averaged | `workloads_performance` `:745-749` |
| archived baseline | **fastest** of N repeat jobs, plus every sample and the spread | `baseline_cli.py:256-262` ("anchoring to the fastest"), `RefBaseline.samples_ms`/`spread_pct` `baseline.py:128-186` |
| cross-job target transport | min-vs-min (archive keeps fastest ⇒ numerator must be a min) | `driver.py:1242-1261`, `_fresh_ref_target` `driver.py:7144-7178` |
| leaderboard per set | median per-call span; FIB = **mean over 3 sets**, SOL = the single timed set | `_protocol` `card_template/eval/leaderboard.py:1557-1563`; `measure` `:1565-1625` |

### 1.5 Repeats and noise floors at the loop level (all relative, all explicit)

| guard | threshold | source |
|---|---|---|
| plateau (meta trigger) | last 3 evaluated iters set no new best beyond **1.5%** of prior best | `detect_plateau(..., noise_floor=0.015, window=3)` `src/forgekernel/loop/parse.py:657-681` |
| suspicious watermark | a KEEP beating best by > **3%** is re-measured before it becomes the watermark | `watermark_margin: float = 0.03` `driver.py:539`; `_confirm_suspicious_watermark` `driver.py:1457` |
| phantom-gap re-anchor | residual within **6%** of target buys a fresh ref measurement before a gap-driven meta diagnosis | `reanchor_band: float = 0.06` `driver.py:560`; `_phantom_gap_reanchor` `driver.py:7352` |
| paired ratio admissibility | **≥ 2** usable ratios and spread **≤ 5%** | `_PAIRED_SPREAD_MAX = 0.05` `driver.py:2679-2697` |
| fresh ref admissibility | **≥ 2** samples, spread **≤ 10%**, same cluster as the anchor | `_fresh_ref_target` `driver.py:7152-7170` |
| cluster re-anchor | ≤ **2 attempts** per cluster per run | `_REANCHOR_ATTEMPTS = 2` `driver.py:1239`; `_cluster_scale` `:1311-1387` |
| false-win memo | re-use the transported-target verdict for **4 h** | `_FALSE_WIN_MEMO_TTL_S = 4 * 3600.0` `driver.py:7128` |
| lever price noise floor | max(0.5%, 3σ × √2 × median-sd/√rounds) | `NOISE_FLOOR_PCT = 0.5` `skills/lever-pricing/lever_pricing_run.py:156`, `noise_floor` `:1205-1217` |

### 1.6 Clock locking

`src/forgekernel/leaderboard.py:804-1000` (generated `gpu_entry.sh`), `SUITE_CLOCK` `:1000-1008`.

- SOL-ExecBench cards lock **SM 1500 / memory 3996 MHz** — the board's B200 preset
  (`SOL_BOARD_CLOCK` `leaderboard.py:109`; `SUITE_CLOCK` `:1000-1006`). FlashInfer-Bench cards do
  **not** lock (the board does not) but accept `LB_SM_CLOCK_MHZ`/`LB_MEM_CLOCK_MHZ`.
- Sequence on **every** entry: clear any leftover lock (`-rgc`/`-rmc`), lock, `sleep
  LB_CLOCK_SETTLE_S` (default **3 s**), read back `clocks.current.graphics,memory`, require every
  GPU within **±50 MHz** (`LB_CLOCK_TOL_MHZ`, `leaderboard.py:839-880`), and reset in an `EXIT`
  trap (also on failure/timeout kill).
- Read-back state is exported as `LB_CLOCK_STATE` and lands in the eval JSON's
  `leaderboard.clock` (`card_template/eval/leaderboard.py:1660-1665`, `performance_block`
  `:1702-1760`).
- **Refusal**: with `LB_REQUIRE_CLOCK_LOCK=1`, a lock that was asked for and did not hold refuses
  **every task except `help`** with `"[gpu_entry.sh] REFUSED: this card times under the board's
  clock lock"` and exit 3 (`leaderboard.py:930-960`). The submitter matches that line only at the
  **start** of a line (`submit/jobs.py:59-66`), resubmits, and after retries raises
  `ClockLockRefusedError`, a `NoRunError` — so the loop treats it as "job did not run", not as a
  kernel REVERT (`tests/test_clock_lock_refusal.py:1-10, 54-72`).
- Reason: T_b/T_SOL are readings *at that lock*; an unlocked reading is faster, and scoring it
  would pass kernels the board fails (`docs/leaderboards.md`, "Clock locking";
  `board_block.clock_warning` `card_template/eval/leaderboard.py:1667-1690`).

### 1.7 What is rejected, and why (exact conditions)

| condition | rejection | source |
|---|---|---|
| `gate_window="device"` but archive has no `ms_device` | `ValueError` at target derivation (re-measure) | `baseline.py:188-250` |
| device anchor host-bound (>0.5) and no host-free reading | `reference_blocker` → `ValueError` unless `allow_host_bound` | `baseline.py:225-245`, `timing_audit.py:247-274` |
| archive `schema_version != 1` | `ValueError`, re-measure | `baseline.py:362-381` |
| archive `cluster != primary cluster` | discarded, baseline treated as absent | `loop/cli.py:1400-1424` |
| gate reading over N workloads vs archive over M | absolute target/scale/ratio **suspended** | `baseline.workloads_mismatch` `:326-351`; `driver._target_workloads_mismatch` `:1273-1300` |
| bench declares no `device_window_basis` | plain basis assumed (legacy) | `baseline.py:99-104`, `device_anchor_basis` `:149-154` |
| CUDA-graph replay < **5%** of the plain device reading | "empty or near-empty capture, not a measurement" → `available=False` | `GRAPH_MIN_PLAUSIBLE_SHARE = 0.05` `timing.py:137`; `implausible_graph_reason` `:811-829` |
| mirrored readings of one side differ by > **1.2×** | `unstable_sets`, warning: "the reading is not a kernel fact" | `UNSTABLE_PAIR_RATIO = 1.2` `card_template/eval/leaderboard.py:1633-1641`, `performance_block` `:1746-1751` |
| a group card timed on a subset (`FK_LB_WORKLOAD_SCOPE`) | eval JSON carries `workload_scope` ⇒ `parse_eval` returns `correctness=False` ("a meta reading, not a gate") | `card_template/eval/leaderboard.py:1763-1800`; `parse.py:277-283` |

---

## 2. Correctness judging

### 2.1 How the judge is generated

`src/forgekernel/judge.py`. Before anything else a teacher turn writes exactly three files into
`<run>/check/` (`judge.py:1-18`, prompt at `:228-288`):

- `definition.json` — signature: inputs/outputs with shape (task axes or positive ints) and dtype
  from `DTYPES` (`judge.py:41-42`); python scalar input = `"shape": null`.
- `judge.py` — `run(<inputs>) -> outputs` (the semantics, clarity over speed, "nothing but torch"),
  and `make_inputs(axes, group, seed, device) -> {name: tensor}`, deterministic in seed.
- `groups.json` — `{shape: [{name, intent, seed}]}` with **≥ 3 input groups per shape**
  (`MIN_INPUT_GROUPS = 3`, `src/forgekernel/task.py:88`; enforced at `judge.py:186-190`).

Static validation (no GPU) is `check_problems` (`judge.py:73-105`): files present and parse; every
declared dim is a positive int or a task axis; no name reused between inputs/outputs; `run` takes
exactly the definition's inputs in order (`_judge_problems` `:136-158`); group names unique, each
with a non-empty `intent`, and group count ≥ 3 (`_group_problems` `:160-201`); and
`_file_group_problems` (`:203-226`) reads the **safetensors header** (no torch) of every task input
file and checks each tensor's shape/dtype against the signature.

Teacher turns: up to `ATTEMPTS = 3` until the static check passes (`launch.py:485-500`). Then the
judge is **frozen**: "The judge is frozen once it agrees with the reference, and every kernel the
run writes is held to it" (`judge.py:278`).

### 2.2 Calibration → tolerance frozen, once

`launch.py:405-446` + `card_template/eval/leaderboard.py:2451-2490` (`--mode calibrate`):

- The reference is run against the judge on **every input group of every shape**; per output the
  largest normalized error `max|y - j| / max|j|` is recorded (`task_error`, `:2250-2286`).
- **`TASK_MATCH_CAP = 0.05`**: if the reference's normalized error exceeds 5% the pair does **not**
  match — "the judge and the reference disagree", and the teacher is re-briefed
  (`:2155`, `:2474-2479`). The cap is what stops a real semantic gap being laundered into a
  tolerance.
- **`TASK_TOL_MARGIN = 2.0`**: the frozen tolerance is `2 × worst reference error`, floored per dtype
  by `TASK_FLOOR` = 2 ulp of the output dtype (`:2144-2153`, `task_tolerance` `:2276-2286`).
- Freezing is a one-way event: `tolerance_frozen` in the run record; `taskcard.set_tolerance` writes
  `"calibrated": "<how>"` into `problem.json` and commits (`src/forgekernel/taskcard.py:204-219`).
  A resumed run breaks out of the calibration loop if `tolerance_frozen` is set (`launch.py:420-424`).
- No reference (generate mode): tolerance = dtype floor only, and the generated reference must pass
  the judge (`launch.py:425-431`).

### 2.3 Input-group coverage ≥ 3 is structural, not advice

- Static: a shape with fewer than 3 groups is a `check_problems` finding (`judge.py:186-190`);
  `Shape.groups_to_add` tells the teacher how many to add (`task.py:143-150`).
- Runtime: the task bench judges **every group of every shape**, and every group is also timed
  (`card_template/eval/leaderboard.py:2287-2320`; `_task_side` `:2337-2390`;
  `measure_windows_workloads` over the groups).
- Multi-workload perf: `bench_workloads_findings` refuses a bench that never calls
  `measure_windows_workloads`, or calls it with a literal list shorter than 3
  (`src/forgekernel/window_contract.py:758-800`, `PERF_WORKLOADS = 3` `:750`).
- The judge is run on a **clone** of the inputs (`_clone(inp)`, `:2303`), so an in-place kernel (or
  an in-place reference) cannot change the truth of the case.

### 2.4 Per-suite tolerance and input draws (reproduced, pinned upstream)

`card_template/eval/leaderboard.py:1-100` (module doc), constants `:176-200`:

| | FlashInfer-Bench (`15618a67`) | SOL-ExecBench (`a9fa0804`) |
|---|---|---|
| input sets | `num_trials=3`, **unseeded**, drawn fresh every job | `seed=200` once, 10 rounds (`SOL_ROUNDS=10`) fresh draws |
| tolerance | `atol=rtol=1e-2`, `required_matched_ratio` default **1.0**; `moe` → 0.95; `moe_fp8_block_scale*` → 0.95 | workload's own, default `1e-2/1e-2`, ratio **0.99**, optional `max_error_cap` |
| element rule | fails iff `|d| > atol AND |d|/(|ref|+1e-8) > rtol` | fails iff `|d| > atol + rtol·|ref|` |
| sanity | shape, dtype, inf/NaN in the **solution** are fatal at once (`fib_judge` `:921-965`) | inf/NaN on **either** side fails (`allow_negative_inf` exception), **all-zero solution vs non-zero reference fails** (`sol_sanity` `:966-984`), `sol_error_stats` `:985-1014` |
| order | reference over **all** sets first, then the solution set by set (`fib_correctness` `:1050-1093`) | reference then solution **every round** (`sol_correctness` `:1102-1185`) |
| timing set | the same 3 sets it judged | the **last** round's inputs |

### 2.5 Round-0 / first-call-only checks (the "first pass" surface)

There is no "only the first call is judged" rule; what exists is stricter and narrower:

- **SOL round 0 is the only round** that checks the return type is strictly `torch.Tensor`
  (lazy-evaluation reward hack), the output shape, the output dtype, **and** snapshots
  `threading.active_count()` into `verdict["threads_after_first_call"]`
  (`card_template/eval/leaderboard.py:1126-1140`; `_lazy_output` `:1095-1100`).
- After timing, a larger thread count than that snapshot is `REWARD_HACK` (thread injection),
  checked in both the single-workload and group paths
  (`:2615-2622`, `:2665-2675`).
- The correctness monitor records at most the **first 64** calls into the kernel module
  (`FK_MON_MAX_CALLS` default 64, `monitor/runtime/hook/fk_monitor_hook.py:571`), and records
  **nothing during CUDA-graph capture** (a host read would break the capture)
  (`fk_monitor_hook.py:142-166`).

### 2.6 Precision gate (the judge's tolerance cannot see it, so a second judge exists)

`src/forgekernel/card_template/eval/precision.py:1-75` (doc), constants `:77-90`.

Rule (`limit`, `:231-233`):

```
fail  iff  e_cand > K_RATIO * e_ref + max(FLOOR_ULPS * u(output dtype), FLOOR_REL)
```

- `K_RATIO = 3.0`, `FLOOR_ULPS = 1.0`, `FLOOR_REL = 2^-17` (`:80-82`); `u(dtype) = 2^-significand_bits`
  (`unit_roundoff`, `:93-98`).
- `e` = relative L2 error vs truth, where truth = **the reference run in float64** (float inputs and
  every float cast lifted; `_Upcast` `:106-140`, `upcast_call` `:173-190`, `truth_of` `:185-208`).
  Fallback float32, else `unavailable` — never a silent pass. NaN/inf where truth is finite ⇒
  `e_cand = inf` (`rel_l2`, `:210-229`).
- `REF_SANITY = 0.25`: if the reference is itself >25% from its own upcast run (randomness / dtype
  branch), the row is `unavailable` (`:294-345`).
- Calibrated on B200 over 14 problems / 1956 readings: honest implementations reach ≤ 0.25 of the
  limit; bf16/fp16 accumulation, tf32 matmuls, fp8-quantized inputs caught on 643/745 moved
  readings, 194/279 that the official tolerance passes (`:29-40`).
- Stress profiles `("offset", "spikes", "amp")` (`:86`), 0.1% of elements at ±12 (`:87-88`), x4
  amplification; first `PRECISION_SETS = 3` input sets plus one set per profile
  (`card_template/eval/leaderboard.py:1850-1853`, `_precision_stress` `:1874-1900`).
- Cost is a policy: `strict` ⇒ a failed check is a correctness failure (REVERT); `official` ⇒
  recorded only; `off` ⇒ not read (`src/forgekernel/loop/precision_gate.py:1-20`, `resolve_contract`
  `:60-85`). A leaderboard card defaults to `off` so its verdict is the board's alone; a card turns
  it on via `problem.json` `precision_contract`. Under `strict`, a wired bench that returns **no**
  precision block is a correctness failure, not "unreported" — the kernel runs in the bench's process
  and could have suppressed it (`MISSING_BLOCK`, `precision_gate.py:38-42`).

### 2.7 Determinism checks

- Monitor `repeat` profile: same inputs twice; relative difference of finite checksums
  (`abs_sum`, `sq_sum`) **> 1e-3** ⇒ `warn` "a race, not accumulation order"
  (`NONDET_WARN_REL = 1e-3`, `monitor/__init__.py:57`; classification `:285-295`). Any difference
  > 0 but ≤ 1e-3 ⇒ `info` (atomics / split order).
- A verdict that flips between two identical runs is an **alarm** (`monitor/__init__.py:267-270`).
- The monitor's output watching covers destination-passing writes: tensor arguments are summarised
  before and after each call, and an argument position any call wrote is an output in every call
  (`_written`, `monitor/__init__.py:133-155`; hook doc `fk_monitor_hook.py:1-30`).
- No-op / not-responding outputs: `constant_output_flag` fires when **3** consecutive correctness
  FAILs carry a bit-identical `max_diff` signature (`CONSTANT_OUTPUT_MIN_REPEATS = 3`,
  `inner/trajectory.py:193-230`) — the diagnosis is "the scored output does not respond to these
  changes at all", not "keep tuning".

### 2.8 What the correctness monitor checks at the end

`docs/correctness-monitor.md` (full), `src/forgekernel/monitor/__init__.py`.

- It **does not replace** the card's judge: it re-runs `gpu_entry.sh correctness` under input
  profiles, so both the kernel and the card's own reference see the same reshaped inputs and the
  card's judge still decides (`docs/correctness-monitor.md:1-25`).
- Profiles (`monitor/__init__.py:37-55`): `base`, `repeat`, `seed1`, `seed2`, `amp` (×4), `tiny`
  (×1/16), `spikes` (0.1% at ±12), `zero_block` (1/8 of last dim, 1/16 of rows), `const_rows`,
  `int_edges` (randint low/high−1, `full` leading 1/16 → 0). Only *normal* draws move; uniform draws
  are left alone.
- Verdict levels (`docs/correctness-monitor.md:55-70`; implementation `classify`
  `monitor/__init__.py:179-310`): **alarm** = base fails, seed fails, stressed fails where the
  reference passes, new NaN under a profile, task dies under a profile, verdict flips;
  **warn** = stressed failure with no `cardref`, checksum drift > 1e-3, NaN on base inputs that the
  judge passed, timeout, cut-short job; **info** = both kernel and reference fail, not-applicable
  profile, ≤1e-3 non-reproducibility.
- It is **advisory**: never fed to an agent, never changes KEEP/REVERT (`docs/correctness-monitor.md:72-78`;
  `monitor/__init__.py:12-20`). The one exception is outside the loop: `forge run`'s exit code counts
  the best kernel as meeting the target only if the monitor raised **no alarm** on it
  (`launch.py:386-397`, `confirmed_at_target`).

---

## 3. Anti-cheat / false-win surface

Enumerated with what each one *actually* detects. Nothing here is a "policy"; each is a check with a
named failure output.

### 3.1 Apparatus integrity (the judge itself)

| guard | detects | where |
|---|---|---|
| **harness guard, delivery check** | a delivery whose commits (probe commits included) edit `eval/`, `gpu_entry.sh`, `ref_bin/`, `.gitattributes` → **REVERT before any job is bought** | `HARNESS_PREFIXES` `loop/harness_guard.py:36`; `_harness_edit_revert` `driver.py:2094-2130`; mode `revert`/`warn`/`off` `harness_guard.py:40-57` |
| **harness guard, hygiene pass** | harness files that reached the lineage *without* a delivery (probe commits with no record, a teacher turn's leftovers committed by `git add -A`) → restored to the launch tree in their own commit | `_harness_hygiene` `driver.py:2054-2092`; drift = `~path` / `+path` / `-path` (`harness_drift`, `harness_guard.py:145-166`) |
| **job overlay** | the tree the job runs carries the **card's tracked harness files byte for byte**, and harness files the card does not have are *removed* (a student-added `eval/sitecustomize.py` is imported by every bench) | `_overlay_wanted` `loop/cli.py:786-800`; `_with_job_env` `cli.py:775-784` |
| **closed-ref leak scan** | a plaintext copy of the reference in either tree: exact sha256 match, or ≥ **40%** of one reference file's "distinctive lines" (≥ **24** chars) | `check_tree` `closed_ref.py:653-700`; `MIN_DISTINCTIVE_LINE=24`, `LINE_OVERLAP_REFUSE=0.4` `:633-634`; run before `forge new` returns (`sealref.py` doc) |
| **SASS precision cross-check** | an MMA input/accumulator type below the reference's or below the card's declared input dtypes (e.g. fp16 accumulation) — **warning only**, never gated | `sass_findings` `precision_gate.py:209-235` |

### 3.2 Reference secrecy (blackbox / sealed)

| guard | detects | where |
|---|---|---|
| **kernel fence (Python)** | the kernel file reaching for the sealed reference, its loader, its key, or compiled-code tooling: `ref_bin`, `ExtensionFileLoader`, `cpp_extension`, `load_inline`, `ctypes`, `cuobjdump`, `subprocess`, `importlib`, `PyInit_`, `sys.modules`, `__loader__`, `inspect`, `.so` … | `KERNEL_FENCE` `card_template/eval/leaderboard.py:494-503`; `kernel_fence` `:561-600`; comments stripped, strings kept |
| **sealed fence (extra)** | the sealed source's loader/IR: `closed_ref`, `ref_payload`, `_REF_KEY`, `linecache`, `/nonexistent`, `unseal`, `settrace`/`setprofile`, `f_globals`/`f_locals`/`tb_frame`, `__builtins__`, `meta_path`, `.triton`, `triton/cache`, `TRITON_CACHE`/`TRITON_DUMP`, `MLIR_ENABLE_DUMP`, `.ttir`/`.llir`/`.ptx`/`.cubin`, `environ`, `/proc/` | `SEALED_FENCE` `:504-525` |
| **CUDA kernel fence** | C/C++ reaching further: `dlopen`, `dlsym`, `dl_iterate_phdr`, `Py*` C-API, `pybind11::`, `cuModule*`/`cuLibrary*`, `cudaGetFuncBySymbol`, `getenv`, `/proc/`, `system`, `popen`, `exec*`, `fork`, `fopen`, `fstream`, `mmap`, `readlink`, `#include "*.so"`, token pasting `##`, `syscall` | `CUDA_KERNEL_FENCE` `:526-544`; `_cpp_code_without_comments` `:537-550` |
| **allowed build flags only** | `// fk-cuda-cflags:` may not smuggle a path, library or linker option | `CUDA_FLAG_OK` `:426-434`; `cuda_kernel_flags` `:435-445` |
| **source window** | reference source is served to `linecache`/`inspect` only while importing or inside `entry()`; purged on window close; warnings silenced | `window()` `closed_ref.py:305-325`; `_SourceLoader.get_source` `:372-380` |
| **sanitized exceptions** | an exception escaping the reference becomes `SealedReferenceError` naming only type + reference-relative `file:line` (a Triton `CompilationError` message can quote source) | `_sanitized` `closed_ref.py:327-346`; `entry` `:615-631` |
| **key out of the job environment** | a keyed payload's key is moved at once to `ref_bin/ref_payload.key` (mode 600) and `gpu_entry.sh` re-execs without the env var, so no process/`/proc/*/environ` carries it | `key_preamble` `sealref.py:83-102`; `_with_key_preamble` `:104-110` |
| **blackbox guard (recon tree & card `cmd`)** | a `cmd` whose words, or whose `notes/*.py|*.sh` / C++ probe files, name the sealed sources, the payload, the loader, SASS tooling, PTX/source print flags, `/Users/`, `find /` … → exit 3 | `REF_TREE_FORBID`/`REF_TREE_HARD`/`REF_TREE_SUFFIXES` `binref.py:40-55`; `CARD_REACH`/`CARD_FORBID` `:69-73`; generated shell `_guard_block` `:122-196`; installed by `guard_card_gpu_entry` `:205-219` and `ref_tree_gpu_entry` `:221-269` |
| **probe allow-list is narrow, not absent** | C/C++ probes are allowed only as plain file names, bare or under `notes/`, `/tmp/`, `/usr/`, `/opt/`, or `#include <lib/path.h>`; globs, bare suffixes, paths through the tree/workspace, and words from `REF_TREE_HARD` still refuse | `PROBE_ALLOW_SED` `binref.py:57-66`; `_guard_block(soft=..., allow_sed=..., hard_files=...)` `:122-196` |
| **shared tripwire** | one seeded `scripts/blackbox-guard.sh` in `notes/`, sourced by `gpu_entry.sh`; the guard skips itself but a same-name file with different content is scanned | `SEEDED_GUARD = "blackbox-guard.sh"` `binref.py:78`; `docs/blackbox-mode.md:43-111` |
| **binary provenance** | the exact `.so` the card times: sha256 + size + ABI note in `ref_bin/PROVENANCE.txt`, committed into card *and* recon tree (a rebuild is not byte-identical) | `binref.install` `:327-380` |

### 3.3 Timing integrity

| guard | detects | where |
|---|---|---|
| **host-bound precondition** | the device window measuring host dispatch instead of the kernel (ratio ≥ 0.5) | §1.2 |
| **clock lock + read-back + refusal** | timing under a clock other than the board's | §1.6 |
| **L2 flush before every timed call** | a reading that rides a warm L2 | `_flush_buffer` (`L2_cache_size × 2` bytes) `card_template/eval/leaderboard.py:1166-1169`; `_reset_persisting_l2` `:1171-1176`; used by all four timers |
| **shifted data pointers (SOL)** | a kernel that keys a dispatch/compile cache on `data_ptr`: every timed call gets tensors at a fresh `data_ptr`, cumulative random shifts of 256 B multiples ≤ 2 KiB, seeded | `_Shifted` `:1178-1218`; `SOL_POOL_ALIGNMENT=256`, `SOL_MAX_SHIFT_BYTES=2048` `:189-190` |
| **rotating input buffers (non-leaderboard)** | the same cache effect on the card's own clock: successive calls rotate through 2-4 pre-built buffers | `measure_windows_rotating` `timing.py:353-370` (live case: a pointer-keyed dispatch cache turned a 0.4 ms kernel into 435 ms/call inside a pipeline while its own bench read 0.4 ms) |
| **burn-in + mirroring** | cold-boost bias to the first-measured side, thermal drift to the last | §1.3 |
| **empty-graph detection** | "CUDA graph succeeded" but captured nothing (PyTorch only warns; a live capture replayed at 0.0013 ms vs a true 0.4 ms) — warning text scraped *and* a 5% plausibility floor | `empty_capture_reason` `timing.py:802-810`; `time_device_graph` `:830-885` |
| **unstable-pair flag** | whole-call outliers under a per-call span clock (host-bound multi-kernel call): two mirrored readings of the *same* side > 1.2× apart | `UNSTABLE_PAIR_RATIO=1.2`, `unstable_sets` `card_template/eval/leaderboard.py:1633-1641`; surfaced as `unstable_sets`/`unstable_note` `:1744-1749` |
| **precondition audit carried on the record** | second ref: an in-job reference whose reading is its own Python dispatch cost — logged and explicitly **not** reported to the student | `_check_host_bound` `driver.py:1950-2001` |
| **mis-aimed profile vs host-idle** | NCU's profiled kernel time covering < **20%** of the timed window; the enqueue clock says which of the two causes it is | `NCU_COVERAGE_FLOOR=0.20` `timing_audit.py:65`; `ncu_coverage` `:187-222`; `ncu_reconciliation_warning` `:296-346` |
| **per-launch NCU aggregation** | keeping only the last launch made a multi-launch kernel look N× faster — indistinguishable from a host tax — and would false-fire the mis-aim alarm | `parse_ncu_csv`/`_aggregate_launches`/`key_metrics` `inner/ncu.py:147-450`; `tests/test_ncu.py:413` |
| **self-test the clock with the reference** | `--impl ref` judges and times the in-job reference *as* the kernel; `vs_ref_device` must read ~1.0 (card self-test) | `run_leaderboard_bench` `--impl ref` `:2525-2545`; `docs/leaderboards.md` "cardref" |

### 3.4 Output / work integrity

| guard | detects | where |
|---|---|---|
| **preallocated outputs are outside the window by construction** | DPS output buffers are allocated *before* the timed call, on both sides, so allocation is not measured and cannot be "optimised" | `allocate_outputs` `:836-845`; `_time_once` builds `args = inputs + outputs` once `:1513-1550`; `call_impl` `:874-890` |
| **prep step is fenced, timed and snapshotted** | work moved outside the timed window: symmmetrized tensors must be declared (name/shape/dtype) in `window.toml`; the bench reports what it produced; a **mutation** of a prep tensor by the timed call fails the iteration (a kernel that wrote state there would make every call after the first a copy) | `measure_windows(prep=...)` `timing.py:328-351`; `mutated_saved` `:269-303`; `_Prep.block` `timing.py:288-305`; `check_prep_report` `window_contract.py:526-600`; enforced as a REVERT by `_enforce_prep_contract` `driver.py:876-895`; prep function is the card author's and may not reference `kernel` (`bench_prep_analysis` `window_contract.py:644-700`) |
| **window contract (both directions)** | a boundary difference between the reference's timed call and the student's (saved tensors, derived inputs, skipped outputs) that would silently favour one side; must be declared `symmetrize`/`price`/`accept` and is priced off the per-kernel tables when `price` | `window_contract.py:1-105`; `window_findings` `:416-500`; `window_credit`/`credited_ratio` `:904-1000` (credit is diagnostic, never a discount: "the raw ratio stays the gate") |
| **all-zero solution vs non-zero reference** | a kernel returning zeros (SOL protocol) | `sol_sanity` `:966-984` |
| **NaN where the judge is finite / non-finite mismatch** | a kernel whose NaN slips through a loose tolerance | `task_error` `:2250-2274`; monitor `classify` `monitor/__init__.py:259-266` |
| **integer / bool outputs exact** | approximate matches on index-like outputs | `TASK_EXACT_DTYPES` `:2156-2159`; `task_error` `:2256-2259` |
| **lazy output** | returning a generator / non-tensor, i.e. deferring the work past the clock | `_lazy_output` `:1095-1100` (SOL round 0, task suite every group) |
| **thread injection** | spawning threads during timing | `threads_after_first_call` + post-timing `active_count` `:1126-1140`, `:2615-2622` |
| **constant output / non-responding kernel** | 3 consecutive FAILs with a bit-identical `max_diff` signature | `constant_output_flag` `inner/trajectory.py:193-230` |
| **variant / lever "no-op"** | a variant whose SASS (sha256 of `cuobjdump -sass`) is byte-identical to base's **and** whose reading agrees within the noise floor — classified `noop`, never priced as 0; two missing dumps are not two equal kernels | `skills/lever-pricing/lever_pricing_run.py:131-135`, `cuda_sass_sha` `:437-455`, class gate `:1229-1235`; `docs/leaderboards.md` CUDA mode |

### 3.5 Loop-level false-win guards

| guard | detects | where |
|---|---|---|
| **false-win confirmation** | an apparent absolute target hit that is a node draw: on a paired run, re-measure the student same-card (2 jobs) and require median same-job ratio ≥ `equivalence_ratio`; on a blackbox run, re-measure the ref this period, transport the target by the drift, re-measure the student (min-vs-min, same cluster) | `_confirm_apparent_target` `driver.py:7176-7370`; live case: a self-ref run stopped at iter 0 having changed no code, anchor vs student 5.1% apart against a 5% goal (`tests/test_false_win_guard.py:1-10`) |
| **phantom-gap re-anchor** | the opposite direction: thinking you are behind because the anchor drifted | `_phantom_gap_reanchor` `driver.py:7352`, band 6% |
| **confirmation stage** | a single-job best is one node draw: the final claim is re-measured `jobs=3` and the ratio is median-vs-median (or median same-job ratio) | `run_best_confirmation` `driver.py:11791-11810`; live case 0.2585 → 0.282 ms across three jobs |
| **workload overfit** | a kernel tuned to one input set: the verdict is the geomean over 3 workloads, and one losing workload drags it below the tuning point | test `test_one_workload_losing_drags_the_aggregate_below_the_tuning_point`, `tests/test_multi_workload_perf.py:67-78` |
| **stale lever price** | a reopen priced by a lever read on a *different* tree | `_stale_price` `driver.py:3268-3281`; test `tests/test_price_staleness.py:389` |
| **stale translation of "target met"** | "best meets target" via an anchor from another period; memoised by transported target for 4 h so a new-but-still-short KEEP does not re-buy the check | `driver.py:7222-7260`, `_FALSE_WIN_MEMO_TTL_S` `:7128` |
| **transport failures are not verdicts** | a job that never reached the GPU (copy/ssh failed), or was killed, or refused on the clock — reported as `NoRunError`/`Lost`, resubmitted, never charged to the kernel | `TRANSPORT_ERROR_MARKER` `submit/jobs.py:49-50`; `STATUS_LOST` `:42`; `TRANSPORT_ATTEMPTS=3` `submit/direct.py:52`; `ClockLockRefusedError` `tests/test_clock_lock_refusal.py` |
| **single-ref contract** | a bench timing a stand-in library "to calibrate node speed", which makes every `vs_*` ambiguous — those readings are dropped loudly at the record boundary | `_enforce_single_ref` `driver.py:1393-1430`; live case: a same-job 1.0418× read as "beat FA" against cuDNN (`timing.py:49-60`) |

### 3.6 What is *not* there (stated so the gap list does not invent it)

- **No `torch.compile` detection.** Repo-wide there is no check for a kernel calling
  `torch.compile` / `torch._dynamo`; the nearest neighbours are (a) the JIT-cache fences
  (`TRITON_CACHE`, `TRITON_DUMP`, `CUTE_DSL_DUMP`, `.ptx`, `.cubin` — `SEALED_FENCE`
  `card_template/eval/leaderboard.py:504-525`) which protect *reference secrecy*, not the clock honesty,
  and (b) the first-call JIT warm-up being outside every profiler window (`ncu_window` runs 3
  warm-up calls before `torch.cuda.profiler.start()`, `:2715-2760`).
- **No static detection of a "no-op" student kernel.** Kernel behaviour is judged only by outcomes
  (outputs, checksums, SASS MMA types, `constant_output_flag`). The `noop` class in lever pricing
  refers to *pricing variants*, not the submitted kernel (`lever_pricing_run.py`).
- **No timing of "a cached result" detection per se.** The defences are indirect: rotating/shifted
  buffers, prep mutation snapshot, per-call L2 flush, non-reproducibility checks, and the
  `window.toml` `produced_by = "cache"` entry (a warm cache is a *declared* asymmetry, not a silent
  free lunch — `window_contract.py:107-115`).

---

## 4. How results from different runs/machines are made comparable

### 4.1 The baseline is an archive, keyed by (operator, shape, hardware)

`src/forgekernel/baseline.py:1-30`: one record per operator — `ref_baseline.json` (library role) and
`arch_baseline.json` (architecture role) (`_ROLE_FILENAMES` `:55`, `baseline_path` `:352-354`).

Why a file, not a loop step: "a baseline is a property of (operator, shape, hardware) — not of one
run … two runs of the same operator should be comparing themselves against the identical baseline"
(`baseline.py:15-20`).

Record fields that make it auditable (`RefBaseline` `:63-131`):

```
op, ms, role, job, shape, hardware, cluster, ref_name, tflops, mfu,
ms_device, device_window_basis, ms_device_plain, ms_device_graph,
host_enqueue_ms, host_bound_ratio, ncu, kernels,
n_workloads, workloads, samples_ms, raw_stdout, schema_version
```

### 4.2 Two roles, never collapsed

`ROLE_LIBRARY` vs `ROLE_ARCHITECTURE` (`baseline.py:29-40`): library answers "are you competitive with
what you'd otherwise call"; architecture answers "did you reproduce the machine the milestone
teaches". For flash_attn_bwd they are ~20% apart; a target derived from the library stops the loop
while it is still far short of the oracle. `target_ms` belongs to the architecture reference; the
library stays as the competitiveness check.

### 4.3 The refusal rules are what make archives comparable

`RefBaseline.target_ms` (`baseline.py:188-250`) refuses, loudly:

1. device-gated but no device reading archived → `ValueError` with a role-specific fix;
2. device window host-bound with no host-free anchor → `reference_blocker` text;
3. `device_anchor_ms` prefers `ms_device_graph` over `ms_device` (`:137-147`) — "the same reference
   with the host taken out… immune to the wrapper thickness the plain window cannot see";
4. `host_bound` computes the verdict against the **plain** reading only; without one the verdict is
   *unmeasured*, not passing (`:156-176`).

Plus: `load_baseline` raises on `schema_version != 1` (`:376-381`); `_cluster_guarded` discards a
baseline measured on another machine (`loop/cli.py:1400-1424`); `workloads_mismatch` (`:326-351`)
compares count first, then names.

### 4.4 Workload-set comparability

A multi-workload reading is a **geomean** and is only comparable to another reading over the *same*
workloads. `workloads_performance` records `aggregate: "geomean"`, `n_workloads`, and one block per
workload with its `name` (`timing.py:714-800`). `parse_ref_stdout` picks the aggregate block and drops
nested per-workload blocks so a key like a graph reading cannot be read off one workload beside a
geomean (`baseline_cli.py:110-140`). The driver *suspends* the absolute target when the bench's
workload count/names do not match the archive's (`driver.py:1273-1300`, `_say_target_suspended`
`:1301-1309`).

### 4.5 Machine comparability

- Every record is stamped with `cluster` (`_rec_cluster` `driver.py:1218-1228`); **every absolute-ms
  comparison** — best, plateau, patch judgment, target stop — reads only rows from the active
  cluster ("one unchanged kernel's absolute latency moves more between machines than most
  single-round gains: the same DSA kernel 2.1441 ms on one, 2.234 ms on another", `driver.py:541-555`).
- Cross-machine transport uses a **ratio of minimums**: `_cluster_scale` divides the fresh min on the
  new cluster by the launch min at home (min-vs-min; a median numerator over a min denominator reads
  the median-vs-min offset ~2% as cluster slowness). It persists `cluster_anchors.json`, allows at
  most 2 attempts, requires ≥2 samples, spread ≤10%, and samples that landed on *this* cluster
  (`driver.py:1311-1387`).
- Reading-without-a-job: `reuse_unchanged_reading` lands a KEEP carrying the **base tree's** reading
  when the commit changes nothing outside `notes/` — explicitly marked `reading_of = iter N` so no
  one mistakes a reused number for a fresh measurement (`driver.py:2509-2555`).

### 4.6 Sealed references: three ways to put a real reference beside the kernel

| route | what travels | what makes it comparable | source |
|---|---|---|---|
| **binref** (compiled) | the `.so`, timed in-job beside the kernel | sha256 + size + ABI note in `PROVENANCE.txt`, committed into card *and* recon tree; same clock/lock as the card; the recon tree carries a copy of the card's `eval/` | `binref.py:271-380`; doc `:1-20` |
| **sealref** (Python source, keyed) | one base85 payload: `FKCR1`/`FKCR2 + mode + sha256(plaintext) + body` (zlib, XOR keystream) | `source_digest` and `payload_digest` printed/archivable; bundle header carries per-file sha256 (files ≥ 64 B); no plaintext on disk anywhere; in-process module, no import collision | `closed_ref.py:119-135`, `_wrap` `:165-185`, `seal_bundle` `:225-250`, `source_digest` `:266-275`; `sealref.py:1-40` |
| **closed_ref** (in-job pairing) | an importable module in memory only, `linecache`-served source inside a window | the *same* input sets and clock as the student; mirrored pairing; exception text withheld | `closed_ref.py:1-118`, `load` `:584-613`, `entry` `:615-631` |

The alternative the module was built to replace: "timing it in a separate tree loses the same-job
ratio and puts a tight target back inside the node-to-node noise" (`closed_ref.py:8-15`).

### 4.7 Leaderboard stopwatch and board anchors

Four timers, first available (`choose_timer` `card_template/eval/leaderboard.py:1485-1505`), recorded as
`device_window_basis`:

| tier | what | basis |
|---|---|---|
| `upstream` | the board's own function *if* its signature matches and `cupti-python` is installed | `cupti_kernel_span` |
| `cupti` | the board's method on cupti-python: discover the call's activity sequence, then per call first-start → last-end; FIB = kernels only + sync after flush + API tracing; SOL = kernels+memcpy+memset, no sync after flush | `cupti_kernel_span` |
| `profiler` | same selection over torch.profiler's CUPTI activities (warning carried: collector differs) | `cupti_kernel_span` |
| `events` | L2 flush + CUDA events per call (the suites' fallback); **not host-free** | `cold_l2_events` |

`cupti_kernel_span` is already in `HOST_FREE_BASES`, so the host-bound check exempts it
automatically (`docs/leaderboards.md`, "Stopwatches").

Board anchors: SOL freezes T_b / T_SOL per workload into `problem.json` `sol_board`, with the board's
clock, and scores `S = 1/(1 + (T_k − T_SOL)/(T_b − T_SOL))`
(`sol_score` `card_template/eval/leaderboard.py:1649-1657`; `board_block` `:1667-1690`;
`SOL_BOARD_CLOCK` `src/forgekernel/leaderboard.py:109`). An unlocked reading is flagged
(`clock_warning`) because the score would compare two clocks.

### 4.8 The currency ladder (weakest → strongest)

1. **single absolute reading** — one job, one node draw; used only for per-iteration throughput.
2. **absolute vs archived target** — requires same window, same workload set, same cluster, valid
   (non-host-bound) device window.
3. **same-period absolute** — ref re-measured this period, target transported by `min/min` drift,
   student re-measured; the weakest *cross-job* currency ("it catches a launch anchor that drifted,
   not a student job that happens to see a faster period than the ref's", `driver.py:7200-7210`).
4. **same-job ratio** — ref and student on one card in one minute, mirrored; "the one verdict
   currency that is node- and period-matched" (`driver.py:519-526`), and the only one that may stop a
   `ref_in_job` run (`_paired_parity_stop` `driver.py:2699-2760`).

---

## 5. Implementable inside a pi extension tool vs requires owning the GPU job

`pi-kernel-expert` is a pi extension: it can read/write files, run processes, parse logs. Split:

### 5.1 Pure file/process work — portable to a pi tool

| mechanism | what the tool needs | portability |
|---|---|---|
| judge file validation (`definition.json`/`judge.py`/`groups.json`: signature order, dtype enum, axis legality, ≥3 groups, safetensors header cross-check) | `ast`, `json`, 8-byte safetensors header read | **direct** — `judge.py:73-226` is stdlib-only |
| tolerance freeze math (`2 × worst`, per-dtype floor, 5% match cap) from a calibrate JSON | arithmetic | **direct** — `card_template/eval/leaderboard.py:2144-2155, 2451-2490` |
| baseline archive: read/write, schema-version refusal, role selection, `target_ms`, `device_anchor_ms`, `host_bound` verdict, `spread_pct` | the JSON file + `timing_audit` logic | **direct** — `baseline.py` + `timing_audit.py` are torch-free |
| host-bound classification + reference blocker + student diagnosis text | enqueue/device/ratio/basis numbers from a bench JSON | **direct** — `timing_audit.py:110-346` has no torch import |
| prep report / window contract enforcement (`check_prep_report`, `window_findings`, `bench_prep_findings`, `bench_workloads_findings`) | `window.toml` + `eval/bench.py` AST + eval JSON `prep` block | **direct** — `window_contract.py` is file/AST only |
| harness guard (delivery diff + drift) | a git repo; `git ls-tree`/`hash-object` | **direct** — `harness_guard.py` is subprocess-only |
| blackbox/closed-ref fence scan (`kernel_fence`, `check_tree`, digest checks) | source text + payload bytes | **direct** — `closed_ref.py`/`leaderboard.py` fence functions are stdlib/regex |
| sealed payload provenance (`source_digest`, `payload_digest`, leak scan) | payload file + key | **direct** |
| leaderboard problem grading from a reported ms (SOL score, `vs_t_b`, clock warning, workload geomean, unstable-pair flag) | eval JSON + `problem.json` | **direct** |
| record ledger arithmetic: plateau (1.5%), watermark (3%), false-win confirmation bookkeeping (≥2 ratios, spread ≤5%, memo TTL), staleness (`priced_on != best`) | the records file | **direct** |
| correctness monitor *classification* from a job log (`=== FK MONITOR JSON ===` / per-profile blocks) | log text | **direct** — `monitor/__init__.py:96-310` is pure Python |
| NCU CSV parsing → per-launch metrics, kernel table, coverage share, pathology flags | CSV text | **direct** — `inner/ncu.py` is `csv`+`re` only |
| "unmeasured is not a pass" as a type-level rule | — | **direct**, and the most transferable single idea |

### 5.2 Requires owning the GPU job (cannot be done from a file tool)

| mechanism | why |
|---|---|
| the measurement itself: e2e/device windows, `time_host_enqueue`, enqueue/device ratio | needs to run the callable on the GPU with CUDA events |
| paired burn-in + A B B A + mean-of-two | needs both callables in one process on one card |
| clock lock (`nvidia-smi -lgc/-lmc`, read-back, reset trap) and its refusal | needs the job's shell as the entry point; it is GPU state, not process state |
| L2 flush, persisting-L2 reset, shifted `data_ptr` pool, rotating buffers | needs live torch allocations on the device |
| CUPTI / torch.profiler spans, activity-sequence selection | needs the profiler in the job |
| CUDA-graph capture/replay + empty-capture detection | needs the capture API |
| NCU run and its `--launch-count`, `--profile-from-start off` window | needs `ncu` around the kernel process |
| precision truth (float64 re-run) and stress inputs | needs torch on the GPU |
| in-process output watching (DPS writes, NaN/inf counts, checksums) and input-perturbing `sitecustomize` hooks | needs to be inside the bench process |
| sealed-reference decoding and in-job timing | must happen on the node (key only there) |
| transport / job lifecycle (tar extract, GPU lock, begin marker, verdict files) | needs to own the submission path |

**Boundary rule that matters for a port**: a pi tool can *demand* evidence and *refuse* a claim when
the evidence is absent (no `host_bound_ratio` ⇒ unmeasured; no `basis` ⇒ plain; no fresh same-period
sample ⇒ no target confirmation). It cannot *produce* that evidence. ForgeKernel encodes exactly this
as a tri-state (`measured=False`) rather than a default `False`, and `reference_blocker` refuses to
fire on unmeasured archives for the same reason — "benches predating the enqueue clock are the normal
state of every archive written before it existed, and refusing those would stop every run rather than
the broken ones" (`timing_audit.py:247-274`).

---

## 6. The five guards `pi-kernel-expert` most lacks

Ranked by what they change about a *claim*, given pi-kernel-expert already has contract cells,
geomean speedup, `noiseFloorPct`, profile evidence bound to a diff hash, and a candidate ledger.

1. **Host-bound precondition on the timed window (with a basis field and a tri-state verdict).**
   `noiseFloorPct` controls variance, not *validity*: a pipelined "device" window behind a thick
   Python path reports dispatch cost under a device label, reproducibly, with correctness passing —
   the exact failure that produced a 1.86×-too-loose target (`timing_audit.py:1-33`). Port:
   `host_enqueue_ms`/`device_median_ms`/`host_bound_ratio` + `device_window_basis` on every reading,
   `host_bound = ratio >= 0.5` only for a plain basis, host-free bases exempt, `measured=False`
   when the clock is absent (`timing_audit.py:60-131`). Without it, a speedup number cannot say which
   physical quantity it measured.

2. **Paired same-job measurement: burn-in + A B B A mirroring + admissibility.**
   Two bare measurements in a row bias the first-measured side by 2-5% (cold boost) and the last by
   thermal drift — "more than half of a 5% equivalence margin" (`timing.py:371-400`). Port:
   4 s burn-in with the kernel under test, `ref, kernel, kernel, ref`, each side = mean of its two
   device readings, and an admissibility gate of ≥2 ratios with spread ≤5% before any verdict
   (`timing.py:403-530`, `driver.py:2679-2697`). A `noiseFloorPct` cannot substitute: it tells you
   the noise is large, not that the bias was cancelled.

3. **Harness immutability: revert on delivery-diff + overlay the card's tracked harness into every
   job tree.** Contract cells assume the apparatus is fixed; ForgeKernel found that a student's
   `git add -A` nails a looser `eval/bench.py` into the next job and the harness judges itself
   (`harness_guard.py:1-25`). Port: a `harness_paths` list (`eval/`, `gpu_entry.sh`, `ref_bin/`,
   `.gitattributes`), a pre-job diff check that REVERTs (with the paths named) and a per-job
   byte-for-byte overlay plus removal of harness files the card does not have
   (`driver.py:2054-2130`, `cli.py:786-800`). This is the cheapest guard to port and the one that
   invalidates every other measurement if missing.

4. **Single-reading validity checks around the timed call: rotating/shifted inputs, prep mutation
   snapshot, L2 flush/empty-graph floor, unstable-pair flag.** These catch a reading that is stable,
   reproducible, and about the wrong thing: a dispatch cache keyed on `data_ptr` (0.4 ms in the
   bench, 435 ms/call in a real pipeline — `timing.py:353-370`), work moved into a prep step and then
   mutated by the kernel (`mutated_saved`, `timing.py:269-303`), an empty CUDA graph replayed at
   0.0013 ms (`timing.py:811-829`), mirrored readings of one side 1.2× apart under a span clock
   (`card_template/eval/leaderboard.py:1633-1641`). Port the *checks* as required fields on a
   measurement record; absent fields are unmeasured, not pass.

5. **Archive provenance invariants with refusal, not warning: (window, basis, cluster, workload set,
   schema) must match what the reading is compared to.** A number is only comparable to a number
   taken the same way on the same machine over the same workloads; ForgeKernel refuses the comparison
   instead of softening it (`baseline.py:188-250, 362-381`; `loop/cli.py:1400-1424`;
   `baseline.workloads_mismatch`; `driver.py:1273-1300`). Given `pi-kernel-expert` already binds
   profile evidence to a diff hash, extending the same hash discipline to *targets, baselines and
   workload sets* — and refusing a claim whose provenance does not match — is the difference between
   a ledger of numbers and a ledger of measurements.

Honourable mentions (cheap, high value, but narrower than the five): clock-lock refusal as a
non-verdict (`submit/jobs.py:59-66`); stale lever price (`driver.py:3268-3281`); `constant_output_flag`
(3 bit-identical diffs, `inner/trajectory.py:193-230`); NCU per-launch aggregation before any
coverage claim (`inner/ncu.py:147-450`); the `workload_scope` refusal that keeps a meta reading from
becoming a gate (`parse.py:277-283`).
