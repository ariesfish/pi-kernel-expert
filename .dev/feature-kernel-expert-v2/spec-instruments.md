# Spec: feature-kernel-expert-v2 / `instruments`

Module `instruments` of the capability map in `map.md` (module ids: `evidence` → shipped as
`spec.md`; `plan` → `spec-plan.md`; `corpus` → `spec-corpus.md`; `instruments` → this file). It
depends on nothing in `plan`, and on `evidence` only for one ticket: a `KB:` price is refused unless
the entry behind it was measured by the runner `evidence` built.

Two halves, different in kind, both about **not guessing**:

- **Static SASS reads.** The compiler's output is the only artifact that says what the machine will
  actually do. Six readings answer the six questions an agent otherwise answers by inference:
  which kernel is this, is the MMA operand a register or a smem descriptor, did `ptxas` serialize
  the pipeline, what is the schedule's register price, how is each phase built, what launch shape
  was it given.
- **The local KB container.** A workspace-tier knowledge base whose entries carry their own norm,
  their own measured footprint, and their own boundary; a citation from it can be **refused**, which
  is what makes it different from a wiki page.

## Objective

A user asking "why is this kernel slow / why did that change do nothing" must be able to get a
**reading of the compiled artifact** instead of a story about it, and must be able to write that
reading down where the next task will find it — with the price attached and the boundary stated.

Success: an agent that says *"the A operand goes through smem, so the register budget was never the
binding constraint"* can point at `OPERANDS a_reg=0 a_desc=28` produced by a command a reader can
re-run; and a `[PRICED: -8% issue slots, KB:<entry>]` gate line is **refused** unless that entry
carries a GPU certification mark.

## Implementation Decisions

### A · Static SASS reads

- **One tool, `kernel_sass`, not six CLIs.** Five upstream scripts parse the same dump and disagree
  about which kernel they are talking about (one picked `kernels[0]`, which was the RNG kernel, and
  produced a self-consistent nonsense histogram). One parser, one kernel resolution, one place where
  a verdict line is formed; `view` selects the read:
  `census | operands | serial | schedule | live | struct | launch`.
- **Two input formats, one parser.** `cuobjdump -sass` output (`/*0028*/` comments) and the NCU
  source page (`0x0000` address column, optionally CSV with an `Instructions Executed` column). A
  dump is read from a path, from stdin, or from the previous tool's output; **no GPU at analysis
  time**, which is what makes these reads cheap enough to run on every candidate.
- **Kernel resolution never guesses.** `--kernel <name>` wins. Otherwise the tool picks the kernel
  with the most **executed** instructions when an execution-count column exists, and **refuses**
  (`sass-kernel-ambiguous`, naming the candidates and their instruction counts) when it does not.
  "The first kernel in the dump" is the bug that made a histogram unfalsifiable by eye.
- **A verdict line is a reading, not a gate.** Each view prints one machine line —
  `SASS-OK|SASS-FAIL`, `OPERANDS`, `SERIAL`, `SCHED-OK|SCHED-FAIL`, `LIVE-OK|LIVE-FAIL`,
  `STRUCT-OK|STRUCT-FAIL`, `LAUNCH-OK|LAUNCH-PARTIAL` — with named fields, the dump path and its
  sha256, and the kernel name. A gate line may cite it only as
  `[VERIFY: sass-derived][PRICED: <delta>, <source>]`, which `plan` already enforces; this module
  supplies the price side.
- **Thresholds live in one table, and they are a spec-level decision.** `serial` ratio:
  `SEVERE >= 0.9`, `ELEVATED >= 0.5` (reference `0.15`); `live`: `peak` registers against the
  contract's `M0` register budget; `struct`: precision from the MMA input/accumulator opcodes, never
  from the source. Changing a threshold is a spec edit, not a code edit, because a threshold is a
  claim about what the number means.
- **Every view states what it cannot see.** `struct` cannot see the algorithm; `launch` cannot see
  occupancy; `census` cannot tell whether the instruction is on the hot path. Each view's output
  ends with the one inference a reader is likely to over-make, in one line.
- **The job-environment half is already shipped** (`scripts/job-env-check.sh`, 0.2.0). This module
  consumes it and does not rebuild it; re-scoping it here would add a second owner for one check.

### B · The local KB container

