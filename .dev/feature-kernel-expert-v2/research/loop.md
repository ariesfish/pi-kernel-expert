# ForgeKernel — inner/outer loop and its gates

Scope: the loop cluster only. Everything below is read off the repo at
`/Users/ariesfish/Projects/github/dev-skills/ForgeKernel`, with file:line. Design docs
(`docs/design/v1-launch.md`, `docs/design/milestone-distillation.md`,
`docs/milestones-template.md`) are cited as rationale; where they and the code disagree the code
wins and the divergence is marked.

File map for this cluster:

| Layer | File | Lines |
|---|---|---|
| v1 launch pipeline (`forge new` / `forge run` / confirmation / report) | `src/forgekernel/launch.py` | 713 |
| run-directory bookkeeping (`run.json`, status) | `src/forgekernel/runs.py` | 187 |
| task definition loader (`task.toml`) | `src/forgekernel/task.py` | 697 |
| operator-tree generator (`gpu_entry.sh`, `eval/`, `window.toml`, stub) | `src/forgekernel/taskcard.py` | 489 |
| judge authoring + static check | `src/forgekernel/judge.py` | 280 |
| two-layer driver (the state machine) | `src/forgekernel/loop/driver.py` | 11994 |
| legacy loop CLI (all the gates + the finish) | `src/forgekernel/loop/cli.py` | 3235 |
| parsers for agent turns / eval JSON / plateau | `src/forgekernel/loop/parse.py` | 681 |
| milestone schema + DAG | `src/forgekernel/milestone.py` | 838 |
| prefix reuse | `src/forgekernel/resume/invalidation.py` | 119 |
| meta memory | `src/forgekernel/meta_trajectory.py` | 255 |
| inner trajectory row schema | `src/forgekernel/inner/trajectory.py` | 288 |
| lever pricing (the tool) | `skills/lever-pricing/lever_pricing_run.py` | ~1400 |
| per-workload price-table merge | `src/forgekernel/loop/meta_shapes.py` | 711 |
| timed-window content contract | `src/forgekernel/window_contract.py` | 1231 |
| harness guard / precision gate / agent policy | `loop/harness_guard.py` (166), `loop/precision_gate.py` (235), `loop/agent_policy.py` (613) | |

---

## 1. The exact state machine of a run

There are three nested machines: **the run** (launch.py), **the two-layer loop** (driver.py
`run_two_layer`), **the inner iteration** (driver.py `run_inner_iteration`). Each writes a
different artifact and each has its own gate.

### 1.1 Run level — `forge run .artifacts/<op>_<id>` (`launch.py:215`, `:354`, `:397`)

`run.json` status goes `created → running → done|stopped|failed`; exit code is `0` only when the
stop reason is `target` (or the final confirmation meets the target) and `2` otherwise
(`launch.py:363-372`). Step list, in order, with what each writes and what it gates:

| # | Step | Artifact written | Gate / failure path | Evidence |
|---|---|---|---|---|
| 1 | teacher writes the judge | `<run>/check/{definition.json,judge.py,groups.json}` | `judge.check_problems` static check; **3 attempts**, then `RuntimeError` (run failed) | `launch.py:475`, `judge.py:39` `ATTEMPTS = 3`, `judge.py:1-24` |
| 2 | generate the operator tree | `<run>/operators/<op>/` (git): `eval/*`, `eval/bench.py`, `eval/ncu_run.py`, `gpu_entry.sh`, `problem.json`, `kernel.py` stub, `window.toml`, `submit.toml` | none (generation) | `taskcard.py:123-165` |
| 3 | seal the reference (if any) | reference tree `operators/_<op>ref/`, sealed source | student deny list is derived from it (`launch.py:330`) | `taskcard.py:167` |
| 4 | calibrate judge vs reference | tolerance frozen in the card | `TASK_MATCH_CAP = 0.05` normalized max error, else "the judge and the reference disagree" → back to step 1, `_discard_trees` each attempt | `leaderboard.py:2155`, `:2454-2492`, `launch.py:432-455` |
| 5 | NCU probe | `run.json.ncu_available` | if false: `ncu_available=false`, `job_env_preflight="warn"`, `timeline_probe=off`, `stall_pricing=false`, `orch_census=false` — the run **degrades** rather than refuses | `launch.py:511-531`, `taskcard.py:340-352` |
| 6 | write `loop.toml` + clone workspace | `operators/<op>/loop.toml` (gitignored), `<run>/ws` | none | `taskcard.py:290`, `:484` |
| 7 | the loop | `operators/<op>/{milestone.md,student/status.jsonl,meta_status.jsonl,.jobs/<id>/}` | `run_two_layer` | `launch.py:560-574` |
| 8 | best confirmation | `operators/<op>/best_confirmation.json` | 3 jobs on the best sha; median same-job ratio (or median-vs-median after re-measuring the ref this period) | `driver.py:11791`, `cli.py:3118-3185` |
| 9 | correctness monitor | `correctness_monitor.jsonl`, into the confirmation record | **advisory only** — never turns into KEEP/REVERT, but an `alarm` disqualifies the target claim | `monitor/__init__.py:9-17`, `launch.py:384-395` |
| 10 | KB harvest + report | new `hw_kb/**` entries listed, `report.md`, `best/<kernel>` | nothing published automatically | `launch.py:631-656`, `driver.py:3723` |

