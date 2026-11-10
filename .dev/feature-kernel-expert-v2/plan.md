# Plan: feature-kernel-expert-v2 / `evidence`

Ticket graph for the `evidence` module (`spec.md`, module map in `map.md`, flow in `flow.md`).
Ids are unique across `.dev/`; frontier = sections with no unfinished blocker.

```
T-001  toolchain ─────────────┐
T-002  contract v2 ──┬─ T-003 reading block ──┬─ T-004 refusals ── T-005 negative control
                     ├─ T-006 pairing ────────┘
                     ├─ T-007 groups ── T-008 precision gate
                     └─ (harnessGlobs folds into T-002/T-004)
```

Build order (T-001, T-002 closed 2026-11-10): 

**T-002 ∥ T-001** → T-003 → T-004 ∥ T-006 ∥ T-007 → T-005 ∥ T-008.

---

## [T-001] Toolchain bootstrap on h200-7

- **Type**: AFK
- **Blocked by**: None
- **What to build**: a repeatable, non-invasive environment for every later ticket's acceptance run on
  `ssh builder`. Create `~/pkex/` (venv via `uv`, python ≥3.11), install a CUDA-13.0-compatible torch,
  and a `job-env-check`-shaped script that proves `nvcc`, `ncu`, `torch.cuda` and the GPU identity are
  visible from the non-interactive shell. No system-wide installs, no sudo writes, no GPU state changes.
- **Closed 2026-11-10**: `scripts/job-env-check.sh` + `runs/T-001/`; exit 0 with nvcc 13.0.88, ncu 2025.3.1, torch 2.14.1+cu130, 8x H200. All cards were at 100% util (a tenant job) — noted for T-003+.
- **Acceptance criteria**:
  - [check: `ssh builder '~/pkex/bin/job-env-check'` prints nvcc 13.0.88, ncu 2025.3.1, torch version,
    8× H200 with per-card memory, and exits 0]
  - [evidence: the script and its output archived under `.dev/feature-kernel-expert-v2/runs/T-001/`]
  - [judgment: the user] — that `~/pkex/` is the right location and the install did not disturb anything.

## [T-002] Contract schema v2: basis, harnessGlobs, referenceCommand

- **Type**: AFK
- **Blocked by**: None
- **What to build**: `kernel.contract.json` becomes an explicit `schemaVersion: 2` artifact carrying
  `basis` (`device` | `e2e`), `harnessGlobs[]`, and an optional `referenceCommand`. A v1 contract is
  refused at read time with "regenerate with kernel_contract", never silently upgraded. Write
  `docs/adr/0006-contract-v2-reading-provenance.md` recording why the schema breaks at 0.x and what
  the three fields buy. `kernel_contract`'s tool params and `freezePayload` carry the new fields.
- **Closed 2026-11-10**: schema v2 in `cb06f04`; 110 tests pass, typecheck clean; ADR 0006.
- **Acceptance criteria**:
  - [check: `npm test` — a v1 fixture is refused with the regenerate text; a contract missing `basis`
    is refused; `harnessGlobs` defaults to the comparator/bench/check runner when omitted]
  - [check: `npm run typecheck`]
  - [evidence: `docs/adr/0006-…md` merged, and `kernel-freeze.json` for a 2-cell workspace shows the
    three fields]

## [T-003] `goal.sh` emits a machine-readable reading block

- **Type**: AFK
- **Blocked by**: T-002
- **What to build**: the generated benchmark script prints one
  `=== KERNEL READING ===` / JSON / `=== END ===` block per run: contract sha, basis, GPU identity,
  SM/mem clocks at start and end, utilisation and foreign-process memory, `hostEnqueueMs`,
  `deviceMedianMs`, `hostBoundRatio`, per-cell medians and spread, `CUDA_VISIBLE_DEVICES`. Fields that
  cannot be read are absent, never zero. A parser in the extension turns the block into a typed record.
