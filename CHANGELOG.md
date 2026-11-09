# Changelog

## [Unreleased]

### Changed

- The fetched corpus is now **`kernel-wiki`**, our own pinned copy of
  mit-han-lab/KernelWiki (`377d4560840d`), packaged as a standard Agent Skill:
  `CLAUDE.md` became `SCHEMA.md`, the frontmatter declares `license`,
  `compatibility` and `metadata` and nothing Claude-specific: the skill name is Agent Skills
  compliant, so the corpus loads without a warning; the 19 files marked
  `LicenseRef-NvidiaProprietary` are removed at the source and listed in its
  `SANITIZED.yaml` (the fetch still scans for the marker); page ids are frozen.
  The cache directory moves to `kernel-wiki@<pin>`, so an existing
  `KernelWiki@…` cache is orphaned and one `kernel_bootstrap` replaces it. See
  ADR 0007.

- **Breaking**: `kernel.contract.json` is now schema v2. A v1 or unversioned
  contract is refused at read time with "regenerate with kernel_contract";
  there is no migration. See `docs/adr/0006-contract-v2-reading-provenance.md`.
- The contract records how the number was taken (`basis`: `device` | `e2e`),
  which files make it (`harnessGlobs`, default `goal.sh` + `goal.checks.sh`),
  and an optional same-job reference (`referenceCommand`). `kernel_contract`
  warns when a command runs a file no harness glob covers.
- Contract artifacts are written through temp files and renamed, contract last,
  so an interrupted regeneration cannot leave a contract beside scripts whose
  embedded sha disagrees with it.
- A contract cell now carries `groups` — the input data sets it is measured on.
  A non-boundary cell needs at least three, each with an `intent`; the cell's
  value is the geomean of its groups, so one group's regression moves the cell.
  A contract without groups is refused at read time; regenerate it.

### Added

- `goal.sh` prints one `=== KERNEL READING ===` JSON block per run — contract
  sha, basis and its source, GPU state (name, clocks, utilisation, foreign
  memory) at start and end, per-cell medians and spread, shell wall time,
  `hostEnqueueMs`/`deviceMs` when the task reports them, a tri-state
  `hostBoundVerdict`, and warnings. A number bash cannot measure is absent,
  never zero: without the task's own device/enqueue figures the ratio is null
  and the verdict is `unmeasured`. `parseReadingBlock` refuses a truncated
  block, a non-JSON body, an unknown schema, and a verdict that contradicts its
  own ratio.
- The reading records a declared clock lock (`clockLocked`: declared and
  observed MHz, `held`) and the loaded sample (`gpu.loaded`, including the
  card's maximum SM clock). A lock nobody declared stays absent rather than
  reading `held: false`.
- A same-job reference rides the benchmark when the contract names
  `referenceCommand`: the reading reports `pairing`, the reference/candidate
  `pairRatios`, and their `pairSpreadPct`.
- `bash goal.checks.sh --calibrate` records the reference's own error per dtype
  (`e_ref`), the precision ruler. A keep is refused when the candidate's
  `max_diff` exceeds `3 * e_ref + max(ulp(dtype), 2^-17)`; with no calibration
  the ruler is `unmeasured` — a run-side defect that may be forced with a
  reason, never a judgement against an invented zero.
- `kernel_candidate` refuses a keep the reading does not support, with eight
  rules: `basis-missing`, `host-bound`, `harness-touched`,
  `cell-group-uncovered`, `reading-contract-mismatch`, `metric-not-in-reading`,
  `precision-regression`, `profile-stale`. Each names the side it is charged
  to. `basis-missing`, `host-bound`, `cell-group-uncovered` and uncalibrated
  precision may be forced with a reason; an edited harness, a measured
  precision regression, a foreign reading and a stale profile may not.
- `kernel_wiki_candidate`: a keep that rests on a mechanism writes a candidate
  page to `.kernel/wiki-candidates/<id>.md` in kernel-wiki's own shape —
  frontmatter plus Mechanism, Trigger, Measured footprint and cost,
  Load-bearing conditions, Gotchas, Negative readings. It refuses a category
  trigger, a `verified` source that does not resolve here, a leftover
  placeholder, a taken id, and a body naming this task's cells or commands. It
  never writes the corpus; publishing is a human step.
- `kernel_milestone`: validates `docs/milestone.md` as an addressable plan —
  the seven sections, phases `M0..Mk`, every decision's five-tuple (`Action`,
  `Purpose`, `Trigger`, `Cost`, `Depends on`) with its `⇐`/`⊗`/`⇒` edges, and
  the typed `[VERIFY: …]` gate lines. It reports every refusal in one pass with
  the rule, the row, and the fix, and never writes the file.