Pre-flight gates before step 7 (all **refusals**, exit codes distinct): agent policy
(student offline + no reference source reachable) `cli.py:2441-2460`; timed-window content
contract `cli.py:2465-2490`; multi-workload bench `cli.py:2491-2517`; fresh-start contamination
(`--allow-preexisting-artifacts` is the escape) `cli.py:2522-2550`; KB leak lint
`cli.py:3060-3066`; job-environment (`NCU` / bare-`python3` channels) `cli.py:3081-3090`.

### 1.2 Two-layer loop — `run_two_layer` (`driver.py:11398`)

```
start_iter = len(status.jsonl)
if milestone is an empty skeleton:            # _needs_authoring, :8271
    if no ref baseline: return stop=no_ref_baseline        :11448
    recon  (blackbox, or a recon tree is wired)            :11468  run_recon_step :8661
    distill v1                                            :11470  run_distill_step :11295
    if v1 still non-conformant: return stop=distill_malformed  :11478  ← never reaches the GPU
loop:
    reason = run_inner_loop(...)              :11527
    if reason == "first_green": forced M0 audit → maybe patch, then continue   :11532
    judge the pending milestone patch (KEEP/REVERT/HOLD)                       :11602
    if reason not in ("plateau","stuck","exhausted","gate_regression"): return  :11607
    re-anchor a phantom gap before spending meta budget                        :11622
    if meta_steps >= max_meta: return stop=meta_budget                         :11630
    meta diagnose (+probes) + patch (+validate)                                :11640
    compute resume/reopen point, reset workspace there, continue                :11692
```

`_META_ACTIONABLE = ("plateau", "stuck", "exhausted", "gate_regression")` (`driver.py:7721`) — the
four inner stops that are *milestone* defects. Every other reason ends the run.

### 1.3 Inner loop — `run_inner_loop` (`driver.py:2756`), stop reasons with exact conditions

| Stop | Condition (line) |
|---|---|
| `budget` | wall clock past `deadline_epoch` (`:2807`) |
| `max_iters` | `max_iters = 60` turns (`:2810`, default `:431`) |
| `exhausted` | student emitted `EXHAUSTED: <reason>` (`parse.py:94`, `:2829`) — no free-play phase |
| `agent_failed` / `backend_error` / `error` | agent or transport exception, unexpected exception (`:2816-2824`) |
| `prep_unreported` / `prep_contract` | the bench reports no prep block, or the same `window.toml` prep mismatch repeats verbatim (`:2866`, `_prep_structural_stop:901`, `_enforce_prep_contract:876`) |
| `gate_unmeasured` | KEEP with `bwd_median_ms` but no `device_median_ms` while `gate_window=device` (`:2877-2886`) |
| `stuck` | `max_consecutive_reverts = 3` consecutive REVERTs (`:2897`, `:432`) |
| `target` | `best <= target*scale` **and** confirmed same-period (`:2932-2947`, `_confirm_apparent_target:7176`); or same-job parity (`_paired_parity_stop:2699`) |
| `gate_regression` | a post-patch gate row falls behind the previous segment's same gate by more than its declared band + 1.5% (`:2954`, `_gate_regression:7781`) |
| `first_green` | the segment's first correctness PASS (or the `audit_on_gate` row) — the M0-audit trigger (`:2959`) |
| `plateau` | 3 evaluated rows set no new best beyond 1.5% (`parse.py:657`) — unless a declared `part k of n` package is in flight (`:2975`) |

### 1.4 One inner iteration — `run_inner_iteration` (`driver.py:2131`)

Steps in execution order, each with its gate:

1. `_restore_kept_probes` + `_harness_hygiene` — the lineage's card-owned harness files
   (`eval/`, `gpu_entry.sh`, `ref_bin/`, `.gitattributes`; `harness_guard.py:36`) are restored to the
   launch tree **before** the student turn, in their own commit (`driver.py:2054`). *Gate: the student
   cannot edit the judge/clock.*
2. Render the student prompt (`:2153`, `_student_prompt:935`). The prompt carries: the milestone,
   `status.jsonl`, the dead-end table, the open placeholder ledger, the resume/reopen note, and the
   prior probe verdicts.
3. Agent turn, up to `max_probe_rounds = 4` (`:313`). `parse_student_turn` (`parse.py:74`) yields one
   of four shapes: `ProbeRequest`, `ReconRequest` (teacher only), `Exhausted`, or `Record`
   (`decision_id` / `change` / `files_touched`).
4. `_placeholder_bounce` (`:1126`) before anything is committed. Two refusals: **a gate row while the
   placeholder ledger is open** (`[PLACEHOLDER: …]` without `[RESTORED: …]`), and a change text that
   reads as a placeholder without the tag. Bounce = re-prompt, nothing committed.
5. `be.commit("<decision_id>: <change>")` (`:2314`) then `_harness_edit_revert` (`:2315`, `:2093`):
   a delivery whose diff touches a harness path is **REVERTed before any job is bought**, with
   `correctness=None` so a green lineage is not demoted.
6. **Scaffold branch** (`:2325`): if the decision id does not match `_GATE_ROW = /gate/i`
   (`:989`) and either `green is False` (this lineage has never passed correctness) or
   `green is None` **and** the change opens with a declared construction — an unfinished
   `part k of n` (k < n) or a `[PLACEHOLDER: …]` tag (`_declared_construction:7994-8008`) — then
   **no eval is bought**: the row is written `verdict="NEUTRAL", correctness=None`, and the deferred
   verification is spent by the gate row.
7. **Unchanged-tree reuse** (`_unchanged_tree_reading:2511`): if the delivery changed nothing outside
   `notes/` on top of a tree this trajectory already evaluated, the row carries that row's reading
   (`reading_of: <iter>`) instead of buying a second noise draw. Same path serves the
   `[CLOSES: Mk-gate]` archive (`_declared_gate_close:2572`).
