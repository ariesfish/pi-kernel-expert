# Changelog

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
