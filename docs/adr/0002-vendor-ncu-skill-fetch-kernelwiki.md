# ADR 0002: Vendor the ncu skill, fetch KernelWiki at a pin

## Status

Accepted (2026-11-07).

## Context

Two upstream skills are being carried:

- `ncu-report-skill` — 23 files, 592 KB, MIT, self-contained, used on every profiling task.
- `KernelWiki` — 1589 files, 37 MB, MIT for original material but with verbatim artifact bundles retaining upstream terms; kda distributes a sanitized revision that omits 19 NVIDIA-proprietary CuTe DSL files.

Options: bundle both, fetch both, vendor ncu only, or require the user's own checkouts.

## Decision

Vendor `ncu-report-skill` verbatim at a recorded revision (`VENDORED.yaml`), with `scripts/sync-vendored-skill.sh` for re-syncing. Fetch KernelWiki on demand at kda's sanitized pin (`76d27b5…`) into `<agent dir>/kernel-expert/cache/`, verify the revision, and register it through pi's `resources_discover`.

Nothing from `KernelWiki/artifacts/` is redistributed. Upstream HEAD is never substituted for the pin: doing so would silently change the license boundary.

## Consequences

- Profiling works offline immediately; the corpus costs one fetch.
- npm tarball stays small and free of artifact licensing obligations.
- The cache is per-user and outside the package, so `npm` updates never touch the corpus.
- A fresh machine needs a bootstrap step before KernelWiki is available; the status command reports the state instead of pretending.
- Re-vendoring is a reviewable diff plus a notice check, not an automatic update.