8. Push branch `<prefix>-i<iter>`, `submit_gpu(branch, "all")` → correctness + perf; `parse_eval`
   (`parse.py:263`) reads the `=== JSON ===` block; `_enforce_single_ref` (`:1393`) refuses an in-job
   reference that is not the declared one; `_enforce_prep_contract` (`:876`) holds the bench's `prep`
   block to `window.toml`; `_precision_reading` (`:811`) applies `loop/precision_gate.py`
   (`strict` = a failed check is a correctness failure; `official` = recorded only; `off`).
9. NCU on **every committed iteration, KEEP and REVERT** (`:2382`): profiler dict, orchestration
   census, kernel table, serial census, SASS precision axis. NCU is best-effort; a passing kernel with
   an empty profiler is retried, a broken kernel legitimately yields none.
10. Verdict: correctness FAIL → `REVERT` + `be.reset(last_good_ref)` (`:2395-2407`). Otherwise
    `_confirm_suspicious_watermark` (`:1457`, :2343) re-measures a KEEP whose reading is about to take
    the watermark on a suspect basis, then `KEEP` (`:2415-2431`). **A perf regression is kept**
    (relaxed revert, `driver.py:13-16`) — only correctness reverts.
11. Post-KEEP side effects, all gated on "this is a new best": `_reprice_cited_levers` (`:2436`),
    timeline probe (`:2446`), then `_declared_gate_close` may file the phase gate row on the same tree
    and the same reading.

Artifacts of one iteration: one `status.jsonl` row (fields in `inner/trajectory.py:20-150`:
`iter, decision_id, change, correctness, verdict, gate-window ms, ref_median_ms/vs_ref,
device_median_ms/vs_ref_device, host_enqueue_ms/host_bound_ratio, metric_before, error, profiler,
sha, cluster, base_sha, orch_summary, kernels, prep, n_workloads, workloads, reading_of, precision`),
one git commit on the student branch, one `.jobs/<id>/` directory with log + verdict.

### 1.5 Who reverts / retries / escalates

- **Revert** is caused by: correctness FAIL, a harness-path edit, a placeholder violation, or a dead
  probe budget. Workspace rolls back to `last_good_ref` = the last KEEP sha (`:2789-2798`, `:2905`).
- **Retry** (same tree, no new row semantics) is bought by: `metric_before` suspicion (watermark
  confirmation), same-period target checks, and per-gate re-measure in the confirmation stage. The
  point of each is that the *reading* is suspect, not the code.
- **Escalation to the teacher** happens only for `plateau | stuck | exhausted | gate_regression`, plus
  two forced entries: the **M0 audit at first green** (`:11532`) and the **per-gate regression** stop.
  The teacher is never consulted per-iteration.

---

## 2. The milestone / decision-graph format

### 2.1 What one decision row contains

Sections are fixed and ordered (`milestone.py:29-40`): `## 0.` problem+target, `## 1.` contract,
`## 2.` DAG+phase order, `## 3.` decision details, `## 4.` known dead ends, `## 5.` global gate,
`## 6.` rules, `## Worked Example`; `## 7.` is optional.

A decision is a heading `D<x>.<y> <name>` in §3 with a **five-tuple**, enforced literally
(`FIVE_TUPLE = ["Action","Purpose","Trigger","Cost","Depends on"]`, `milestone.py:53`, checked at
`:306`). The `Depends on` line is the machine-read DAG edge (`_DEP_LINE`, `:89`) and carries three
arrow kinds: `⇐` upstream, `⊗` companions (must land in the same commit, **not** a DAG edge),
`⇒` downstream (`parse_dependency_line:99`). `parse_milestone_dag:822` builds
`Decision(id, depends_on, companions)` from it; a dangling dep is a validation violation because it
silently under-invalidates prefix reuse (`milestone.py:311-317`).

Tags a row may carry, each with a machine meaning:

| Tag | Meaning | Checked by |
|---|---|---|
| `[VERIFY: ncu-direct\|ncu-derived\|correctness\|sass-derived\|none\|inferred]` | what proves the decision landed | `parse_verify_tags:806`; the scaffold branch reads it to justify skipping an eval (`driver.py:2351`) |
| `[MEASURED, job N]` / `[ESTIMATE]` | number provenance — every perf number in §3 needs one | `milestone.py:437-439` |
| `[PRICED: <delta>, <job N \| KB:<entry> \| ref-price>]` | required on every `sass-derived` gate line | `_gate_hygiene_violations:607` |
| `[EXPR: A=… ; B=… ; C=toolchain-limit]` | expressibility ladder for modifier/variant axes | prompt-level (distill/patch) |
| `[CLOSES: Mk-gate]` | this delivery closes the phase | `_CLOSES_TAG:2504`, `_declared_gate_close:2572` |
| `[PLACEHOLDER: Dx.y → <real form>]` / `[RESTORED: Dx.y]` | placeholder ledger | `:1014-1015`, `_placeholder_bounce:1126` |

Gate lines live in a `### M<k> Gate` block (`gate_blocks:571`). Two hygiene rules are enforced
(`_gate_hygiene_violations:607`): compiler-allocated values are not gate lines (`regs_per_thread == N`
is a violation; `<= cap` and `spill == 0` are allowed), and every `sass-derived` gate line must be
priced. Every milestone must contain a literal "mechanism-verification line" (`:64-65`, `:328-333`) —
without it the milestone cannot be written at all. A decision id must not contain the substring
`gate` (`distill_prompt.md`, `_GATE_ROW = re.compile(r"gate", re.I)`), or it silently becomes a full
eval.