- **Closed 2026-11-10 (code)**: `11f13d8`; 129 tests pass, typecheck clean; block verified on all three exits (baseline, comparison, guard-fail) by running the generated script. Live GPU reading still open: all 8 cards at 100% util.
- **Acceptance criteria**:
  - [check: `npm test` — parser round-trips a fixture with absent fields; the generated script passes
    `bash -n`; a fixture block with `basis: "device"` and no `hostEnqueueMs` parses as
    `verdict: "unmeasured"`]
  - [evidence: a run on an exclusive h200-7 card, block archived under `runs/T-003/`, showing real
    clocks and a `hostBoundRatio`]
  - [judgment: — none]

## [T-004] `kernel_candidate` refusal set

- **Type**: AFK
- **Blocked by**: T-002, T-003
- **What to build**: the recorder refuses a keep when: the reading has no basis; the verdict is
  host-bound on a plain basis; the diff touches `harnessGlobs`; a matrix cell or input group has no
  reading; a profile is stale. Each refusal names the rule, the side it is charged to, and the fix.
  Absent evidence is `unmeasured`, not passing. **Authored by a different subagent than T-003.**
- **Closed 2026-11-10 (code)**: `a45015f`; 174 tests pass. Seven rules, not five — two were added at review from the implementer's own findings: `reading-contract-mismatch` (nothing bound the reading to the contract) and `metric-not-in-reading` (the caller could claim a cell value no measurement produced). The skill's failure table now names each rule and tells the agent to pass `reading`.
- **Acceptance criteria**:
  - [check: `npm test` — five refusal cases, each asserting the exact rule name in the message; a
    forced keep records the reason; an `unmeasured` reading is refused, not defaulted to pass]
  - [check: the checker and the producer do not share a fixture authored by the implementer: the
    negative-control fixtures come from T-005]
  - [judgment: — none]

## [T-005] Negative control: the deliberately bad bench

- **Type**: AFK (planner-authored, not delegated to an implementer)
- **Blocked by**: T-003, T-004
- **What to build**: a fixture task whose `benchmarkCommand` sleeps 2 ms on the host inside every
  timed call, plus the expected refusal text. Run it on h200-7 and record the block: the reading must
  be reproducible, correctness-green, and still refused by T-004's host-bound rule.
- **Acceptance criteria**:
  - [evidence: `runs/T-005/` holds the reading block, the exit code, and the refusal text, and the
    recorded `hostBoundRatio` is ≥ 0.5]
  - [check: a regression test replays the archived block through the parser and the refusal set]
  - [judgment: the user] — that the refusal message is actionable without reading the source.

## [T-006] `referenceCommand` and same-job ABBA pairing

- **Type**: AFK
- **Blocked by**: T-003
- **What to build**: when the contract has `referenceCommand`, `goal.sh` burns in 4 s with the kernel
  under test, then measures `ref, kernel, kernel, ref`, each side the mean of its two device readings,
  and reports `pairing: "mirrored"` with ≥2 ratios and their spread. When absent, the reading says
  `pairing: "absent"` and the cross-run baseline stays legal but labelled. A paired ratio above the
  contract's noise floor is what a keep rests on when it exists.
- **Closed 2026-11-10**: `3436fdc` + live `runs/T-006/` (mirrored, spread 3.20%, paired_speedup 0.998 on a null pair). 182 tests at close. Two defects fixed at review: the burn-in cap (32 runs = 1 ms for a fast kernel, i.e. no burn-in at all for the kernels that need it) is now time-bound with a 2000-run escape hatch that warns; and `burnInMs: 0` still cost one run. Live GPU evidence open (all cards busy).
- **Acceptance criteria**:
  - [check: `npm test` — ABBA order asserted from a recorded fixture; a spread >5% marks the pair
    inadmissible; a failing second window yields no half pair]
  - [evidence: a same-kernel run with `referenceCommand` whose block shows `pairing: "mirrored"`,
    two ratios, spread ≤5%, archived under `runs/T-006/`]
  - [judgment: — none]

## [T-007] Input groups per cell

