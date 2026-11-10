# T-012 evidence — two citation namespaces against the fetched corpus

Run 2026-11-10 on the build machine, against the pinned corpus that
`kernel_bootstrap` had already fetched (no GPU involved: this ticket resolves
pointers, it does not measure).

| Artifact | What it is |
|---|---|
| `citations.txt` | fourteen cases, verbatim: both namespaces, each resolution and each refusal |
| `run-citations.mts` | the script, driving the real validator against the real cached corpus |
| `corpus-fixture/` | a two-page corpus for the unit tests (not the evidence: the evidence is the real one) |

The corpus read for the run: `~/.pi/agent/kernel-expert/cache/kernel-wiki@3c41f99…`,
53 pages, 46 labelled, 7 unlabelled.

What the fourteen cases establish:

- **A real id resolves.** `wiki:migration-wgmma-to-tcgen05#source-reported` is clean;
  the page is there and the label is one of the four.
- **An unlabelled page warns instead of refusing.** `pattern-memory-bound` has no
  `confidence:` line in the corpus, so citing it without one is accepted with
  `wiki-citation-unlabelled`, and citing it *with* a label the citer supplies is
  clean: the label is the citer's claim and the corpus does not contradict it.
- **Shape is always checked**, corpus or not: a fifth confidence word and a
  non-kebab id are both refused by name.
- **Knowledge never measures**: a citation on a gate line is
  `gate-cites-knowledge`, and a citation on `Cost` is `wiki-citation-misplaced`.
  Both were one-defect-one-refusal: before the fix, the gate-line case was also
  charged `gate-citation-unresolved`, which sends the author to the wrong edit.
- **An absent corpus is visible, not silent**: the same file passes with
  `knowledge-source-absent` naming `kernel_bootstrap`.
- **Measurement pointers resolve or name the lookup path**: `profile:run2` reports
  `profile/run2/summary.json` and which runs do exist; a cell-group reports the
  groups the cell has; a `[PRICED: …]` source is resolved when it is a pointer and
  left alone when it is prose (`measured on the sm90 box`).