- `scripts/job-env-check.sh`: proves nvcc, Nsight Compute and a CUDA-enabled
  torch are visible from a non-interactive shell on the GPU node, naming every
  missing item and exiting non-zero.

## [0.4.0] - 2026-11-07

### Added

- `kernel_profile`: collect (`ncu --set full`, with the command and versions
  recorded) or attach a report, run the vendored helpers, and write
  `profile/<run>/summary.json`. The summary binds the contract hash and the
  diff hash, records GPU identity, clocks and ncu version, keeps only metrics
  the report actually has (absent ones listed), and ranks rules and stall lines.
  `reuse_analysis` consumes an `analysis/` produced on the profiling machine.
- `kernel_candidate`: append-only `candidates.jsonl` with parent lineage, diff
  and contract hashes, per-cell metrics, profile pointer, bottleneck claim,
  decision and reason. Refuses a keep below the contract's `noiseFloorPct`, a
  keep missing any matrix cell, a stale profile, a profile from another
  contract, and a bottleneck metric absent from the report.
- `noiseFloorPct` in the contract (default 2).
- `kernel-flow` skill: the KDA loop on pi-goal, an artifact table, hard rules,
  a failure table, escalation triggers, and a GPU benchmark checklist.

### Changed

- Evidence freshness is enforced by `kernel_candidate` instead of a generated
  `evidence_check.sh`: one enforcement point, and the ledger format can evolve
  without regenerating every task's scripts. See ADR 0005.


## [0.3.0] - 2026-11-07

### Added

- `kernel_init`: creates `docs/draft.md`, `docs/plan.md`, `profile/`, `runs/`,
  `candidates.jsonl`, and `.kernel/` without overwriting anything, and names
  the draft/plan sections that still need real content.
- `kernel_contract`: validates the draft/plan gate, then generates
  `kernel.contract.json`, `goal.sh`, `goal.checks.sh`, and
  `kernel-freeze.json`. The benchmark records a baseline on first run
  (`geomean_speedup=1`), then reports per-cell medians, a geomean over the
  matrix, and fails on a per-cell regression beyond the guard. The checks run
  every cell twice and name the cell (and boundary status) on failure. Both
  scripts refuse to run when `kernel.contract.json` no longer matches the
  embedded hash.
- Freeze payload with exactly one blocking metric criterion
  (`geomean_speedup`, higher) and one command criterion (`goal.checks.sh`).

### Notes

- The task supplies the per-cell check and benchmark commands; the generator
  supplies the matrix, aggregation, guard, and evidence envelopes. See ADR 0004.
- `evidence_check.sh` moved to T-005, which owns the profile-summary format.


## [0.2.0] - 2026-11-07

### Added

- `kernel_bootstrap`: fetch KernelWiki at the recorded revision
  `b6b4301f15e8…`, verify the checkout, prune files marked
  `LicenseRef-NvidiaProprietary`, record them in `SANITIZED.yaml`, and refuse to
  overwrite a tree at another revision. Idempotent: an `already` fetch repairs a
  reintroduced restricted file without re-cloning.
- `kernel_wiki`: query the cached corpus (`query.py`) or fetch one page
  (`get_page.py`) with filters, compact output by default, and the command line
  echoed for reproducibility. Missing corpus yields the bootstrap instruction.
- `resources_discover` registration of the cached skill, with a best-effort
  conflict scan: an existing `KernelWiki` skill wins and the conflict is named.

### Changed

- KernelWiki pin is `b6b4301f15e8…` rather than kda's `76d27b5…`. The older
  revision predates the bundled YAML fallback (queries fail without host
  PyYAML) and carries the same 19 restricted files, so it offered no license
  advantage. See ADR 0002.
- The status command drops the `scaffold` stage label and points at `kernel_bootstrap` instead of a future ticket.


## [0.1.0] - 2026-11-07

### Added

- Package skeleton with the `pi` manifest (extension + skills), TypeScript
  typecheck, and a node test suite.
- `/kernel-expert` status command: reports the loop-engine state from pi
  settings, the vendored ncu skill revision, and the KernelWiki cache state.
- `ncu-report-skill` vendored at `c7980a43cb88` with `VENDORED.yaml` provenance
  and `scripts/sync-vendored-skill.sh` for re-syncing.
- Third-party notices covering the vendored ncu skill, the runtime-fetched
  KernelWiki pin, and the cited KDA workflow, with verbatim license texts.

### Notes

- No GPU, ncu, or nvcc is available on the build machine. Hardware-dependent
  behavior is unverified; `docs/verify.md` records the boundary.
- KernelWiki fetch (T-003), kernel contract generator (T-004), evidence layer
  (T-005), and the workflow skill (T-006) are not in this release.