- **Type**: AFK
- **Blocked by**: T-002
- **What to build**: `cells[].groups[]` (`name`, `intent`, `seed`), ≥3 for every non-boundary cell,
  exported as `KERNEL_GROUP`; `goal.checks.sh` and `goal.sh` iterate cells × groups; a group without an
  `intent` is a contract error; the checks distinguish a group failure from a shape failure.
- **Closed 2026-11-10 (code)**: `07860ba`; 144 tests pass, typecheck clean; both generated scripts run for real (2 cells x 3 groups + boundary). Two decisions changed during review: the cell aggregate is a **geomean** over groups, not a median (a median hides a 10x regression on one draw); the group table is `CELL_GROUPS` because bash owns `GROUPS`. Live GPU evidence open (all cards busy).
- **Closed 2026-11-10**: `07860ba` + live `runs/T-003/checks-zero-block.txt` (zero_block fails with `max_diff=0.9999853373`, typical/tail pass).
- **Acceptance criteria**:
  - [check: `npm test` — a cell with 2 groups is refused; a group without `intent` is refused; the
    generated scripts iterate the cross product (fixture assertion)]
  - [evidence: a matrix run where the kernel is correct on `typical` and wrong on `zero_block`, with
    `goal.checks.sh` failing on the second and the candidate refused, archived under `runs/T-007/`]
  - [judgment: — none]

## [T-008] Precision gate on `max_diff`

- **Type**: AFK
- **Blocked by**: T-007
- **What to build**: the check command prints `max_diff`; a calibration run records the reference's own
  error per dtype; a keep is refused when `e_cand > 3·e_ref + max(ulp(dtype), 2^-17)`. The refusal
  shows both errors.
- **Acceptance criteria**:
  - [check: `npm test` — a candidate at 2× the reference error passes, at 4× is refused; a missing
    `e_ref` is `unmeasured` and refused]
  - [evidence: one real kernel measured against its reference on h200-7, `runs/T-008/` carrying both
    errors and the verdict]
  - [judgment: — none]

---

## Operating rules for this build (pi-dev-mode)

- One commit per ticket, English conventional subject, staged files only.
- Every ticket is delegated to an implementer subagent with a bounded return contract (files changed,
  command run, output lines, open doubts); the main agent reviews the **diff and the command output**,
  never the summary alone.
- T-003 and T-004 must not be authored by the same subagent (producer/consumer separation).
- T-005's negative control is authored by the planner.
- A ticket closes only when its `todo.md` block is checked, the plan section carries a `Closed <date>:
  <resolution>` line, and the acceptance command was actually run.

## [T-009] Producer gaps found by the first real-hardware run

- **Type**: AFK
- **Blocked by**: None
- **What to build**: three things the real run on card 3 exposed. (1) `clockLocked` and the locked
  values in the reading block — the spec requires them, the producer never emitted them, so a locked
  run today cannot be recorded as locked. (2) A `gpu.loaded` sample taken after the last measured
  window: `gpu.start` is sampled before any work and therefore always shows the parked clock
  (345 MHz on h200-7), so the block never says what the clock was *while* measuring. (3) Align the
  spec's `deviceMedianMs` with the field the block actually emits (`deviceMs`), and state which
  sample set `hostBoundRatio` is built from.
- **Closed 2026-11-10**: `83757c1`; 216 tests pass. Live: locked run `held: true`, same contract unlocked `held: false` + warning, `runs/T-009/`.
- **Acceptance criteria**:
  - [check: `npm test` — a fixture block with `clockLocked: true` and locked values round-trips; one
    with `clockLocked` and no lock values is refused; a block without `gpu.loaded` still parses]
  - [evidence: a run on h200-7 with `gpu.loaded.clocksSmMhz >= 1500` while `gpu.start.clocksSmMhz`
    stays parked, archived under `runs/T-009/`]
  - [judgment: — none]

---

# Module `plan` (spec-plan.md)

