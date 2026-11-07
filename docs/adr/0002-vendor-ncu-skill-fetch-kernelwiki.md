# ADR 0002: Vendor the ncu skill, fetch KernelWiki at a pin

## Status

Accepted (2026-11-07).

## Context

Two upstream skills are being carried:

- `ncu-report-skill` — 23 files, 592 KB, MIT, self-contained, used on every profiling task.
- `KernelWiki` — 1589 files, ~37 MB, MIT for original material but with verbatim artifact bundles retaining upstream terms. Its tree carries 19 files marked `LicenseRef-NvidiaProprietary`; kda's notice says those are omitted from its distribution, but the upstream commits (old pin and current HEAD alike) contain them.

Options: bundle both, fetch both, vendor ncu only, or require the user's own checkouts.

## Decision

Vendor `ncu-report-skill` verbatim at a recorded revision (`VENDORED.yaml`), with `scripts/sync-vendored-skill.sh` for re-syncing. Fetch KernelWiki on demand at a recorded revision into `<agent dir>/kernel-expert/cache/`, verify it, **prune every file under `artifacts/` whose body carries `LicenseRef-NvidiaProprietary`**, write the removed paths to `SANITIZED.yaml`, and only then register the tree through pi's `resources_discover`.

Pin: `b6b4301f15e8ce6955a56776690643ce5db369e6`. kda's `76d27b5` was considered first and rejected: it predates the bundled pure-Python YAML fallback, so `query.py` fails on a machine without host PyYAML — verified on this host — and it contains the same 19 restricted files, so it buys no license safety.

Nothing from `KernelWiki/artifacts/` is redistributed.

## Consequences

- Profiling works offline immediately; the corpus costs one fetch.
- npm tarball stays small and free of artifact licensing obligations.
- The cache is per-user and outside the package, so `npm` updates never touch the corpus.
- A fresh machine needs a bootstrap step before KernelWiki is available; the status command reports the state instead of pretending.
- Sanitization is enforced at fetch time, not by trusting an upstream claim: a real fetch of the pin removed exactly 19 files, and a later repair pass prunes a reintroduced one.
- The fetched `SKILL.md` declares `name: KernelWiki`, which is not Agent Skills compliant; pi loads it with a warning rather than rejecting it. Editing the vendored corpus to silence the warning is not worth diverging from upstream.
- Re-vendoring is a reviewable diff plus a notice check, not an automatic update.
