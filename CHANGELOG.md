# Changelog

## [Unreleased]

### Changed

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
