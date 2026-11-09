# ADR 0007: The corpus is our own pin, not mit-han-lab's

## Status

Accepted (2026-11-10). Amends ADR 0002's pin and remote; keeps its decision to fetch rather than
bundle.

## Context

ADR 0002 fetched `mit-han-lab/KernelWiki` at a pinned revision, pruned the 19 files marked
`LicenseRef-NvidiaProprietary` at fetch time, and recorded them in `SANITIZED.yaml`. Three problems
have since shown up in use:

1. **The skill name breaks Agent Skills.** `SKILL.md` declares `name: KernelWiki`; the spec allows
   lowercase letters, digits and hyphens, so pi loads the tree with a warning on every session.
2. **Pruning at fetch is a per-consumer cost.** Every machine that bootstraps repeats the scan, and
   the licence boundary lives only in the consumer's cache — a copy taken from upstream directly
   still contains the restricted files.
3. **Upstream is no longer maintained.** A pin we cannot update is a dead dependency, and the corpus
   is the part of this package that ages fastest.

A fork used only for local edits was rejected: the corpus is data, and a fork nobody releases is a
copy, not a project.

## Decision

Maintain the corpus as its own repository, `ariesfish/kernel-wiki`, and keep fetching it at a pin:

- **Name**: `kernel-wiki`, compliant; `license: MIT` declared; the Claude-only `argument-hint`
  dropped; `allowed-tools` names the tools the consuming runtime has.
- **Sanitisation happens at the source**: the 19 restricted files are removed in the repository and
  listed in `SANITIZED.yaml`. The fetch still scans for the marker — an absence it did not verify is
  an absence it cannot claim — but the normal result is now "0 removed".
- **Page ids are frozen.** Ids are the citation contract; `migration-wgmma-to-tcgen05` must stay that
  id forever. New pages may be added; an id is never renumbered.
- **The pin** is `b0cd75891e107c81689eb723f5b2cc281b9c1889`; `KERNEL_WIKI_SKILL` becomes
  `kernel-wiki`, so the cache directory is `kernel-wiki@<pin>` and an older cache is simply not
  found.
- **Delivery stays as ADR 0002 chose it**: fetched on demand into the agent cache, never bundled
  into the npm package.

## Consequences

- A fresh bootstrap no longer prints the name warning, and the licence boundary is a property of the
  repository rather than of each consumer's cache. `SANITIZED.yaml` still travels with the corpus.
- Every existing installation's `KernelWiki@b6b4301…` cache is orphaned. It costs 37 MB and one
  `kernel_bootstrap`; nothing references it after the rename.
- The pin now points at our own commit, so "upstream changed" is no longer a reason to move it.
  Moving it means: add pages, run `scripts/generate-indices.py` plus the two checks in `scripts/`,
  commit, bump `KERNEL_WIKI_PIN`, and update the changelog and `THIRD_PARTY_NOTICES.md` together.
- Corpus updates are decoupled from package releases, which is the property ADR 0002 wanted and a
  bundled copy would have lost.
- The fork is a copy of MIT material plus upstream artifact terms; provenance and the divergence
  list live in the corpus README and in `THIRD_PARTY_NOTICES.md`. Upstreaming the name fix remains
  possible and would retire this ADR without changing any consumer.