### 2.2 M0 freezes architecture; M1..Mk tune inside it

M0 carries the **resource-topology contract**: smem buffer inventory, access atoms of each exchange
buffer (write and read side), issue sequence + segmented live-set budget, register-residency policy,
accumulator precision, algorithm skeleton. Each contract item is "a few lines of machine-checked
predicates" traced to a measured reference signature, with a cost and a closable/revocable ruling
(`docs/milestones-template.md` A.3.2). M0 freezes at its gate: "the signature and the resource-topology
contract cannot change afterwards" (`distill_prompt.md`), and M1+ must not modify it
(template A.3 item 5, A.5). Breaking the ceiling requires going back to M0 — which is exactly what the
reopen machinery (§5) makes expensive and gated.

M1..Mk are **levers inside the frozen topology**: stage count, swizzle mode, `wg_wait` depth,
schedule depth, layout refinement, numeric fast paths, cross-kernel scheduling. A lever gets only a
starting value in M0 and an explicit decision in M1+ ("five-tuple: which lever, candidate value
domain, trigger condition, trade-off criterion") — "tunable" is not free play
(`distill_prompt.md` M0 section; template A.3.2).

M0's gate is the one row that forces a full eval even in the build phase (`_GATE_ROW` bypasses the
scaffold branch), and its first PASS triggers the **M0 audit**: a meta turn whose question is not "why
did the segment stall" but "is the milestone consistent with the hardware truth", with `OK` as an
allowed verdict (`driver.py:6146-6160`, `m0_audit_prompt.md`). Audit-clean = resume the segment
unpatched (`:11544`).

### 2.3 Exhausted graph / gate impasse

- **Student runs out of decisions** → `EXHAUSTED: <reason>` (`student_prompt.md`; `parse.py:94`). This
  is an *inner stop that routes to meta* (`exhausted` ∈ `_META_ACTIONABLE`). The design refuses the
  student a free-optimization phase: "a decision graph that runs out without reaching the target is a
  defect of the milestone" (`student_prompt.md` §2); a `YOLO` free-optimization section is a
  validation violation (`milestone.py:289-291`), and the phase-order rationale is `milestone.py:25-32`.
- **Levers in a phase all priced null** → `_phase_exhaustion:4262` builds a demand for a
  `phase_verdict`: `close` (the student submits `M<k>-gate` next) or `continue:<D id>` (only a decision
  with no priced lever). Missing/invalid → one bounce, then **closed by default** (`:6652-6680`).
- **Gate impasse**: the gate row is the only row that always pays a full eval; a gate that keeps
  failing keeps the phase open and "its levers stay priced null on this best tree" (`:2841-2862`).
  A post-patch rebuild that is behind at the *same* gate stops the segment immediately instead of
  walking M1..Mk first (`_gate_regression:7781`; the case that motivated it: M0-gate 14.43 vs 12.31 ms,
  −17%, four extra iterations).
- **Run out of meta budget** → `stop=meta_budget` with the best kernel and a report (`:11630`).
- **Target unreachable** → only a teacher `cause_class: INFEASIBLE` stops the run, and only if the
  reachability arithmetic holds: `reachability:` line reads `BLOCKED`, carries
  `floor_opt=<ms>` and `target=<ms>`, and `floor_opt > max(target, driver threshold) × 1.20`
  (`_infeasible_refusal:3103`, `_REACH_BLOCKED_MARGIN = 1.20` at `:3075`), after
  `infeasible_min_diagnoses` plateau diagnoses (default 1, `:326`). A refused stop request patches
  nothing and re-diagnoses the same state (`:6615-6640`, `:11657`).

---

## 3. Meta-shapes / lever taxonomy: how a lever is priced and gated

