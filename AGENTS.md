# Agent Instructions

## Repository language

English for repository-facing files, comments, documentation, prompts, and commit messages.

## Agent skills

### Issue tracker

Issues and tickets are tracked as local files under `.dev/` (per-developer, gitignored). The active feature is `.dev/feature-pi-kernel-expert/`: `spec.md`, `plan.md` (the ticket graph), and `todo.md` (checkboxes). See `docs/agents/issue-tracker.md`.

### Triage labels

Use the canonical vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Read `CONTEXT.md` and the relevant `docs/adr/` file before domain-sensitive work. See `docs/agents/domain.md`.

## Evidence rules

- Never claim a measured speedup without a recorded run: GPU identity, clock state, run count, and range.
- No GPU, ncu, or nvcc on the build machine. Anything hardware-dependent is written as unverified until `make gpu-smoke` runs on a machine and the output is archived in `docs/verify.md`.
- The vendored `skills/ncu-report-skill/` tree is upstream-owned: fix upstream, re-sync with `scripts/sync-vendored-skill.sh`, never hand-edit.
- KernelWiki is fetched at a pin, never bundled. A pin bump updates `support/paths.ts`, `THIRD_PARTY_NOTICES.md`, and the changelog together.

## Release hygiene

When changing `package.json` version, update `CHANGELOG.md` in the same change with a matching `## [x.y.z]` section. The publish workflow requires the changelog section for the package version.

## Boundaries

- `pi-goal` is a peer, not a dependency to fork: this package owns no phase machine, journal, gate, or dashboard.
- Kernel rules enter pi-goal as generated scripts and `asi` data. If a rule cannot be expressed that way, it is an ADR before it is code.