```
T-010 milestone format + validator ──┬─ T-011 M0 lock + thaw refusal
                                     ├─ T-012 citation resolution
                                     ├─ T-013 candidate binding + dead ends
                                     └─ T-014 diagnose skill + Diagnosis block
T-015 workspace integration + kernel-flow skill  (after T-010)
T-016 real-workspace evidence (plan-1, plan-2)   (after T-013, T-014)
```

Frontier: **T-014** (T-010..T-013 closed 2026-11-10; `corpus` module T-017/T-018 closed, T-019 evidenced). T-015 is unblocked and independent of T-014.

Adjacent, done outside the ticket graph: the corpus moved to `ariesfish/kernel-wiki`
(`1571a54`, ADR 0007) — skill name compliant, sanitised at source, page ids frozen. That is what
T-012's `wiki:` citations now resolve against.

## [T-010] `docs/milestone.md`: format, parser, validator

- **Type**: AFK
- **Blocked by**: None
- **What to build**: the milestone is an addressable artifact. `kernel/milestone.ts` parses it and
  `kernel_milestone` (tool) validates, reporting every refusal at once. Sections `## 0.` … `## 6.`;
  decision rows `D<m>.<n> <name>` with the five-tuple on one line each; `Depends on` with `⇐/⊗/⇒`.
  Eight refusals: `route-missing-key`, `route-dangling-dep`, `route-id-is-gate`,
  `route-placeholder`, `gate-verify-none`, `gate-sass-unpriced`, `gate-no-mechanism-line`,
  `trigger-is-category`. Each names the row id and the rule. A template writer (`kernel_init`
  creates `docs/milestone.md`) is T-015's job; this ticket takes a file.
