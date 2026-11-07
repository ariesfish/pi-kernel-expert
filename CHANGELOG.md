# Changelog

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
