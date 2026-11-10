# Spec: feature-kernel-expert-v2 / `plan`

Module `plan` of the capability map in `map.md` (module ids: `evidence` → shipped as `spec.md`;
`plan` → this file; `instruments` → not yet specced). It builds only on `evidence`, which closed on
2026-11-10 with nine tickets and live evidence on `h200-7`.

## Objective

A user running `kernel_flow` must be able to answer, at any point, **which decision is the code
implementing, is it the decision the plan asked for, and what does the plan say to do next** —
without re-reading the session. Today `docs/plan.md` is three headings of prose that nothing reads:
a candidate ledger row cannot be traced to a step, a plateau looks identical to "the agent has not
thought of the next idea", and a green number cannot be separated from "the mechanism landed".

Success: a keep that names a decision the milestone does not contain is **refused**, and after a
plateau the next action is a written diagnosis with a named decision, not another candidate.

## Implementation Decisions

- **The plan is `docs/milestone.md`, an addressable artifact.** Sections: `## 0. Problem and Target`,
  `## 1. Contract`, `## 2. DAG and Phase Order`, `## 3. Decisions`, `## 4. Dead Ends`,
  `## 5. Global Gate`, `## 6. Rules`. Phase `M0` is the architecture; `M1..Mk` are levers inside it.
  English headings (repo rule).
- **A decision is a heading `D<m>.<n> <name>` plus a five-tuple** — `Action`, `Purpose`, `Trigger`,
  `Cost`, `Depends on` — enforced literally, one key per line. `Depends on` carries three arrows:
  `⇐` upstream (a DAG edge), `⊗` companion (lands in the same commit, **not** an edge), `⇒`
  downstream. A dangling id is a validation error, because it silently under-invalidates resume.
- **A trigger is an observable, never a category.** `Trigger: waves/SM < 1 on the reference` is a
  trigger; `Trigger: when it is slow` is refused by a phrase list (`when needed`, `as appropriate`,
  `if slow`, `optimize`, `improve`).
- **Gate lines are typed.** Each line under `### M<k> Gate` carries one of
  `[VERIFY: ncu-direct | ncu-derived | sass-derived | correctness | mechanism]`. `none` may not
  appear on a gate line — `none` means "nothing proves this", which is the one thing a gate cannot
  accept. `[VERIFY: sass-derived]` additionally requires `[PRICED: <delta>, <source>]`, because a
  SASS-shaped claim without a measured price is a guess.
- **Two citation namespaces, and they are not interchangeable.**
  - `profile:<run>` / `cell-group:<cell>/<group>` — **measurement** evidence. Only these may appear
    on a gate line, and they must resolve against `profile/` and the contract or the line is refused
    (`gate-citation-unresolved`).
  - `wiki:<page-id>#<confidence>` — **knowledge** evidence, where `confidence` is one of `verified`,
    `source-reported`, `inferred`, `experimental`. Only these may appear on a decision row's
    `Action` / `Purpose` / `Trigger`; **never** on a gate line. This is the rule `CONTEXT.md` already
    states: a Wiki Citation supports a direction or a diagnosis, never a measurement.
  A `wiki:` pointer is validated by shape always (kebab-case id, enum confidence), and resolved
  against the cached corpus when it is present. Seven of the 52 cached wiki pages carry no confidence
  label; citing one without a label is accepted with `wiki-citation-unlabelled`, because inventing a
  label would be worse than recording that the page has none. When the corpus is absent the line is **not**
  refused — a citation is not a measurement — but the report carries
  `knowledge-source-absent` naming `kernel_bootstrap`: an absent corpus must be visible, not silent.
- **Every milestone carries at least one mechanism-verification line** — a gate line that says the
  mechanism landed, not that the number moved. Without it a milestone cannot be validated at all.
- **M0 freezes by hash, not by promise.** `### M0 Contract` holds `- <item>: <value>` lines (tile,
  smem inventory, warp roles, register budget, issue order, accumulator precision). `kernel_milestone
  lock: true` records `.kernel/milestone.lock.json` = {milestone sha, M0-contract-block sha, time}.
  After the lock, that block must be byte-identical; a later edit is refused as `m0-thawed` and the
  fix is an explicit unlock, which becomes a recorded diagnosis.
- **A candidate names its decision.** `kernel_candidate` gains `decision: "D2.3"` (or a `+`-joined
  bundle) and records `milestoneSha`. It refuses a keep whose decision id is absent from the
  milestone (`decision-unknown`), or whose `milestoneSha` differs from the current file
  (`milestone-stale`). Neither is forceable: an unattributable keep is not a weaker keep, it is not
  a record.
- **A dead end bans a combination, not its members.** `## 4. Dead Ends` rows are
  `- <D ids> | <reason> | <evidence pointer>`. `kernel_candidate` refuses a keep whose decision
  bundle matches a recorded dead end unless the record carries `precondition: <what changed>`;
  retrying alone or in a smaller bundle is a changed precondition.