- **Location: `kb/` at the task workspace root, committed.** Per task, because load-bearing
  conditions are per structure, and a task is the unit that has a structure. Absent `kb/` is not an
  error until something cites it: `kernel_kb` then refuses with the path it looked in (fail closed at
  first use — this package has no launcher to fail at).
- **Entry schema**: `kb/<arch>/<entry>.md`, `<arch>` ∈ `sm80 | sm90 | sm100 | sm120 | generic`.
  Five sections (`Purpose`, `When needed (trigger)`, `Mechanism`, `Measured footprint and cost`,
  `Gotchas`) plus two additions every real entry grows: a certification header
  (`**Certification source:**`, `**Certification covers:**`, `**Uncertified:**`) and a
  `## Certification boundary` section — *"we never ran this on sm120"* is a boundary.
- **Three statuses, each with an invariant**: `MEASURED <gpu> <date>` (requires both, and a command),
  `UNVERIFIED — <what is missing>`, `TODO`. The index `kb/<arch>/index.md` is a **symptom ledger**
  (`symptom | entry | status`) whose first line is the read-path contract: *look up by symptom
  first; this section is the entry point, not a table of contents*.
- **`kernel_kb cite <entry>` is the refusal-bearing citation.** It emits `KB:<entry>` **only if** the
  entry carries the certification mark and its status is `MEASURED`; otherwise it refuses, naming
  what is missing (no mark / `UNVERIFIED` / no boundary section / no command). A transcribed recipe
  is not a price.
- **`kernel_kb lint`** runs five rules and fails closed:

  | Rule | Condition | Why |
  |---|---|---|
  | `kb-reference-token` | substring match against `docs/reference-tokens.txt` (static list, no boundaries) | an exact upstream symbol is a retrieval key into pretraining memory |
  | `kb-line-ref` | a line number / `file.py:412` with no whitelisted source on the same line | a citation a reader cannot open |
  | `kb-narrative` | run dates, `iter N`, commit shas | the entry is a mechanism, not a session log |
  | `kb-missing-index` | `<kb>/<arch>/index.md` absent | fail closed: a tree nobody scanned is not leak-free |
  | `kb-uncertified-claim` | `MEASURED` without GPU + date + command, or no boundary section | the claim outruns its evidence |

  `README.md` and `TEMPLATE.md` are exempt from rules 1–3 (they name what they forbid).
- **`kernel_kb index` validates, never generates.** Every entry appears in exactly one arch index,
  every index row points at an existing entry, every row's status matches the entry's. Generation
  would make the index a table of contents again, and the symptom phrase is the judgment.
- **What is deliberately not built**: the `[PRICED]` gate machinery (one rule, already in `plan`),
  the KEEP-axis evidence class and the three gate points (they need the loop, `plan` and `evidence`
  own those), quarantine-by-move (a workspace KB is small enough to fix in place), `_stale_price`.
  Each would be a crippled copy teaching that a price tag can be decorative.

### C · The join with `plan` (one ticket)

- **`KB:<entry>` becomes a resolvable `[PRICED:]` source.** `plan` currently resolves `profile:` and
  `cell-group:` and leaves a prose source to the reader. This module adds `KB:` to that resolver:
  it resolves iff `kernel_kb cite` would emit, and the refusal names the same reason. That is the
  one cross-module change, and it is why this spec lists `evidence` as a dependency: a `MEASURED`
  claim needs a runner that measured.

## Out of Scope

- Any **collection** of SASS: running `cuobjdump`, `nvdisasm`, `ncu`, or compiling. The tool reads
  what the caller produced; the caller has the GPU.
- **Timeline / PM sampling / stall ledgers** (`research/skills.md` §`stall`, §`timeline`): those need
  a live job and belong to the profile path `evidence` built.
- **Blackbox / sealed-reference mode**, the kernel fence, the reference-token derivation from a
  hidden tree. We have no hidden tree; the token list is a file a human edits.
- **Publishing the local KB to `kernel-wiki`.** `corpus` owns promotion; an entry here is a candidate
  for that path, not an automatic page.
- A **web UI**, a database, embeddings, or search over `kb/`. It is markdown and grep.
- Six more readings. If a seventh question appears, it is a spec change.

## Acceptance Criteria

- [check: `npm test`] — the parser reads both formats from fixtures captured on `h200-7` and produces
  the same census for the same kernel; a dump with no `--kernel` and no execution column is refused
  as `sass-kernel-ambiguous` naming the candidates and their instruction counts.
