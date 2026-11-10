# Spec: feature-kernel-expert-v2 / `corpus`

Fourth module of the capability map in `map.md` (`evidence` → `spec.md`, `plan` → `spec-plan.md`,
`instruments` → not yet specced). This one points the other way: `instruments` *reads* the corpus,
`corpus` *writes* to it.

## Objective

Every promotion that rests on a measured mechanism should leave a transferable entry behind, and the
cost of producing that entry should be one tool call at the moment the work lands — not a
maintenance chore someone remembers later. Today a keep records metrics and a profile pointer, and
the mechanism it proved dies with the task.

Success: a keep with profile evidence produces a validated candidate entry in the workspace, and a
human moving it into `kernel-wiki` is a `mv` + a pin bump, not a writing session.

## Implementation Decisions

- **The tool is `kernel_wiki_candidate`, and it emits a file, not a pull request.** It writes
  `.kernel/wiki-candidates/<id>.md` in the task workspace. Publishing is a human step:
  `cp` into `ariesfish/kernel-wiki/wiki/<type>/`, `generate-indices.py`, the two checks, commit, then
  bump `KERNEL_WIKI_PIN` in this package. Nothing writes into the corpus automatically.
- **Facts come from the record, judgment comes from the agent.** The tool pre-fills what it already
  knows — `architectures` from the reading's GPU, the contract sha and reading sha as `sources`,
  `measured` from the candidate's metrics and pairing state — and refuses to invent the four things
  it cannot know: `mechanism`, `trigger`, `load-bearing conditions`, `gotchas`.
- **The entry schema is kernel-wiki's own frontmatter plus five sections**, so a candidate needs no
  transformation to become a page:
  ```yaml
  id: <kebab-case, stable, never renamed>
  title: "<one sentence>"
  type: technique | pattern | hardware | migration
  architectures: [sm90]          # pre-filled from the reading
  tags: [..]
  confidence: verified | source-reported | inferred | experimental
  sources: [<candidate id | profile run>]
  ```
  Sections: `## Mechanism`, `## Trigger`, `## Measured footprint and cost`,
  `## Load-bearing conditions`, `## Gotchas`, `## Negative readings`.
- **`confidence` means measurement status, not source trust.** `verified` requires a source that
  resolves to a candidate id or a profile run in this workspace; `inferred` and `experimental`
  require at least one source and say in the body what was not measured. A `verified` entry with no
  resolvable source is refused.
- **The trigger must be an observable.** The milestone's phrase list is reused, not re-implemented:
  `when needed`, `as needed`, `as appropriate`, `if slow`, `if needed`, `optimize`, `improve`,
  `make it faster`, `tune` are refused.
- **Operator-agnostic, by refusal.** The corpus is shared across operators; an entry that names this
  task's cells, commands, or file paths is refused (`entry-reference-leak`), because the next
  operator cannot resolve them. The allow-list is the entry's own code block and the hardware names.
- **Negative readings are first class.** `## Negative readings` may be empty, but if the task tried
  and rejected a variation of this mechanism, the entry records it — "worthless here" is knowledge
  the next run needs. This is the one section a reviewer should insist on.
- **A keep records whether it produced one.** `kernel_candidate` gains `wiki`:
  `{ id }` when a candidate exists, `none` when the keep proved no transferable mechanism, and
  `declined` with a reason. A keep with profile evidence and a bottleneck claim but no `wiki` field
  is a **warning**, not a refusal: a pure tuning win with no mechanism is legitimate.
- **Resolution against the corpus is best-effort.** When the cache is present, `entry-id-taken` is
  checked against existing page ids and refused. When it is absent the tool says so and validates by
  shape only — the same declared degradation as `plan`'s `knowledge-source-absent`.

## Out of Scope

- Writing into the corpus, opening a PR, or bumping the pin automatically.
- A general KB container with a symptom index (`instruments`).
- Certifying an entry by GPU probe (that is what `verified` + a resolvable source means here; a probe
  protocol is `instruments`' problem if it ever exists).
- Multi-task dedup: two tasks may produce two candidates for one mechanism; merging them is the
  human's job at publish time.

## Acceptance Criteria

- [check: `npm test`] — the tool refuses a missing `mechanism`/`trigger`/`conditions`/`gotchas`, a
  category trigger, a `verified` confidence with no resolvable source, a leftover placeholder, and an
  id already present in a fixture corpus; each message names the section or the id.
- [check: `npm test`] — a candidate is pre-filled with the reading's `architectures` and `sources`,
  and the emitted file parses back to the same model (round-trip).
- [check: `npm test`] — `kernel_candidate` records `wiki: {id}` on a keep and warns (not refuses)
  when a keep with profile evidence has no wiki field; `benchmark.csv` gains the column.
- [evidence: `runs/corpus-1/`] — one real promotion from the SAXPY fixture producing a candidate
  entry, the entry text, and the diff a publish would apply to `kernel-wiki`.
- [judgment: the user] — that the emitted entry is one you would merge as-is.

## Ask First

- `candidates.jsonl` gains `wiki`. Same 0.x acceptance as before; it invalidates archived rows again.
- The refusal of task-specific names: an entry that names its own kernel function is sometimes the
  clearest writing. The rule says no; if that is too strict, the alternative is a warning plus a
  reviewer check.

## Open Questions + Assumptions

Assumptions:

1. `plan`'s decision ids exist, so an entry can name the decision that proved it (soft: the field is
   optional until T-013 lands).
2. The corpus stays a fetched pin; publishing is manual by design.

Open questions:

1. **Should a promotion with no profile evidence be allowed to produce an entry?** Recommendation: yes,
   as `experimental` — a measured speedup with no profile still teaches something, it just cannot
   claim `verified`.
2. **One entry per promotion, or one per mechanism?** Recommendation: per mechanism, and the tool
   refuses a second candidate in the same workspace with the same `id` (it is the same mechanism
   measured twice).