- **Closed 2026-11-10**: `b7f9b19`; 243 tests. Nine rules, each naming the row; the model is a line-range view so `render(parse(t)) === t`.
- **Acceptance criteria**:
  - [check: `npm test`] — one test per refusal, asserting the row id and the rule name in the
    message; a valid two-phase milestone validates clean; the parse round-trips (parse → render →
    parse is byte-identical).
  - [check: `npm test`] — a trigger phrase list (`when needed`, `as appropriate`, `if slow`,
    `optimize`, `improve`) fires by name; a trigger naming an observable (`waves/SM < 1`) passes.
  - [evidence: `runs/plan-0/` — the validator's output on the fixture milestone, refusals and clean]
  - [judgment: — none]

## [T-011] M0 freezes by hash

- **Type**: AFK
- **Blocked by**: T-010
- **What to build**: `kernel_milestone lock: true` writes `.kernel/milestone.lock.json` =
  {milestoneSha, m0ContractSha, lockedAt}. After the lock the `### M0 Contract` block must be
  byte-identical; an edit is refused as `m0-thawed` naming the changed item. `unlock: true` is
  allowed only with a reason, which is appended to `## 4. Dead Ends` as a diagnosis row.
- **Closed 2026-11-10**: `kernel/milestone-lock.ts` + `lock`/`unlock`/`reason` params; 11 new tests.
  The lock stores the block's own text, not only its hash, so a thaw names the item; `### M0 Contract`
  became its own `PhaseKind` because T-010's `phase-order` read it as a second `M0` decision block.
  A lock file that does not parse is `lock-unreadable`, not "unlocked".
- **Acceptance criteria**:
  - [check: `npm test`] — a locked milestone with an edited M0 item is refused as `m0-thawed` naming
    the item; an edit outside the M0 block is accepted and moves the milestone sha; unlock without a
    reason is refused.
  - [evidence: `runs/plan-2/` — a real file, the diff that caused the refusal, the refusal text]
  - [judgment: — none]

## [T-012] Gate citations resolve or the line is refused

- **Type**: AFK
- **Blocked by**: T-010
- **What to build**: two namespaces, kept apart.
  - **Measurement** (`profile:<run>`, `cell-group:<cell>/<group>`): allowed on a gate line and must
    resolve against `profile/` and the contract, else `gate-citation-unresolved` names the pointer
    and the lookup path. A `[VERIFY: sass-derived]` line additionally needs `[PRICED: <delta>,
    <source>]` with a resolvable source.
  - **Knowledge** (`wiki:<page-id>#<confidence>`, confidence in
    `verified|source-reported|inferred|experimental`): allowed on a decision row's Action / Purpose /
    Trigger, **never on a gate line** (`gate-cites-knowledge`). Shape is always validated; resolution
    against the cached corpus happens when present, and when absent the report carries
    `knowledge-source-absent` naming `kernel_bootstrap` instead of refusing. The corpus at
    `~/.pi/agent/kernel-expert/cache/KernelWiki@<pin>` is the resolver's only source.
- **Closed 2026-11-10**: `kernel/corpus-index.ts` (one reader for page ids and labels, also used by
  `kernel_wiki_candidate`) + two rule families in `milestone.ts`; `Problem` gained `severity`, so a
  warning no longer reads as a refusal. 13 tests, 14 evidence cases against the real corpus.
  A gate line was charged twice for one defect (knowledge in the pointer position) — fixed before
  the evidence run.
- **Acceptance criteria**:
  - [check: `npm test`] — each measurement class: one accepted fixture, one unresolved; each
    confidence label accepted on a row; a `wiki:` pointer on a gate line refused with
    `gate-cites-knowledge`; an unknown confidence word refused by name; corpus absent ⇒ row passes
    plus `knowledge-source-absent`.
  - [evidence: `runs/plan-0/citations.txt` — including one real page id resolved from the fetched
    corpus (`migration-wgmma-to-tcgen05`, confidence `source-reported`)]
  - [judgment: — none]

## [T-013] A candidate names its decision

- **Type**: AFK
- **Blocked by**: T-010
- **What to build**: `kernel_candidate` gains `decision` and records `milestoneSha`. Refusals
  `decision-unknown` (id absent from the milestone), `milestone-stale` (sha differs from the current
  file), `dead-end-bundle` (the bundle matches a recorded dead end and no `precondition` was given).
  None are forceable. `benchmark.csv` gains the `decision` column.
- **Closed 2026-11-10**: `kernel/milestone-binding.ts` (snapshot + binding), a second rule family
  `BINDING_RULE_IDS` in `refusals.ts` (the reading rules' all-rules test would otherwise have to
  produce rules that need a file it never sees). 14 tests, 8 evidence steps.
  - **Deviation from this ticket**: a fourth rule, `decision-missing`, because three refusals cannot
    express the absence — "a keep names no decision" has no id to be unknown. A keep in a workspace
    with no milestone at all is a warning, not a refusal (declared degradation; T-015 is where the
    missing milestone is flagged).
  - **Naming**: the record's field is `milestoneDecision` and the CSV column
    `milestone_decision`, because `decision` already means keep/reject on both, and two meanings for
    one column is how a ledger becomes unreadable.
- **Acceptance criteria**:
  - [check: `npm test`] — the three refusals, each naming the id; a keep with a valid decision
    records both fields; a retry with `precondition` is accepted and the precondition is recorded;
    a rejection still needs only a reason.
  - [evidence: `runs/plan-1/` — refused keep, row added, same keep accepted]
  - [judgment: — none]

## [T-014] Plateau diagnosis is a validated record

- **Type**: AFK
- **Blocked by**: T-010
- **What to build**: `kernel-diagnose` (skill) with a fixed reviewer brief and a return contract; the
  `### Diagnosis <id>` block is validated by shape (`class`, `decision`, `measurement`, `abandon`),
  never gates, and is what a plateau produces instead of another candidate. Where the `agent` tool is
  absent the record is marked `self-diagnosis`.
- **Acceptance criteria**:
  - [check: `npm test`] — a Diagnosis block missing a field is refused by name; a `class` outside the
    four is refused; a diagnosis with no decision id is refused.
  - [evidence: `runs/plan-1/diagnosis/` — one real diagnosis block produced at a plateau]
  - [judgment: the user] — that the reviewer brief asks a question worth answering.

## [T-015] Workspace integration and the skill

- **Type**: AFK
- **Blocked by**: T-010
- **What to build**: `kernel_init` writes `docs/milestone.md` from a template (one M0 row + its gate,
  placeholders the validator refuses); `kernel_contract` warns when the milestone is missing or has
  no decision row; `skills/kernel-flow/SKILL.md` gains the milestone step, the refusal table rows, and
  the plateau→diagnosis move.
- **Acceptance criteria**:
  - [check: `npm test`] — `kernel_init` on an empty workspace creates a milestone that the validator
    refuses (placeholders), and the refusal names every placeholder; `kernel_contract` warns without
    failing.
  - [evidence: the diff of the skill's step table]
  - [judgment: — none]

## [T-016] Real-workspace evidence for the module

- **Type**: AFK
- **Blocked by**: T-013, T-014
- **What to build**: one workspace, three archived runs: a keep refused for an unknown decision then
  accepted after the row lands; an M0 thaw refusal; a plateau that produces a validated diagnosis.
- **Acceptance criteria**:
  - [evidence: `runs/plan-1/` and `runs/plan-2/` with the commands, the outputs, and a README stating
    what each proves]
  - [check: `npm test` and `npm run typecheck` green at the end]
  - [judgment: — none]


---

# Module `corpus` (spec-corpus.md)

```
T-017 entry schema + kernel_wiki_candidate ──┬─ T-018 kernel_candidate records `wiki`
                                             └─ T-019 real promotion → candidate entry
```

## [T-017] The entry schema and `kernel_wiki_candidate`

- **Type**: AFK
- **Blocked by**: None
- **What to build**: `kernel/wiki-entry.ts` (schema, validation, render, parse) and the
  `kernel_wiki_candidate` tool. Pre-fill `architectures` and `sources` from the workspace's contract
  and the cited profile/candidate; require `mechanism`, `trigger`, `conditions`, `gotchas`; refuse a
  category trigger, a `verified` confidence with no resolvable source, a leftover placeholder, an id
  already present in the cached corpus, and a task-specific name (`entry-reference-leak`). Write
  `.kernel/wiki-candidates/<id>.md`; never touch the corpus.
- **Acceptance criteria**:
  - [check: `npm test`] — each refusal, naming the section or the id; round-trip render/parse; pre-fill
    from a fixture workspace.
  - [evidence: `runs/corpus-0/` — a generated candidate file]
  - [judgment: — none]

## [T-018] A keep records whether it produced an entry

- **Type**: AFK
- **Blocked by**: T-017
- **What to build**: `kernel_candidate` gains `wiki` (`{id} | "none" | "declined"`) and records it;
  `benchmark.csv` gains the column. A keep with profile evidence plus a bottleneck claim and no
  `wiki` field is a warning naming `kernel_wiki_candidate`, never a refusal.
- **Acceptance criteria**:
  - [check: `npm test`] — the three values; the warning fires on the profile+bottleneck case and not
    on a bare keep.
  - [evidence: `runs/corpus-1/`]
  - [judgment: — none]

## [T-019] One real promotion produces one entry

- **Type**: AFK, human-judged at the end
- **Blocked by**: T-017, T-018
- **What to build**: on the SAXPY fixture (or a real kernel), promote a candidate, emit the entry, and
  show the exact diff a publish would apply to `kernel-wiki` (`wiki/techniques/<id>.md`,
  `queries/by-technique.md` regenerated, one commit).
- **Closed 2026-11-10**: `runs/corpus-1/` — a real 11.39x promotion on h200-7 produced `coalesced-warp-mapping-memory-bound`, the publish diff (3 files), and passed the DoD check. Two tool flaws were found only by running it (circular citation, `verified` downgraded) and fixed.
- **Acceptance criteria**:
  - [evidence: `runs/corpus-1/` — the entry, the regenerated index diff, and the four commands]
  - [judgment: the user] — that the entry is merge-worthy as written.