- [check: `npm test`] — each of the six views prints its verdict line with `kernel=`, the dump path,
  and its sha; `operands` distinguishes `a_reg` from `a_desc`; `serial` reports the ratio and the
  band it lands in; `live` reports peak registers against the contract's budget; `struct` reads
  precision from opcodes; `launch` reads the cluster from the metrics, not from the grid shape.
- [check: `npm test`] — `kernel_kb cite` refuses an entry with no certification mark, an `UNVERIFIED`
  entry, an entry with no boundary section, and an entry whose `MEASURED` status lacks a GPU or a
  date; it emits `KB:<id>` for a complete one. Each refusal names what is missing.
- [check: `npm test`] — each lint rule fires on a fixture and stays quiet on a clean tree; a missing
  `kb/<arch>/index.md` is a finding that says nothing was scanned; `README.md` is exempt from the
  three content rules; `kernel_kb index` reports an entry with two index rows and a row pointing at a
  missing entry.
- [check: `npm test`] — a `[PRICED: …, KB:<entry>]` on a `sass-derived` gate line resolves for a
  certified entry and is refused as `gate-citation-unresolved` for an `UNVERIFIED` one, with the
  citation tool's reason quoted.
- [evidence: `runs/instruments-1/`] — real dumps from the SAXPY fixture on `h200-7`
  (`cuobjdump -sass` and the NCU source page), the six verdict lines on them, one `kb/sm90/` entry
  written from a real reading with its certification header, and a `[PRICED: …, KB:<entry>]` gate
  line resolving.
- [judgment: the user] — that the three statuses (`MEASURED` / `UNVERIFIED` / `TODO`) and the
  certification header are something they would keep writing, rather than a form they fill to get
  past a lint. This is the one criterion code cannot settle.

## Ask First

- **`kb/` is per workspace, committed.** If it should be one shared tree across tasks (a repo-level
  `kb/`), the resolver needs a second lookup root and the index needs a scope. That is a different
  product and a bigger decision than it looks: a shared tree is where per-structure conditions start
  being wrong.
- **Six views is a floor.** An architecture with a different pipeline (tcgen05) may need a seventh
  (`utcmma` commit/wait pairing is inside `schedule` for now). Adding one is cheap; adding its
  threshold table is not.
- **The reference-token list is a file, not a derivation.** ForgeKernel derives tokens from a hidden
  reference tree. We have none, so `docs/reference-tokens.txt` is hand-maintained and can rot. The
  alternative — a lint that derives from a corpus — would need the corpus to be the thing being
  protected, which it is not.

## Open Questions + Assumptions

Assumptions:

1. `evidence`'s reading block (v1) and the contract (schema v2) are frozen; this module adds no
   reading fields, and `kernel_sass` does not write `.kernel/`.
2. A SASS dump is a *derived* artifact: it is regenerable from a commit, so it is archived under
   `runs/` as evidence, never committed into `kb/`.
3. `kb/` entries are English (repo rule), one mechanism per entry, and the entry id is kebab-case and
   frozen once cited — the same contract the corpus uses for page ids.

Open questions:

1. **Does `kernel_sass` read the contract to know the register budget?** Recommendation: yes for
   `live` (it needs a budget to compare against) and no for the rest; an absent contract means
   `live` reports the peak without a verdict band, rather than inventing a budget.
2. **Should `struct` warn on a precision axis below the reference's?** Recommendation: warn, never
   gate — it is the same asymmetry `precision-regression` already has: a *measured* regression is the
   candidate's arithmetic, an inferred one is a reading.
3. **How does a `MEASURED` entry get its GPU and date?** Recommendation: from the reading block of
   the run that produced it, not from `nvidia-smi` at write time: the entry is a claim about a run,
   and the run is the thing with a date.
4. **Do SASS verdict lines belong in `benchmark.csv`?** Recommendation: no. The ledger is decisions
   and their readings; a SASS view is a reading *of the code*, and it travels in the archive and the
   KB entry, not in the lineage table.
5. **What does `launch` do when the dump has no `launch__*` metrics?** Recommendation: report
   `LAUNCH-PARTIAL` with the fields it has and name the missing ones; a launch shape read off the
   grid is the fallacy the view exists to prevent.
