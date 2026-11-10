# ForgeKernel analysis skills — surface, mechanism, portability

Read: `skills/{sass,stall,timeline,lever-pricing,job-env-check,ncu-trace,orchestration}/`,
`skills/README.md`, `src/forgekernel/skills/__init__.py`.
All line cites are into `ForgeKernel/`.

**One-line framing.** A skill here is *not* a prompt. It is a Python module that is
(a) mirrored as a directory into the agent's `.claude/skills/` for reading, and
(b) committed verbatim into the GPU job tree's `notes/` so the job runs it as
`python3 notes/<tool>.py`, and
(c) imported by the harness as `forgekernel.skills.<module>` to parse its one verdict line.
The prose `SKILL.md` and the executable are the same artifact delivered down two channels
(`src/forgekernel/skills/__init__.py:1-10`, `skills/README.md:1-6`).

---

## 1. Per-skill contract blocks

### `sass` — 5 tools, static SASS reads

**Question.** What did the compiler actually emit: which kernel, which opcodes, is the MMA
A-operand a register or an smem descriptor, what is the schedule order and its register
price, how is each phase *built*, and what launch shape was it given?

**Surface.** Library calls inside a probe (the driver seeds the files into `notes/`):

```python
import sass_tools
sass_tools.analyze(page_text, profiled_kernel, launch_pairs)   # skills/sass/SKILL.md:20
sass_census.census_from_text(text) -> dict; render_census_line(c, kernel)
sched_live_tools.report(sass_text)                             # -> (sched_ok, live_ok)
struct_tools.report(sass_text, exec_counts, kernel, ncta)
launch_tools.report(text, kernel)
```

Standalone CLIs: `python3 sass_tools.py <sass_file> <profiled_kernel_name>`
(`skills/sass/sass_tools.py:238`), `python3 sass_census.py <sass-dump-file> [<kernel-name>]`
(`sass_census.py:258`), `python3 struct_tools.py <source.csv|sass.txt> [--kernel NAME] [--ncta N]`
(`struct_tools.py:504`). `sched_live_tools` and `launch_tools` are library/`report()`-only.

**Inputs on disk.** One SASS page — either the NCU `--set source` page text (bare
`0x…` address column) or `cuobjdump -sass` output (`/*0028*/` comments). Both formats are
handled by one parser (`sass_tools.py:78-110`). For `struct_tools`' *who*-column you also need
the CSV form with per-PC "Instructions Executed": `ncu --import rep --page source
--print-source sass --csv` (`struct_tools.py:108-147`). `launch_tools` takes any text carrying
`launch__*` metrics, `--page details` rows, or `key = value` lines (`launch_tools.py:135-161`).
No GPU at analysis time for any of the five.

**Output shape** — one machine line each, plus a human table:

| tool | verdict line | fields |
|---|---|---|
| `sass_tools.py:224` | `SASS-OK` / `SASS-FAIL <problems>` | `kernel= instructions= opcodes=` |
| `sass_census.py:92` | `SASS-OPERANDS` / `…-FAIL` | `kernel= mma_total= a_reg= a_desc= a_other=` |
| `sass_census.py:198` | `WGMMA-SERIAL` / `-SKIP` | `kernel= wgmma= depbar0= tight= ratio=` |
| `sched_live_tools.py:911` | `SCHED-OK/FAIL` | `loop= hgmma_runs= depbars= ew_runs= depbar_before_each_ew=[…]` |
| `sched_live_tools.py:633,670` | `SCHED-OK/FAIL isa=` | `mma_sync`: `mma_runs= barriers= ldsm=`; `tcgen05`: `utcmma_runs= commits= mbar_waits=` |
| `sched_live_tools.py:941` | `LIVE-OK/FAIL` | `peak= guessed_frac=` |
| `struct_tools.py:497` | `STRUCT-OK` / `-FAIL reason=` | `kernel= regions= segments= warps= precision= granule=` |
| `launch_tools.py:202` | `LAUNCH-OK` / `LAUNCH-PARTIAL` | `kernel= grid= block= ctas= cluster= cluster_max_active= regs= smem_dyn=` |

**Decision changed.** Each one closes a specific *wrong inference* the agent would otherwise
make:

- `pick_kernel` by duration, not by launch order — `kernels[0]` was `torch.randn`'s RNG and the
  histogram was self-consistent nonsense and unfalsifiable by eye (`sass_tools.py:1-19,125-138`).
- `a_reg` vs `a_desc` separates "budget reserved" from "path built": a kernel can hold the
  register budget and still feed the A operand through smem (`sass_census.py:3-13`).
- `wgmma_serial_ratio` names **ptxas**, not the algorithm: when the compiler cannot prove the
  accumulator untouched between issue and wait it inserts a wait per wgmma for the whole
  function. Reference 0.15; fallback ~1.0; thresholds `SEVERE=0.9`, `ELEVATED=0.5`
  (`sass_census.py:144-145,227-256`). Live incident: a student changed the solver, ptxas
  serialized the consumer's 28 HGMMAs, the teacher banned the direction over a −12% it
  mis-attributed (`sass_census.py:131-141`).
- `depbar_before_each_ew` / `handoff_before_each_ew` is *the* overlap fact: `LE 1` = a chain
  deliberately left in flight over the elementwise run; `LE 0` = drain everything
  (`sched_live_tools.py:328-345`, `593-608`).
- `LIVE-OK peak=` prices the schedule: transplanting the ref's schedule alone was correct but 6%
  slower with spill 0 → 10.8M sectors; ref numbers peak 232/240, non-accumulator working set
  93 words (`sched_live_tools.py:36-43`).
- `STRUCT` says how a phase is built (8×8 vs 16×16 blocks, fp16 vs bf16, split-K), which no
  count/price channel does — one run built the wrong triangular-inverse shape for 17 hours off
  an inference the SASS contradicted (`struct_tools.py:3-22`).