`loop/meta_shapes.py` is **not** the taxonomy; it is the *merge* layer (one price table across the
card's `meta_workloads`, `meta_shapes.py:1-30`, `merge_lever_logs:165`). The taxonomy is the price
table produced by `skills/lever-pricing/lever_pricing_run.py` and consumed by
`driver.parse_lever_prices:4097`.

### 3.1 What a lever is

A lever is **a composable exact-text edit of the best tree's kernel file** — `{name, edits:[{old,new}],
decisions:[D ids], in_stack, hypothesis}`. `apply_lever:482` requires every `old` to occur **exactly
once**. `build_variants:549` then constructs:

| Variant | Construction | Asserts |
|---|---|---|
| `base` | the tree as it stands | the bar |
| `+<L>` | base + lever L alone | the lever pays on its own |
| `all` | base + every `in_stack` lever | the stack's total |
| `all-<L>` | the stack minus L | the stack misses L (or doesn't) |
| `<subset>` | teacher-named combination | a specific coupling hypothesis |
| `~<A>` (ablation) | base + ablation edit alone (`build_ablation_variants:602`) | an existing mechanism's **cost** |

A lever whose variant is byte-identical to base is refused (`:565-567`) — a no-op would read as
"worth 0%".

### 3.2 The class ladder (`lever_class:1220`) — one place, table + all-pos plan

`add` = `+L` vs `base`; `rem` = `all-L` vs `all`; `noise` = the measured floor (≥ 0.5%,
`NOISE_FLOOR_PCT:156`; computed as √2·1.2533·σ/√R, never below the floor, `:1212-1217`).

| Class | Condition | What it asserts |
|---|---|---|
| `broken` | `add` not measured ok | the variant did not build/run — no price |
| `noop` | identical cubins **and** both readings inside the floor | the edit does not reach the machine |
| `unmeasured` | `add is None` | nothing to say |
| `harmful` | `add < -noise` **and** (`rem is None or rem >= -noise`) | hurting alone and not missed by the stack → drop it |
| `unstacked` | `add > noise`, `rem` missing, stack broke correctness | the single reading stands; subsumption never measured |
| `independent` | `add > noise` and (`rem` missing or `rem < -noise/2`) | pays alone, and the stack still pays without it |
| `coupled` | `add <= noise` and `rem < -noise` | pays nothing alone, the stack needs it |
| `dependent` | `add > noise` and `rem >= -noise/2` | pays alone only because the stack already pays it |
| `null` | otherwise | no measurable effect at this tree |
| `shape_split` | only from the merge: one workload up, another down, each beyond its own floor (`meta_shapes.py:130-135`, `:222-226`) | size-dependent: a lever the representative would price as null |

Only the **add** leg may read `shape_split`; a remove-only split is a coupling statement, not size
dependence (`meta_shapes.py:20-28`).

### 3.3 How the price is bought and gated

- Design turn: the teacher reads the same evidence the diagnosis will read (stall ledger, dossier
  diff, role exposure) and writes `notes/levers.json` — up to `lever_pricing_max_levers = 5`
  (`:346`), `lever_pricing_rounds = 3` interleaved bench rounds (`:345`). Then one GPU job on the
  **best tree** (`be.reset(best_ref)`, `_run_lever_pricing:4557`).
- The spec is checked locally before the job (`_lever_spec_refused:4804` — a bad `old`, a subset that
  shadows a lever, a no-op ablation never costs a GPU job).
- The table is banked with the tree it was measured on (`priced_on`), merged over
  `meta_workloads` via `meta_shapes`, and reused when the same best tree is priced again
  (`_banked_lever_table:4862`).
- **Citation gate**: an `R1` / `structural` / `split` patch must carry
  `reopen_price: <delta> via probe:<path>#<n> | lever:<name> | ablation:<name> | KB:<entry>`
  (`_REOPEN_PRICE_SRC:3161`). `_verify_reopen_price:3188` only accepts something the driver
  measured *this step* or a **GPU-certified** KB entry (a `PROBE PASS`, a `[PRICED]` tag, or a job id;
  `_KB_CERT_MARK:3168`). No price → `patch_class: unpriced-reopen`, nothing lands, the refusal enters
  the meta memory, and the step is retried (`run_meta_step:6772-6790`).
- **Price staleness**: a price tag carries the tree it was measured on. When best moves, the driver
  re-measures the cited lever on the new tree and appends `[RE-PRICED @<tree> …]`; a reversed or
  vanished citation is marked `SUSPENDED` and the student may not land it (`_stale_price:3268`,
  `_reprice_cited_levers:5185`; the rule is in `patch_prompt.md`).
- **Phase exhaustion**: the merged table is also a batch measurement of the phase's own knobs. If all
  of a phase's levers read null/noop on the current best, the phase is exhausted and the diagnosis
  must close it or name the one unpriced decision still worth walking (`:4262`, `:6605-6650`).
- `reopen_max_fruitless = 2` (`:393`): after two fruitless reopens in a row the driver refuses R1
  **before** spending turns pricing it (`_reopen_capped_block:3344`).

---

## 4. Teacher / student separation

### 4.1 What the student may never see

`meta/student_prompt.md` "L0 hard rules": any other branch (`git show`, `git log` of another branch,
cross-branch diffs), the original operator's source and any equivalent implementation, any file
outside `WORKSPACE` implementing the same kernel; no network (WebFetch/WebSearch/curl/pip/git clone);
git only on the current branch; one iteration = one commit; only `{KERNEL_FILE}` may change.