- **Diagnosis is a record, not an authority.** At a plateau the `kernel-diagnose` skill dispatches a
  readonly subagent in a fresh context on a different model, with a fixed brief and no access to the
  implementing agent's reasoning. It must return one `### Diagnosis <id>` block: `class`
  (`missing-decision` | `wrong-decision` | `measurement-defect` | `environment`), the single decision
  to add or change, the cheapest discriminating measurement, and what to abandon. The block is
  validated by shape and **never gates**; the agent that edits the milestone is the one that already
  owns it.
- **No teacher.** Plan edits go through the validator, which is what stops a self-serving edit: the
  patch must name `changed_entries` that exist, and an M0 edit after lock is refused outright.
- **One new tool, one new skill.** `kernel_milestone` (write/validate/lock/status) and
  `kernel-diagnose` (the reviewer brief). No phase machine: pi-goal still owns the loop.

## Out of Scope

- Lever pricing, the coupling lattice, ablation variants (`plan` names levers; it does not price them).
- The `instruments` module: static SASS tools, KB container, `KB:` resolution in gate lines.
- Any deny list / sealed reference / blackbox mode.
- Generating the milestone from the draft automatically: the agent writes it, the tool validates.
- Multi-task dashboards, resume/reopen-closure arithmetic (a later increment once decision ids exist).

## Acceptance Criteria

- [check: `npm test`] — the validator refuses each of: a missing five-tuple key; a dangling
  `Depends on`; a decision id containing `gate`; a placeholder left in a row; a gate line with
  `[VERIFY: none]`; a `sass-derived` line with no `[PRICED:]`; a milestone with no mechanism line; a
  category-shaped trigger. Each message names the row id and the rule.
- [check: `npm test`] — `kernel_candidate` refuses `decision-unknown`, `milestone-stale`, and a
  banned-bundle retry without `precondition`; a keep with a valid decision records `decision` and
  `milestoneSha` and `benchmark.csv` gains the column.
- [check: `npm test`] — a `wiki:` citation on a decision row is accepted with each confidence label
  and refused on a gate line (`gate-cites-knowledge`); an unknown confidence word is refused by name;
  with the corpus absent the same row passes and the report carries `knowledge-source-absent`.
- [check: `npm test`] — after `kernel_milestone lock`, an edit inside `### M0 Contract` is refused as
  `m0-thawed` and names the changed item; an edit outside it is accepted and moves the milestone sha.
- [evidence: a real workspace, `runs/plan-1/`] — a keep refused for an unknown decision; the row
  added; the same keep accepted; then a plateau diagnosis block written and validated.
- [evidence: `runs/plan-2/`] — the M0 thaw refusal on a real file, with the diff that caused it.
- [judgment: the user] — that the milestone template is something they would actually write, not a
  form they fight. This is the one criterion code cannot settle.

## Ask First

- `candidates.jsonl` gains fields again (`decision`, `milestoneSha`, `precondition`). At 0.x this is
  accepted as before, but it invalidates every archived ledger row — say so now if that is not fine.
- Requiring a mechanism line in **every** milestone: a pure performance chase ("make this 20%
  faster, no theory") becomes unrepresentable. The alternative is a `[VERIFY: performance]` class
  that admits "the number is the mechanism", which weakens the whole rule.
- The `m0-thawed` unlock path: an unlock is a human decision, and the spec makes it recorded rather
  than forbidden. If it should be forbidden outright, that is a different product.

## Open Questions + Assumptions

Assumptions:

1. `evidence`'s fields are frozen (schema v2, reading block v1); this module adds no reading fields.
2. The milestone is per task workspace (`docs/milestone.md`), not per repo — a task is the unit.
3. Reviewers are pi subagents (`agent` tool) when available; where the tool is absent the skill says
   "diagnose inline and mark the record `self-diagnosis`" rather than pretending a second context
   existed.

Open questions:

1. **Does `kernel_contract` refuse without a milestone?** Recommendation: no — warn only. A one-cell
   smoke task does not need a plan, and the friction belongs at the keep, where attribution is what
   the record is for.
2. **Is `decision` mandatory for a rejection too?** Recommendation: no. A rejection needs a reason
   (already enforced); a keep needs attribution. Requiring it on rejections would make the cheap,
   frequent action the expensive one.
3. **Should the corpus be a hard requirement of `kernel_flow`?** Recommendation: no. It is 37 MB and a
   network fetch; a container kernel does not need Blackwell pages. But its absence must be announced
   once per session (`knowledge-source-absent`), because a knowledge source the agent believes it has
   and does not is worse than one it knows is missing.
4. **How many phases may a small task have?** Recommendation: M0 only, with `### M0 Gate` as the
   global gate. A two-phase task can be expressed; a fourteen-phase one is a signal the plan is a
   transcript, and the validator should warn past 8 decisions per phase (warning, not refusal).