- `LAUNCH-OK cluster=` kills the "cluster from grid shape" fallacy: a B200 ref launches a flat
  128-CTA grid with `launch__cluster_dim_x = 16`; reading "no cluster" made the first student
  kernel 16× slower (`launch_tools.py:3-30`).

---

### `stall` — the per-instruction ledger + the frozen collection recipe

**Question.** Which SASS instructions is the time leaking from, and how much at each?

**Surface.**
- Library: `stall_tools.price_report(report_path, ir=None, kernel_substr="", sass_csv=None)`
  (`stall_tools.py:436`), `stall_tools.segment_ledger(report_path, kernel_substr=…,
  sass_text=…)` (`:628`).
- CLI: `python3 notes/stall_tools.py --report /tmp/p.ncu-rep --ir /tmp/dsl_ir
  [--kernel-substr S] [--sass-csv F]` (`:503-512`).
- Recipe: `python3 notes/stall_price_run.py [--pm] [--pm-interval N] [--workload W]
  [--app argv…]` (`stall_price_run.py:349-411`) — driver-only, not a student tool
  (`skills/stall/SKILL.md:11-12`).

**Inputs on disk.** A `.ncu-rep` collected with `--set full` or `--set source`, the Nsight
`ncu_report` Python module (auto-located under `/usr/local/cuda*/nsight-compute*/extras/python`,
`stall_tools.py:52-83`), optionally `CUTE_DSL_DUMP_DIR` for line→file recovery, optionally the
SASS CSV. `stall_price_run` needs `eval/ncu_run.py` at repo root and writes `/tmp/stallprice.ncu-rep`.

**Output shape.** ~80 rows max, printed most-expensive-first until cumulative coverage ≥ 90.0%
(`COVERAGE_FLOOR`, `:108`; `MAX_ROWS=80`, `:130`), between
`=== STALL LEDGER BEGIN/END ===` (`:132-133`). Row = `samples pct (cum) key sass | top3 stalls`.
Then an *opcode family × dominant stall* table, then the segment ledger between
`=== SEGMENT LEDGER BEGIN/END ===` with machine lines

```
SEG idx=<n> kind=<HG|DEPBAR|SYNC|SLEEP|TMA|BAR|BRA|EXIT|EW> depth=<DEPBAR imm|none> [imm=0x..] pct=<x> stalls=<k>:<pct>,<k>:<pct>
```

(`:741-744`), plus *elementwise cost by DEPBAR depth in force*, *cost by segment kind*, and
`JOIN-OK resolved=<pct> body_samples= segments= hgmma_runs= depbars=` (`:772`). Verdict lines:
`STALL-OK kernel= samples= rows= coverage=` (`:498`), `JOIN-OK`/`JOIN-FAIL`
(`:530-531`, `JOIN_FLOOR=0.50`).

**Decision changed.** Licensing a locus. A locus the ledger prices at 1% is not the bottleneck
however plausible it reads; the docstring records a meta step spent 10h on two loci the ledger
would have priced at ~1pp each (`stall_tools.py:3-10`).

---

### `timeline` — when it leaks (PM series) and per-segment cycles (probe)

**Question.** The ledger sums every phase that touches the same PCs. When in the kernel does
the time sit — ramp, plateau, drain, anti-phasing — and for a serial/latency-bound kernel, how
many cycles does each loop-body segment take and who waited on whom?

**Surface.**
- `pm_timeline_tools.timeline_report(report_path, kernel_substr="", buckets=100)`
  (`pm_timeline_tools.py:298`); CLI `python3 pm_timeline_tools.py` (`:360`).
- Recipe: `python3 notes/pm_timeline_run.py [--interval N]` (`pm_timeline_run.py:40-47`);
  default `INTERVAL = 8192` cycles, `BUFFER = 268435456`. `--interval 2048` for <0.5 ms kernels
  (`skills/timeline/SKILL.md:10`).
- `python3 notes/timeline_probe.py [--mode all|waits] [--kernel kernel.py] [--workload W] [--dry]`
  (`timeline_probe.py:1455-1473`); CUDA kernels go through `--cuda-run` (`:261`, `:395`).

**Inputs on disk.**
- PM path: a `.ncu-rep` with `--section PmSampling --section PmSampling_WarpStates` (`:125-128`).
- Probe path: the student's committed `kernel.py` at repo root (`ROOT`, `:125-126`) containing
  `def _seg(site, row=0): return None` no-ops. The probe **rewrites the source** into a
  `stamped` variant — marker def → stamp preamble, every `_seg("literal", row)` call → one
  predicated `st.global.u64` per stamp, lane 0, first `NSLOT×STRIDE` CTAs, no branch, no extra
  kernel arg (slab address baked in). Tree copy must equal harness copy or the driver refuses
  (`src/forgekernel/loop/driver.py:5459-5550`).

**Output shape.**
PM block `=== PM TIMELINE BEGIN/END ===`, per series
`PM <series> n= active=[lo,hi] max= plateau= ramp= drain=` + 100-point downsampled row;
non-anchor series get a one-line `PM-` stat row. Verdict `PMTL-OK kernel= series=
stall_series= stall_samples=` (`pm_timeline_tools.py:355`) / `PMTL-FAIL reason=…`.

Probe block, machine lines the driver parses (`timeline_probe.py:90-101`):

```
TL-ROLE role=<r> warps=<n> rows=<n> period=<cyc> iqr=<frac> busy=<cyc> wait=<cyc> wrap=<cyc>
TL-SEG  role=<r> from=<site> to=<site> kind=<busy|wait|wrap> median=<c> p25=<c> p75=<c> n=<k>
TL-PHASE role=<r> site=<site> offset=<cycles>
TIMELINE mode=<all|waits> sites= rows= slots= numeric=<identical|pass-both|differs>
         perturbation=<ratio|n/a> span_ratio=<x|n/a> mono_bad=<k>/<tot> sm_mhz=<f>
         base_ms= stamped_ms= sm_src=<sampled|env|default> restarts=<k>/<tot>
TIMELINE-WARN … (n) | TIMELINE-COVERAGE <full|partial> | TIMELINE-OK | TIMELINE-FAIL reason=
```