Enforced, not just prompted (`loop/agent_policy.py:1-64`): the rules are written into
`<cwd>/.claude/settings.json` before every turn as a Claude Code **project** settings file —
`permissions.deny` for WebFetch/WebSearch and file tools on the forbidden trees, a Seatbelt
`filesystem.denyRead` for the Bash sandbox (so `python3 -c "open(...)"` also fails),
`deniedDomains=["*"]` + `WebFetch(domain:*)` + `failIfUnavailable`, a PreToolUse hook as a tripwire,
and role-scoped writes (teacher: the run's repository; student: its working directory only). The deny
list itself is derived, not hand-written: the reference's directory, the sealed artifacts/key, and
every other run directory (`launch.py:330-352`), plus `[reference].deny` which can only add
(v1-launch §3.5).

Adjacent hard walls: `_enforce_prep_contract` (the bench's outside-window `prep` step must match
`window.toml`), `harness_guard` (the student may not edit `eval/`, `gpu_entry.sh`, `ref_bin/`,
`.gitattributes`; reverted pre-eval), and `_enforce_single_ref` (the in-job reference must be the
declared one).

### 4.2 How `patch_prompt.md` scopes edits

- Inputs are paths injected at runtime: `TEMPLATE`, `POLICY`, `MILESTONE`, `DIAGNOSIS`, optional
  `ORACLE`, optional `CANDIDATES`.
- **"Fix only the one defect the diagnosis points out; change nothing else."** Exception: when the
  diagnosis has already bundled several priced small levers, the patch lands the whole ⊗ bundle as
  additive decisions in the last phase.
- Patch class must match the diagnosis: `additive` = append at the end of the DAG (nothing depends on
  it); `structural` = change an existing decision/edge/⊗/foundation value; `split` = finer steps;
  `kb-example` = **not a milestone change at all** (a KB entry spec).
- **A patch exists only once it is written into the file.** The driver never applies the `patch:` text
  from the reply. Hard gate: if the patched file is byte-identical to the pre-patch file, or a
  `changed_entries` id is not found in the file, the patch is bounced (`_patch_landing_violations:6906`,
  called at `:6798`); after `max_patch_rounds = 3` the patch is void and rolled back. The prompt
  records the burn: "one occurrence burned two meta steps, about 4 hours".
- `changed_entries` is exact because it **is** the invalidation key (see §5): "Changing a foundation
  entry (e.g. the tile) = almost everything invalidated".
- No downgrade clause without a failure trigger (`downgrade_schedule_violations:726`); gate-row hygiene
  re-checked on lines the patch **added** (`validate_milestone(baseline=…)`, `milestone.py:249-…`).
- Declared payoff: `gate_contract: M0-gate ≤ +15%; M1-gate ≤ 0%` — the allowed regression of each gate
  against the previous segment's same gate; no declaration = parity + 1.5% noise, and anything beyond
  is REVERT_PATCH on the spot (`_parse_gate_contract:7739`, `_gate_regression:7781`).

### 4.3 "One decision row at a time", operationally

The student's unit of work is one **record block**, not one decision:

```
decision_id:  D2.3            (bundles: D2.3+D2.4)
change:       <one objective sentence; first sentence declares part k of n / [PLACEHOLDER:]>
files_touched: kernel.py
```

Rules that make it "one row at a time" rather than prose:

- one iteration = **one commit**; the commit message names every decision id, joined with `+`;
- a bundle states the shared budgets/knobs (smem/registers/sync/tile) in the record block — the
  bundle is the ruling granularity: one reading, one REVERT undoes the whole bundle, and on REVERT the
  dead-end table records **one entry under the composite id**, not a ban on members (template A.6
  discipline 3, corollary a);
- a **gate row must be a row of its own**: `D0.12+M0-gate` is illegal (`student_prompt.md` §2,
  `_GATE_ROW`); `[CLOSES: Mk-gate]` is the legal shortcut — after a KEEP, the driver files the gate
  row itself with the same tree and the same reading (`_declared_gate_close:2572`);
- **objective fields only**: hypotheses, bottleneck theories and subjective analysis are forbidden in
  the record block (`student_prompt.md` §B). The meta agent diagnoses from measured hardware facts
  (`inner/trajectory.py:20-35`, `parse.py:20-35`);
- rows that measure nothing are not re-measured (`reading_of`), and rows that land a placeholder are
  tracked until `[RESTORED:]`, with gate rows refused while the ledger is open.

### 4.4 How the diff is constrained

Four independent scopes: (a) **path scope** — only `{KERNEL_FILE}` (plus `notes/` for probes); anything
under `eval/`, `gpu_entry.sh`, `ref_bin/`, `.gitattributes` is REVERTed pre-eval and restored before
each turn (`harness_guard.py:36`, `driver.py:2054`, `:2093`); (b) **implicit scope on the kernel** —
`apply_lever` requires a unique `old`, and the job refuses a no-op variant; (c) **semantic scope** —
the frozen host/signature/dtypes (§4 of the student prompt); (d) **lineage scope** — a `git reset` to a
checkpoint on every REVERT, patch rollback or reopen, so the tree is always a checkpoint the ledger
owns.

### 4.5 The teacher's own evidence discipline

The teacher sees far more, and is held to "no fabricated reading":
`meta/recon_prompt.md` requires named verdict lines (`SASS-OK`, `SCHED-OK`, `LIVE-OK`, `STALL-OK`,
`ROLE-OK`, `PMTL-OK`, `STRUCT-OK`) or an explicit waiver (`SASS-WAIVED:` …), and a discriminating
experiment that comes back empty is not a verdict — the row is marked `[VERIFY: inferred]` and lands in
the out-of-run gap queue (`driver.py:8382-8530`), never in `hw_kb`. Distillation may start only from a
measured baseline: "distillation without a measured ref writes gates it cannot anchor" (`:11441-11448`).

---

## 5. Resume / invalidation

### 5.1 What the checkpoint is

A checkpoint = the triple `(milestone version, status.jsonl prefix, git commit)` indexed by decision id
(`milestone-distillation.md` §6). In code: the `sha` field on each `IterationRecord`
(`inner/trajectory.py:66`), the `base_sha` it built on (`:70`), and the milestone text snapshotted in
each `MetaRecord.milestone_before` (`meta_trajectory.py:54`).

### 5.2 What invalidates what

`resume/invalidation.py` has two functions, and the difference is the whole cost argument:

- `compute_resume:56` — **prefix reuse**. The first decision whose id or upstream set intersects
  `changed_entries` sets the cut: `resume_after = trajectory[i-1]`, `invalidated = trajectory[i:]`.
  Everything after the earliest affected decision goes, dependent or not, because a prefix can only be
  cut in one place.
- `compute_reopen:90` — **in-place reopening**. A fixpoint closure: a decision reopens if it is
  changed, depends on a changed entry, depends on a reopened one, **or is a ⊗ companion of a reopened
  one** (companions land in one commit). `kept` = everything else, "do not rebuild them". The
  docstring names the motivation: prefix reuse turned a one-decision foundation patch into a
  whole-segment rebuild (sparse-attention run: 6 of 10 meta steps rebuilding M0).

Driver side: `_resolve_resume_in_place:7835` picks in-place when `reopen_in_place` is on (default,
`:243`), the patch class is `structural`/`split`, the closure is non-empty, and a green best tree
exists; otherwise `_resolve_resume:7819` resets to the checkpoint before the earliest affected
decision. In-place reopening announces itself as `decision_id: REOPEN` NEUTRAL row + a standing
`reopen_note` listing reopened and kept sets (`_note_reopen:7864`); a rollback later adds a
`REOPEN-REVERT` row that restores the earlier KEEPs (`:8248-8260`).

Invalidation is also **not** performed for `additive` and `kb-example` patches: they change nothing
that already landed.

### 5.3 How a run resumes after interruption

- New run = new directory (`.artifacts/<op>_<id>/`); nothing is inherited (`runs.py:101-133`).
- `forge run .artifacts/<op>_<id>` again: `started = run.record()["status"] != "created"`
  (`launch.py:228`), which flips on `--allow-preexisting-artifacts --allow-dirty-kb`
  (`launch.py:571`). Steps whose product exists are skipped: `judge_written`,
  `tolerance_frozen`, `op_dir.exists()` (else the card is regenerated), NCU probe re-run every launch
  (`launch.py:409-455`).
- The loop itself resumes from `start_iter = len(load_records(status_path))` (`driver.py:11410`), and
  the *correctness state* is re-derived, not assumed: `_green_on_resume:8011` reads the records for the
  tree it resumes on; if the lineage never turned green the segment enters **scaffold mode** until a
  gate row (`:11415-11440`). The rollback anchor is the last KEEP, not HEAD, when HEAD carries commits
  no record verified (`_resume_anchor:8043`).
- Meta transactions survive a restart only partially, by design: `voided_ranges` and the
  `_PendingPatch` are in memory ("a driver restart starts both empty", `driver.py:256-259`), but the durable
  record is `meta_status.jsonl` with `outcome ∈ {PENDING, KEEP_PATCH, REVERT_PATCH, HOLD_PATCH,
  AUDIT_CLEAN, UNPRICED_REOPEN, REOPEN_CAPPED, INFEASIBLE_STOP, INFEASIBLE_REFUSED, …}`
  (`meta_trajectory.py:40-42`) plus `milestone_before` text, so a reverted patch can be restored and a
  refused direction is not re-proposed (`reflect_summary:158`).
- `HOLD_PATCH` exists precisely to make resume safe: a segment with **no metric reading at all**
  (pre-green construction) is "unattributable, not refuted" — nothing is restored, the transaction
  stays open, and the next patch joins it for one joint judgment (`_judge_patch:8142-8165`).
- Refusals from the past feed the next attempt: `infeasible_refusals`, `probe_readings`,
  `lever_prices`, `phase_verdict`, `reopen_price`, `gate_contract` all ride `MetaRecord` and are shown
  back in the diagnose prompt (`run_meta_step:6163-6200`).

---

## 6. Invariant-shaped vs infrastructure-shaped

Invariant-shaped = a rule over text/ledger state that a TypeScript tool can hold with no job runner.
Infrastructure-shaped = needs a process that outlives the turn, a GPU, ssh/tmux, or a git remote.

| Mechanism | Shape | Why | Evidence |
|---|---|---|---|
| Milestone schema + DAG validation (sections, five-tuple, dangling dep, mechanism line, `[MEASURED]`, gate hygiene, downgrade ban, id∌"gate") | **invariant** | pure functions over milestone text | `milestone.py:249-457`, `:571-716`, `:822` |
| `[VERIFY:]` / `[PRICED:]` / `[EXPR:]` tag obligations | **invariant** | regex + line-class accounting | `:64-65`, `:607`, `:803` |
| Placeholder ledger; gate-row-alone; bundle-id rule | **invariant** | derived from `status.jsonl` rows + record text | `driver.py:1014`, `:1039-1123`, `:989` |
| `reading_of` reuse (don't re-measure an unchanged tree) | **invariant** (needs the row ledger) | pure compare of `sha`/`base_sha`/paths | `:2511`, `:2545` |
| Prefix-reuse / reopen closure | **invariant** | pure fixpoint over `Decision[]` | `resume/invalidation.py:56`, `:90` |
| Patch transaction accounting (KEEP/REVERT/HOLD, 1.5% EPS, `gate_contract` bands) | **invariant** given readings | arithmetic over `status.jsonl` + `meta_status.jsonl` | `:8142`, `:7951`, `:7739`, `:7781` |
| Reopen-price gate + price staleness → SUSPENDED | **invariant** | citation string + a known-lever table | `:3188`, `:3268`, `:5185` |
| Infeasible stop gate (BLOCKED + floor_opt > target×1.20 + min diagnoses) | **invariant** | arithmetic on a parsed line | `:3103`, `:3075` |
| Phase exhaustion → `phase_verdict` | **invariant** (needs the price table as input) | set arithmetic over lever rows | `:4262`, `:4352` |
| Plateau detection (3 rows, 1.5% relative) | **invariant** | min-of-window vs prior best | `parse.py:657` |
| Turn/eval parsers (`Record`, `PROBE PASS max_diff`, `EXHAUSTED`, eval JSON) | **invariant** | text protocols | `parse.py:74`, `:263`, `:576` |
| Harness-path guard (the *rule* and the diff check) | **invariant** rule, **infra** enforcement | needs the git diff of a delivery plus a reset | `harness_guard.py:36`, `driver.py:2054`, `:2093` |
| Student/teacher separation (deny list derivation, patch-landing byte check) | rule **invariant**, boundary **infra** | the settings file + Seatbelt sandbox + PreToolUse hook are OS-level | `agent_policy.py:1-64`, `:6906` |
| Lever pricing table (`base/+L/all/all-L/subset/~ablation`, class ladder) | rule **invariant**, measurement **infra** | the distinction, merging and gate are pure; the numbers need N timed variants in one process | `lever_pricing_run.py:1220`, `meta_shapes.py:165` |
| Judge authoring + calibration/tolerance freeze | **infra** | teacher session + a GPU job comparing the reference and the judge on every group | `launch.py:475`, `:503`, `leaderboard.py:2454` |
| NCU probe, per-iteration NCU, stall/SASS/timeline/PM-sampling price | **infra** | in-job profiler + in-tree toolkits + job polling | `launch.py:511`, `driver.py:2382`, `:10135-10460` |
| GPU submission, detach/poll, preemption, ssh transport, GPU lock, clock lock | **infra** | one detached runner per job, `.jobs/<id>/`, process-tree kill on the remote | v1-launch §14.14; `cli.py:112-235` |
| Agent sessions (`claude -p`, `/goal` in tmux, heartbeats, timeouts, context-window gate) | **infra** | long-lived subprocess, wall clock, CLI behaviour | `agentctx.py:1-40`, `cli.py:2255-2290` |
| Budget/deadline clock, run resume across process death, run directory | **infra** | `deadline_epoch`, `run.json`, append-only ledgers | `driver.py:2807`, `runs.py:101` |
| Git workspace as state (branch per iteration, reset to checkpoint, `git archive` per job) | **infra** | needs a repo the tool can reset | `cli.py:877-950`, `:729`, `:816` |

The practical line: **every rule that decides whether a claim may stand is invariant-shaped**; every
rule that produces the number the claim is about is infrastructure-shaped. ForgeKernel's own design
statement matches this — "All control flow here is deterministic given the backend, so it is
unit-tested with a fake; the real backend (agent CLI + GPU jobs + git) lives in forgekernel.loop.cli"
(`driver.py:1-8`).

---

## 7. The five mechanisms a pi-extension system most lacks

(Reference point: `pi-kernel-expert` — a pi extension with `kernel_contract` / `kernel_candidate` /
`kernel_profile` / `kernel_init|status|wiki` tools, a phase loop delegated to `pi-goal`, and an
evidence gate in `kernel_candidate` per `docs/adr/0005-evidence-gate-lives-in-the-tool.md`. It has a
keep/revert gate with freshness checks; it has no second layer.)

1. **A walkable decision graph as a validated artifact.** ForgeKernel's milestone is not prose and not a
   metric contract: it is `D<x>.<y>` rows with a fixed five-tuple, a machine-read `Depends on` DAG with
   `⇐/⊗/⇒`, per-milestone `### M<k> Gate` blocks, and a schema validator that refuses a milestone
   missing a five-tuple key, a mechanism line, an evidence marker, or carrying an unpriced
   `sass-derived` gate line (`milestone.py:53`, `:249-457`, `:306`, `:328-333`, `:607`). Without it the
   agent's "plan" is un-addressable, so no later mechanism can key on it.
2. **Prefix-reuse / reopen-closure invalidation.** `compute_resume` cuts the trajectory at the earliest
   affected decision; `compute_reopen` computes the exact dependency+companion closure to redo in place
   and names what to keep (`resume/invalidation.py:56`, `:90`). This is what makes a foundation patch
   affordable at all, and it is pure list arithmetic — the cheapest thing on this list to port.
3. **The gate row as its own row type, with build-phase semantics.** Pre-green deliveries are
   `NEUTRAL` (no eval, no verdict) and the deferred verification is spent by one `M<k>-gate` row that
   *always* forces a full eval; the gate row may not be bundled, may not carry a placeholder, and may
   be filed by the driver on the same tree/reading via `[CLOSES:]` (`driver.py:2325-2360`, `:989`,
   `:1126-1180`, `:2572`). This separates "it builds" from "it is accepted" — a distinction a
   keep/discard gate on a single workspace never makes.
4. **The outer-loop patch transaction with measured-price gates.** KEEP_PATCH / REVERT_PATCH /
   HOLD_PATCH against a pre-patch best, a 1.5% improvement epsilon, a declared `gate_contract` per
   gate, `HOLD` for metric-less segments, and the two hard refusals: no reopen without a price
   (`_verify_reopen_price:3188`) and no price from a stale tree (`SUSPENDED`, `_stale_price:3268`).
   A per-candidate keep/revert gate has no notion of "this change to the *plan* must pay for itself".
5. **The teacher/student boundary as a checked contract, not a prompt.** Derived deny list, student
   offline, teacher-only trees, and — the part that is pure tooling — a patch that must (a) differ
   byte-wise from the pre-patch file and (b) name only `changed_entries` that exist in it
   (`_patch_landing_violations:6906`; `patch_prompt.md` "A patch exists only once it is written into
   the file"), plus the harness-path revert that keeps the judge out of the optimizee's hands
   (`driver.py:2093`, `harness_guard.py:36`). Without it, "the plan was updated" is unverifiable and
   the two roles collapse into one agent editing its own acceptance criteria.

Honorable mentions that are invariant-shaped and cheap, but sit outside the five: the INFEASIBLE
reachability arithmetic (`driver.py:3103`), the placeholder ledger (`:1126`), and the `reading_of`
no-re-measure rule (`:2511`).