**Decision changed.** Phase-shaped hypotheses the per-PC ledger destroys by construction
(`pm_timeline_tools.py:3-11`), and — for a serial recurrence where nothing hides an exposed
cycle — replacing an aggregate NCU ratio with *cycles per chunk per role*
(`timeline_probe.py:3-12`).

---

### `lever-pricing` — measured prices of candidate levers

**Question.** What does each candidate change actually buy, alone, in the full stack, and off
it — and which lever is worthless alone but required by the others?

**Surface.** `python3 notes/lever_pricing_run.py [notes/levers.json] [--no-roles] [--workload W]`
(`lever_pricing_run.py:836-845`). Teacher writes `notes/levers.json`; the driver injects
`kernel_file` and `rounds` (`skills/lever-pricing/SKILL.md:8-22`). Ablation-only specs can also
arrive as `PROBE_REQUEST: notes/<name>.json` (`SKILL.md:24-25`).

**Inputs on disk.** `notes/levers.json` with `{kernel_file, rounds, levers:[{name, edits:[{old,new}],
expect, in_stack}], variants:[{name, levers, question}], ablations:[{name, edits, hypothesis,
decisions}]}` (full schema in the module docstring, `:16-74`); the kernel source at repo root;
`eval/bench.py --mode all` and `eval/leaderboard/problem.json` (`:181`, `:643`); a GPU.

**Output shape** (`:101-112`):

```
LEVER <name> add=<+x.xx%> remove=<-y.yy%> add_ms= remove_ms= class=<independent|coupled|dependent|null|harmful|unstacked|noop|broken|unmeasured> spin_add=<ns> spin_all_minus=<ns>
VARIANT <name> levers=<a,b> delta=<+x%> ms= spin= q=<question>
STACK all=<+z%> sum_singles=<+s%> coupling=<z-s pp> all_pos=<+p%|n/a> all_pos_levers=<..> dropped=<..>
PRICE noise_floor=<n.nn%> metric=<vs_ref_device|device_ms>
ABLATE <name> delta=<+x%> ncu_ns= base_ncu_ns= correctness=<pass|fail|nojson|skipped> device_delta= kernel= status=<ok|hung|nodata|budget>
PRICE-TIMED levers= rounds= | PRICE-OK … | PRICE-FAIL reason=
```

**Decision changed.** Which lever to keep, package, subsume, or drop — including the two
readings a naive "did it help?" cannot produce: `coupled` (≈0 added, negative when removed) and
`harmful` (costs alone *and* the stack does not miss it), which triggers an automatic `all-pos`
pass with a fresh interleaved base (`:78-88`, `plan_all_pos` at `:1255`).

---

### `job-env-check` — can the job's bare `python3` run anything?

**Question.** Can `python3 notes/<tool>.py` import torch on this node, and (with `--cuda`) does
the image carry `nvcc` / `ninja` / CUTLASS headers?

**Surface.** `python3 notes/job_env_check.py [--cuda]` (`job_env_check.py:53-77`), run once per
loop start by the driver (`skills/job-env-check/SKILL.md:9`).

**Inputs.** Nothing on disk. Runs `python3 -c "import torch; print(torch.__version__)"`
in a subprocess with a 600 s timeout (`:59`), plus `shutil.which("nvcc")`, `which("ninja")`,
`$CUTLASS_DIR/include/cutlass/cutlass.h` for `--cuda` (`cuda_toolchain_problem`, `:29-51`).

**Output.** Exactly one line: `JOB-ENV-OK python3=<path> torch=<ver> [cuda-toolchain=ok]` or
`JOB-ENV-FAIL python3=<path> <last line of failure>`, with the failing import's own text printed
above it (`:66-77`).

**Decision changed.** Whether to trust "the kernel evaluates fine" as evidence that the toolchain
works. On an ssh host the job runs in a non-login shell; the card's venv need not be first on
PATH, so every timeline/ledger/pricing attempt dies on import while the kernel scores normally
(`job_env_check.py:3-19`).

---

### `ncu-trace` — cross-iteration NCU metric evolution (teacher-side)

**Question.** Did the metric the decision was supposed to move actually move, across rounds —
and what does hardware ground truth say the binding constraint is, against the student's
self-reported prose?

**Surface.** Not a script: two harness subcommands.
`forge <op> ncu-report` → one bottleneck verdict per round + key metrics tagged
`severe`/`elevated`; `forge <op> ncu-trace` → raw per-iteration metric table
(`skills/ncu-trace/SKILL.md:28-40`; entry points `src/forgekernel/__main__.py:58,63`;
renderers `src/forgekernel/inner/ncu.py:759,764`). Also readable directly as `profiler[]` in
`operators/<op>/student/digest.json`.

**Inputs on disk.** A run directory with per-round `IterationRecord.profiler` dicts, produced by
`forgekernel.inner.ncu.profiler_from_ncu(csv)` (`inner/ncu.py:411-414`) from the operator's
`gpu_entry.sh ncu` task. Needs the FK record model, not just a `.ncu-rep`.

**Output.** `KEY_METRICS` dict per round (`inner/ncu.py:42-80`): `time_ns, regs_per_thread,
spill_ld_sectors, spill_st_sectors, bankconf_st, bankconf_ld, smem_wavefronts_st,
smem_wavefronts_ld, tensor_pct, warp_active_pct, stall_long_sb, stall_mio, stall_barrier,
dram_pct, dram_bytes_read/write, smem_static, smem_dynamic, grid_size, block_size`, per launch.
Thresholds (`inner/ncu.py:478-499`): spills `10M/1M`, `dram_pct 80/70`, stalls `20/5`,
`tensor_pct <15/<30` (lo), `warp_active_pct <10/<20`, `wgmma_serial_ratio 0.9/0.5`; wavefront
volume judged only as a **ratio to the ref** — `≥2.0 severe, ≥1.3 elevated`
(`:501-503`). One-line verdict strings from `summarize_metrics` (`:552-608`), severity-ordered
with `wgmma_serial_ratio` checked first.

**Decision changed.** Which of three indistinguishable stories ("bank conflict / spill /
memory-bound") the same sentence describes — and whether to route to a KB recipe (G3), a
foundation-ceiling ruling (R1), or a milestone change (`SKILL.md:52-64`). It explicitly refuses
the student's `binding_constraint` prose as load-bearing (`SKILL.md:80-90`).

---

### `orchestration` — dossier, per-iteration census, role exposure

**Question.** What is the sync topology and supply organisation (who arrives, who waits, on which
barrier object, in what order), and **which warp role leaves the tensor pipe idle, by how many ns**?

**Surface.**
- `orch_tools.report(sass_text, launch=…, kernel=…)` (`orch_tools.py:951`);
  `orch_tools.diff_summaries(ref_summary, stu_summary)` (`:1241`) / `diff_report(ref_sass,
  student_sass)` (`:1268`).
- `python3 notes/orch_census_run.py [--full] [--kernel kernel.py]` (`orch_census_run.py:249-286`)
  — wraps `bash gpu_entry.sh ncu` with `CUTE_DSL_KEEP_CUBIN=1` + `CUTE_DSL_DUMP_DIR`, streams
  NCU stdout through line by line, disassembles the largest dumped cubin, prints the census lines
  **last**.
- `role_exposure_tools.report(report_path, sass_text=…, launch=…, kernel_substr=…)` (`:197`);
  `align_roles(ref_core, student_core)` (`:344`) prints the side-by-side table.

**Inputs.** A SASS page with numeric branch targets (nvdisasm's `.L_x_N` labels must be resolved
to hex first — `orch_census_run.resolve_labels`, `:76-97`, else "every backedge vanishes and the
census reports a kernel with no loops"). For role exposure: one `.ncu-rep` with PC sampling
(+ PM sections, or `sm__pipe_tensor_cycles_active.*`, for the tensor term).

**Output.** `=== ORCH DOSSIER BEGIN/END ===` with sections: regions (`r<id> <kind> <label>
[addr..addr] <n> instrs HGMMA=.. LDGSTS=.. …`), named barriers (`id 0x1: ARV x4 @r2 SYNC x4 @r3
width=256 -> publish-handoff (ARV one side, SYNC other -> serial chain)`), mbarrier objects
(`[CONST|RING|THREAD|UNRESOLVED] <fingerprint>: ARRIVE@r2 x4 WAIT@r5 x4`), edges
(`<fp>: r2(copy-producer) -> r5(mma-consumer)`), commit groups
(`r5(mma-consumer): DEPBAR {LE 0x1 x12} LDGDEPBAR x0`), merge placement, issue-then-correct
nominations, supply order
(`r2: addr-source loads 37 (2/37 in top quarter -> interleaved); copies 41; tight-chained copies 29`),
cache-policy opcodes verbatim. Then one `ORCH-SUMMARY-JSON: {…}` line and
`ORCH-OK regions= loops= nbar_ids= mbar_objs= resolved= edges= itc_candidates=`
(`:1064`). `ORCH-DIFF mismatches=<n>` for ref-vs-student (`:1264`).

Role exposure: `=== ROLE EXPOSURE BEGIN/END ===`, per role
`ROLE label=copy-producer regions=2 samples=5123 share=38.1 exposed_pct=12.4 exposed_ns=8340
stalls=long_sb:61,barrier:22`, per region row (`REGION r5 mma-consumer [0x… .. 0x…] 412 instrs
share=41.2 stalls=…`), one `ROLE-JSON: {…}` core, and
`ROLE-OK roles= samples= resolved= tensor=` / `ROLE-PARTIAL … tensor=none` (`:318-330`).

**Decision changed.** Construction acceptance: the blueprint says two barriers per half-block —
does the compiled student SASS carry them? (`orch_tools.py:52-56`). And the 0.95× residual
question: not "is there non-tensor time" (known) but *which role* owns it, in ns, ref vs student
(`role_exposure_tools.py:3-20`).

---

## 2. The mechanism an LLM cannot do by reading a file

Ordered by how impossible the read is.

| mechanism | where | why an LLM cannot do it |
|---|---|---|
| **Per-PC stall attribution with a coverage contract.** `correlation_ids()` joins all 16 `smsp__pcsamp_warps_issue_stalled_*` counters to sampled PCs; groups key on source line when ≥30% of samples resolve, else on `opcode@pc//0x200`; rows emitted until cumulative ≥90% of all samples (min 10 rows, cap 80). | `stall_tools.py:155-180`, `369-430` | Requires reading an `.ncu-rep` binary through the Nsight Python API, summing 10⁴–10⁶ counters into buckets, and *guaranteeing the slice sums*. An LLM can eyeball a top-10; it cannot certify coverage. |
| **Segment ledger: stalls joined to schedule in ONE address space.** Sampled PCs → body instruction index → contiguous same-kind runs → each segment inherits the `DEPBAR.LE` immediate *in force at its start* via a state machine (DEPBAR sets depth, an HGMMA run clears it to `none`). `JOIN_FLOOR = 0.50` refuses a join below 50% (ASLR / different module). | `stall_tools.py:531-532`, `599-621`, `699-780` | Merges two tools' outputs by address arithmetic. Notably it keeps `BRA/EXIT` (branch is the single most expensive family) where `transcribe()` drops them. |
| **Register liveness over a doubled loop body with decoded register *ranges*.** Backward def-use over `body+body` (steady state for loop-carried values); widths come from ISA tokens: HGMMA RS A-operand `M*K/256`, LDSM/STSM `.xN`, LDS/STS width suffix, mma.sync shape table `{"16816":(4,4,2), ...}`. Peak live count + peak location + provenance by nearest cyclic def (`acc:chain2`, `pack/f16`, `tmem-load`, `smem/const-load`, `addr/temp`, `fp-temp`, `undef/param`). Gate: `96 ≤ peak ≤ 256` and guessed-role instructions `< 25%`. | `sched_live_tools.py:692-812`, `814-850`, `940` | A real dataflow pass over thousands of instructions. The *shape of the answer* (peak 232/240 inside softmax pass A, dP accumulator 64 fully live, S residue 7, non-accumulator working set 93) is what the student's budget target is written against. |
| **MMA A-operand census + ptxas-serialization detection.** Split the operand list on top-level commas, classify operand #2 as `R\d+` (reg) vs `g?desc[` (descriptor) vs other. Separately: count `WARPGROUP.DEPBAR.LE gsb0, 0x0` vs wgmma, and count "*tight*" pairs (a wgmma followed within 4 instructions by such a wait with no wgmma between) — the literal issue-one-wait-one shape. Ratio thresholds 0.9/0.5; cross-checks the ptxas advisory string. | `sass_census.py:48-90`, `164-192`, `193-196` | Two regex/state-machine facts over a 3–4k-line dump that no human reliably transcribes, and that the perf number alone cannot attribute. |
| **Barrier-fenced construction segmentation with warp attribution by ratio.** Regions = ≥2 hits of the same `BAR.SYNC <id>,<threads>` key within `REGION_GAP=400`; warps-per-instruction = `exec_count(ins) / exec_count(barrier) × warps(barrier)`, accepted when integral within `0.06` on ≥90% of costed instructions (else the whole *who* column is not believed → FAIL). Tile granule = smallest recurring immediate stride of LDSM/STSM (`128 B` = 8×8 fp16); precision from the MMA opcode's type suffix; hand-off from offsets one segment STSM/STS-stores and a later one LDSM/LDS-loads. | `struct_tools.py:70-85`, `192-258`, `290-374`, `438-475` | Divisions and medians over per-PC execution counts; and the *downgrades* matter (`x<n>?` instead of a warp count for nested trips / warps outside the barrier / `BAR.ARV` ids). |
| **mbarrier object identity by def-chain chase, with declared tiers.** Follow the address register backwards up to `MAX_CHASE=12` defs; classify `CONST` (chain bottoms in immediates → absolute smem offset), `RING` (self-increment in a loop → stride [+ wrap evidence from an AND-mask/SEL]), `THREAD` (passes through S2R), `UNRESOLVED`. Fingerprint is a canonical identity, not a physical address. Edges = arrive-sites × wait-sites per object, joined across roles. | `orch_tools.py:389-418`, `601-646`, `_summary_from_dossier:1105-1170` | Thousands of SASS lines; and the specific failure it fixes — hand transcription kept "4 ARRIVES.LDGSTSBAR slots" but wrote one-barrier-per-stage into the blueprint, costing ~6 min of GPU probe per hypothesis (`orch_tools.py:3-24`). |
| **Supply-order fingerprint.** In each copy-producer loop: address-source loads in the top quarter ≥70% → `clustered-at-top`, else `interleaved`; a *tight chain* = an `LDGSTS` whose address base register was defined by a load within the previous 4 instructions. A serial gather is all tight chains; a batch prefetch has none. | `orch_tools.py:724-776` | Requires knowing `LDGSTS` spells `desc[UR4][R16.64+0x..], P2, [R23+0x..]` — the *last* memory operand is the gather-latency address, the first is the smem destination. |
| **Role exposure = the three-way join.** stall samples → regions by PC → per role → `exposed_frac = 1 − tensor_active/100` → `exposed_ns = duration_ns × share × exposed_frac`; tensor term from the PM `pipe_tensor_cycles_active` **plateau** (steady state), falling back to the whole-kernel aggregate, and printing `ROLE-PARTIAL` when neither exists. | `role_exposure_tools.py:134-160`, `174-195`, `257-330` | An estimate (declared as one) but with the components printed so it can be rejected; the lesson encoded is that a null-tensor table must never pass as the account. |
| **Phase shape from a PM timeseries.** `active` = indices above 1% of max; `plateau` = mean over the middle half of the active span; `ramp` = fraction of active span before first reaching 90% of plateau; `drain` = fraction after it last holds 90%. | `pm_timeline_tools.py:206-235` | Downsampling 65536→8192 cycles to get ~370 samples instead of ~45 requires knowing the series samples *at* the interval. |
| **Markers → `%clock64` stamps, and the validity algebra that makes the table citable.** Stamp = `%gridid << 48 | clock & (2^48−1)`; slab `NSLOT×NWARP×NROW×NSITE = 8×32×257×128` cells (67 MB). Reads only each kernel's LAST launch (a launch only overwrites cells it reaches). Splits rows into time-monotone runs (row-counter restarts). `.begin`/`.end` on the same stem = WAIT, other consecutive pairs = BUSY, `wrap` = unmarked tail. Validity: numeric identity of the two variants' correctness blocks; perturbation ≤ 3% (else re-run `mode=waits` only); monotone site order violation ≤ 1%; `span_ratio ∈ [0.75, 1.25]` against `device_ms × SM clock sampled while the bench runs`. | `timeline_probe.py:134-140`, `501-545`, `579-742`, `743-846`, `848-906` | Source rewriting + a CUDA/torch slab + clock sampling + five fail-closed checks. Nothing here is a "read the file" task. |
| **Price with a measured noise floor and a coupling lattice.** 2N+2 variants (base, +L, all, all−L) + named subsets; `noise_floor = max(0.5%, 3·√2·1.2533·σ/√R)` where σ is the *student's own* pooled per-round spread (a variant >4× the median spread is dropped as a wild draw). Class ladder: `independent / coupled / dependent / null / harmful / unstacked / noop / broken`. `noop` = byte-identical cubins **and** inside the floor; outside the floor an identical cubin is a launch-config change and classified by the reading. | `lever_pricing_run.py:156-166`, `1205-1218`, `1220-1253` | Statistics + build-level diffing (`cuda_sass_sha`, `:437`) + an interleaved fresh-base second pass for `all-pos` so node drift does not land in the reading. |
| **Ablation priced off the NCU kernel clock, not the bench.** `ncu --metrics gpu__time_duration.sum --profile-from-start off`, base re-timed in the same pass — so a variant that computes garbage is still *timed*; delta = what the ablated mechanism charges today. | `lever_pricing_run.py:189-193`, `1063-1158` | Deliberately decouples "is it correct" from "what does it cost". |
| **Launch shape from metrics, never from grid shape.** `launch__cluster_dim_x/y/z`, `launch__cluster_max_active`, `launch__registers_per_thread`, `launch__shared_mem_per_block_{dynamic,static}`, dims from `*_dim_{x,y,z}` with fallback to `*_size`; accepts raw page, CSV rows, `key = value`, and `--page details` labels. Refuses (`LAUNCH-PARTIAL reason=no-cluster-metrics`) rather than print `(1,1,1)`. | `launch_tools.py:59-70`, `135-234` | The refusal is the mechanism: absence of a metric is not evidence of absence. |
| **A log-bundle so a length-capped read loses no evidence.** The whole analysis text (ledger + SEG scheme + dossier + role + PM) is xz+base64'd into 1000-char lines between `=== PRICE BUNDLE BEGIN/END ===` and replayed at the very END of the job log; `expand_bundle(log)` appends the decoded copy, leaving plain blocks where they are. | `stall_price_run.py:57-116` | Pure engineering, but it is what makes a 500-segment ledger survive a truncated log. |

---

## 3. The skill contract

**Frontmatter.** There is none. `skills/*/SKILL.md` files start with `# <name>`
(verified for all seven: `job-env-check`, `lever-pricing`, `ncu-trace`, `orchestration`, `sass`,
`stall`, `timeline`). The skill's identity is its **directory name**; `SKILL.md` is free prose.
Discovery is `skill_dirs()` = every subdir containing a file named `SKILL.md`
(`src/forgekernel/skills/__init__.py:20-27`). Implication: the description lives in prose, not in
a `description:` field, so there is no machine-readable trigger surface — triggering is done by
prompt text and by the driver's gate messages naming the tool.

**Mirroring into `.claude/skills`.**

```
skills/sass/  ──mirror(workspace)──▶  <workspace>/.claude/skills/sass/{SKILL.md,*.py}
```

`mirror()` rmtree+copytree per skill, skipping `__pycache__`/`*.pyc`
(`skills/__init__.py:30-40`); the caller adds `.claude/` to `.git/info/exclude`
(`loop/agent_policy.py:393-397`, `_git_exclude` at `:400`). It runs at the end of
`AgentPolicy.write_settings()` — i.e. **every agent turn**, replacing whatever a previous turn
left. In parallel, `__path__ = [str(d) for d in skill_dirs()]` (`skills/__init__.py:43`) puts every
skill directory on the package path, so `from forgekernel.skills import sass_tools` and the bare
`import sass_tools` inside a job tree are the same file.

**Seeding into the job tree.** Two lists, both inside `loop/driver.py`:
`RECON_SEEDED_MODULES` (11 modules, `:9950-9960`) → `ctx.recon_dir/notes/`;
`PRICING_SEEDED_MODULES` (13 modules, `:9961-9970`) → `<root>/notes/` for the student, reference,
and ref-pricing trees (`_seed_sass_tools:9973+`, `_seed_pricing_toolkits:10588-10612`).
Both `git commit` the vendored copies, because a job's tree is delivered by `git archive`, which
ships committed files only. `python3 notes/<probe>.py` puts `notes/` on `sys.path`, so
`import sass_tools` is bare and the same file is importable both ways.

**The invocation pattern** (3 forms, one file):

1. `python3 notes/<tool>.py [flags]` — the frozen recipe path (`job_env_check`, `stall_price_run`,
   `pm_timeline_run`, `lever_pricing_run`, `orch_census_run`, `timeline_probe`).
2. `import <tool>` then call the `report()`/`analyze()` function — the probe path
   (`sass/SKILL.md:15-21`: "In a probe (the driver has seeded the files into `notes/`) …").
3. `from forgekernel.skills import <tool>` — the harness path, to parse the verdict line
   (`sass_census.parse_census_line`, `parse_serial_line`, `stall_price_run.expand_bundle`,
   `timeline_probe.parse_timeline`, `orch_tools._DIFF_KEYS`, `lever_pricing_run.build_variants`).

**How output is made machine-readable.** Three rules, uniformly obeyed:

- **Exactly one verdict line per tool, and only the tool prints it.** `SASS-OK/FAIL`,
  `SASS-OPERANDS[-FAIL]`, `WGMMA-SERIAL[-SKIP]`, `SCHED-OK/FAIL`, `LIVE-OK/FAIL`,
  `STRUCT-OK/FAIL`, `LAUNCH-OK/PARTIAL`, `STALL-OK/FAIL`, `JOIN-OK/FAIL`, `PMTL-OK/FAIL`,
  `ORCH-OK/FAIL`, `ORCH-DIFF`, `ROLE-OK/PARTIAL/FAIL`, `PRICE-OK/FAIL`, `ABLATE-OK/FAIL`,
  `TIMELINE-OK/FAIL`, `JOB-ENV-OK/FAIL`.
- **The driver anchors on the full field pattern, not the prefix.** e.g.
  `^SASS-OK kernel=.+? instructions=\d+ opcodes=\d+` (`loop/driver.py:8914`),
  `^STALL-OK kernel=.+? samples=\d+ rows=\d+ coverage=\d` (`:9165`),
  `^STRUCT-OK kernel=\S+ regions=\d+ segments=\d+ warps=\S+ precision=\S+ granule=\S+` (`:9178`),
  `^ROLE-OK roles=\d+ samples=\d+ resolved=[\d.]+ tensor=[\d.]+` (`:9283`),
  `^ORCH-OK regions=\d+ loops=\d+ nbar_ids=\d+ mbar_objs=…` (`:9259`).
  Rationale stated at `:8902-8906`: "prose cannot open the gate".
- **Every block is fenced with `=== … BEGIN/END ===` markers** so the driver can lift it into a
  prompt verbatim: `STALL LEDGER` (`:132`), `SEGMENT LEDGER` (`:529`), `PM TIMELINE`
  (`pm_timeline_tools.py:99`), `STRUCT TABLE` (`struct_tools.py:388`), `ORCH DOSSIER`,
  `ROLE EXPOSURE`, `PRICE BUNDLE`. Plus one-liner JSON cores where a driver-side diff must work
  without the pages in hand: `ORCH-SUMMARY-JSON`, `ROLE-JSON`, and the JSON-safe contract-key
  set `_DIFF_KEYS` (`orch_tools.py:1236`).

**When to stop / escalate — enforced by thresholds inside the tools, not by prose.**
A tool that cannot prove its own read fails closed and dumps raw evidence instead of a summary
(`dump_raw`, `sass_tools.py:174-186`; "silence is failure", `:20-35`):

| gate | value | where |
|---|---|---|
| instruction floor (a real tensor kernel is thousands of lines; the RNG bystander had 400) | 500 | `sass_tools.py:40` |
| stall samples floor | 500 | `stall_tools.py:105` |
| dominant-kernel duration floor (or the profiler window must vouch: ≥2 launches, ≥50% of captured GPU time) | 20 000 ns | `stall_tools.py:106,123-124` |
| ledger coverage floor + row cap | 90.0%, 80 rows | `stall_tools.py:108,130` |
| address-space join floor | 0.50 | `stall_tools.py:531`, `role_exposure_tools.py:57` |
| PM stall-series sample floor | 64 | `pm_timeline_tools.py:89` |
| struct segments per region / region gap / warp integrality | 2 / 400 / tol 0.06 on ≥90% | `struct_tools.py:70-73` |
| liveness plausibility band | `96 ≤ peak ≤ 256`, guessed `< 0.25` | `sched_live_tools.py:940` |
| wgmma serialization | 0.9 severe / 0.5 elevated | `sass_census.py:144-145` |
| probe monotonicity / perturbation / span | `MONO_BAD_MAX=0.01`, `PERTURBATION_MAX=0.03`, `SPAN_BAND=(0.75,1.25)` | `timeline_probe.py:136-140` |
| lever noise floor | `max(0.5%, 3σ)` | `lever_pricing_run.py:156,161` |

**How escalation reaches the agent.** When a required channel is missing, the driver refuses the
finish and hands back a two-option menu: *Deliver* (`write a probe that imports the seeded tool
… end with RECON_REQUEST: notes/<name>.py`) or *Waive* (`<CHANNEL>-WAIVED: <the concrete reason
and the channels tried>`, then end the turn) — `driver.py:9768-9798`, waiver regex at
`:8916` (`^SASS-WAIVED:\s*\S`). A third path exists for format lag:
`_collect_verdict_near_misses` (`driver.py:9196-9220`) records verdict-*shaped* lines that fail
the full-field regex, so an acceptance-pattern mismatch shows both sides on the first turn
instead of deadlocking.

**Audience split is a prose field, not a flag.** `stall/SKILL.md:11-12`,
`timeline/SKILL.md:19`, `lever-pricing/SKILL.md:24-25` each say "Not a student tool: a student
asks for a probe with `PROBE_REQUEST` instead" — i.e. the same script is teacher-only because
the driver, not the agent, decides who gets to run it.

---

## 4. Portability triage

Three classes. "As-is" = drop the `.py` next to a `SKILL.md` in a pi skill dir and call it.

### (a) Portable as-is — stdlib only, no ForgeKernel layout, no GPU at analysis time

| module | lines | deps | caveat |
|---|---|---|---|
| `sass_tools.py` | 253 | stdlib (`re`, `collections`); no in-package imports | needs a SASS dump; `main()` needs a kernel name |
| `sass_census.py` | 274 | stdlib + `sass_tools` (bare-or-package import, `:34-38`) | — |
| `sched_live_tools.py` | 950 | stdlib + `sass_tools` | big, but contains 3 ISA grammars (wgmma / tcgen05 / mma_sync); a pi port can ship all three or trim |
| `struct_tools.py` | 533 | stdlib + `sass_tools`; needs `ncu --page source --csv` for the *who* column | static-only run FAILs the gate by design (`:504-506`) |
| `launch_tools.py` | 238 | stdlib only (`re`, `typing`) | reads any text with `launch__*` / `--page details` rows |
| `orch_tools.py` | 1281 | stdlib + `sass_tools` | needs numeric branch targets (resolve `.L_x_N` first) |
| `job_env_check.py` | 78 | stdlib (`shutil`, `subprocess`) | must run *on the GPU node* |

**Portable-with-a-caveat** (no FK layout, but they import the Nsight module and need a
`.ncu-rep`): `stall_tools.py` (782), `pm_timeline_tools.py` (373),
`role_exposure_tools.py` (431 — lazy imports of the other three, `:386-430`).
They work from any cwd; the only external is `ncu_report`, located by a self-contained search
(`stall_tools.py:52-83`, duplicated in `pm_timeline_tools.py:49-78` because "a vendored file
travels alone").

### (b) Needs the ForgeKernel run-directory / tree layout

| script | what it binds to |
|---|---|
| `stall_price_run.py` (435) | `ROOT = dirname(dirname(__file__))` (`:…`), `DEFAULT_APP = [sys.executable, "eval/ncu_run.py"]` (`:133`), `/tmp/stallprice`, `CUTE_DSL_LINEINFO/KEEP_IR/DUMP_DIR/CACHE_DIR` env contract (`:375-383`), `FK_LB_WORKLOAD_SCOPE` (`:47`), `notes/` on sys.path (`:404`) |
| `pm_timeline_run.py` (70) | `eval/ncu_run.py`, `/tmp/pm_timeline` |
| `lever_pricing_run.py` (1350) | `kernel.py` at ROOT (`:154-155`), `notes/levers.json`, `eval/bench.py --mode all`, `eval/leaderboard/problem.json` (`:181`), `eval/leaderboard` API for the reference ratio (`:175-181`), `TASK_TIMEOUT` job clock (`:206`), GPU orphan sweep (`:223-315`), `--cuda` cpp_extension prebuild (`:343-417`) |
| `timeline_probe.py` (1696) | `kernel.py` at ROOT, `eval/ncu_run.py` as `SLAB_LAUNCHER` (`:1393`), `FK_LB_WORKLOAD_SCOPE`, **byte-identical tree copy** rule enforced by the driver (`driver.py:5459-5550`), blackbox-guard token constraints (`:147-160`, `:1521-1526`) |
| `orch_census_run.py` (287) | `bash gpu_entry.sh ncu` (`:61`), `CUTE_DSL_KEEP_CUBIN`/`CUTE_DSL_DUMP_DIR`, `--cuda` build discovery |
| `ncu-trace` | not a script: `IterationRecord.profiler` + `operators/<op>/student/digest.json` + the `forge <op>` CLI (`inner/ncu.py:759-765`, `__main__.py:58-65`) |

### (c) Needs a GPU

Everything that *collects*: `stall_price_run`, `pm_timeline_run`, `lever_pricing_run`,
`timeline_probe`, `orch_census_run`, `job_env_check` (probes the node it runs on), and
`ncu-trace`'s input pipeline (`gpu_entry.sh ncu`).

Everything that only *reads* a collected artifact needs `ncu_report` but no GPU:
`stall_tools`, `pm_timeline_tools`, `role_exposure_tools`. `sass_tools`, `sass_census`,
`sched_live_tools`, `struct_tools`, `launch_tools`, `orch_tools` need only a text file — a single
archived SASS page is enough, which is exactly why they are the cheap half of the toolkit.

---

## 5. Rank by value-to-an-agent-writing-kernels ÷ porting cost

Value = does it change a decision on the next kernel edit. Cost = lines + external deps + layout
coupling, in the "port into a pi extension" sense.

| # | capability | value | cost | why this rank |
|---|---|---|---|---|
| 1 | `launch_tools.py` | M | **L** (238 LOC, stdlib, zero deps) | Best ratio in the repo. One regex pass kills a documented 16× mis-build; the *refusal* (`LAUNCH-PARTIAL reason=no-cluster-metrics`) is half the value. |
| 2 | `sass_tools.py` | **H** | **L** (253 LOC, stdlib) | Foundation for 4 other tools; two self-check rules (500-instruction floor, family presence, correct kernel by duration) convert "parsed 0 opcodes" from silent success to a loud FAIL. |
| 3 | `sass_census.py` | **H** | **L** (274 LOC, stdlib) | Two decision-grade observables (`a_reg/a_desc`, `wgmma_serial_ratio`) for ~270 lines and no GPU. The serialization census catches a compiler fallback no perf number can attribute. |
| 4 | `orch_tools.py` | **H** | M (1281 LOC, stdlib, but deep SASS semantics) | Highest-value static read: barrier identity, arrive→wait edges, supply order. Portable verbatim; the cost is code size, not coupling. |
| 5 | `struct_tools.py` | M–H | M (533 LOC + one extra NCU CSV collection) | Answers "how is this phase built", the one axis counts and prices both miss. Degrades gracefully to a static table without counts. |
| 6 | `sched_live_tools.py` | **H** | M–H (950 LOC, 3 ISA grammars) | The schedule + liveness pair is the most load-bearing static read for MMA kernels, and the most expensive to port/maintain (Blackwell tcgen05 grammar is a separate subtitle). |
| 7 | `stall_tools.py` | **H** | **H** (782 LOC + `ncu_report` + a `--set full` collection + LINEINFO plumbing) | The single most decision-changing measurement (measured, per-instruction, coverage-contracted). Cost is the collection contract, not the code. |
| 8 | `pm_timeline_tools.py` | M | M (373 LOC + `ncu_report` + PM sections) | Adds the WHEN axis and supplies the exposure scale factor. Worth it only once the ledger exists. |
| 9 | `role_exposure_tools.py` | M–H | M code / **H** operationally (431 LOC, but needs stall + orch + PM all working) | The join is small; the dependency fan-in is the cost. `ROLE-PARTIAL` vs `ROLE-OK` is the load-bearing distinction. |
| 10 | `job_env_check.py` | L | **L** (78 LOC, stdlib) | Near-free insurance. Low value only because it does not change a kernel; it prevents a whole class of "all tools dead, kernel fine" runs. |
| 11 | `lever_pricing_run.py` | **H** | **H** (1350 LOC, bench harness, leaderboard API, GPU job minutes, job-clock budgeting) | The only instrument that measures *which lever pays*. Also the most environment-shaped thing here; a pi port would be a rewrite, not a copy. |
| 12 | `orch_census_run.py` | M | **H** (287 LOC but whole-job wrapper: `gpu_entry.sh`, cubin dump, label resolution) | Valuable for per-iteration drift attribution; useless without the FK job wrapper. |
| 13 | `timeline_probe.py` | M–H | **H** (1696 LOC, source rewriting, slab, SM-clock sampling, 5 validity checks) | Highest specificity, highest coupling, and the tree-copy-equality rule is a harness-level invariant. Port only if per-segment cycles are the missing signal. |
| 14 | `ncu-trace` | M | **H** (not a script; needs the `IterationRecord` model) | Rides the harness's round records. In a pi world the same content is closer to "keep the last N ncu-report outputs and diff them", i.e. a prompt/state design problem, not a port. |

**Reading of the table.** The cheap half (rows 1–5) is ~1 800 lines of stdlib Python that needs
*no* GPU, *no* harness layout, and *no* external package — and it already encodes the hard-won
fail-closed rules. The expensive half (rows 7, 11–13) is expensive for one reason each: a
collection recipe, a benchmark harness, a job wrapper, a source rewriter. Port the first group
wholesale; re-derive the second group's *contract* (verdict line + coverage floor + noise floor)
rather than its code.
