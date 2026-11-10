# Issue Tracker: Local Files (`.dev/`)

This repo tracks issues as plain files under `.dev/` and **tracks them in git**: one owner, more than one machine. A ticket graph that exists on one laptop is not a tracker, and this repo's evidence (`runs/`) is only reviewable if it travels. The shared record is still the merged code, commits, and `docs/adr/`; `.dev/` is how the work was found.

Three things stay ignored even so: `.dev/worktrees/` (physical git worktrees), `.dev/**/*.sqlite` (agent state), and `.dev/**/node_modules/`.

## Layout: feature-first

```text
.dev/
├── feature-<name>/            # one initiative; the whole name is the slug
│   ├── spec.md                # the building contract
│   ├── plan.md                # ticket graph: index rows + blocked-by edges + closed lines
│   ├── todo.md                # checkboxes + triage markers
│   ├── research.md            # optional notes
│   └── tickets/T-XXX.md       # full ticket body, only when a plan row cannot carry it
├── inbox/                     # unattributed intake
├── lifecycle/                 # optional ledger
└── audit/                     # decision tsv + evidence
```

- Feature directory names start with `feature-`; the whole name (prefix included) is the slug.
- T-ids are unique across `.dev/`; the next id is the current maximum + 1. Never renumber.
- One shared plan/todo does not exist at the root: the frontier is per feature. With several features, glob `.dev/*/plan.md`.

## Creating a ticket

Append to the feature's `plan.md`:

```markdown
## [T-004] Title

- **Type**: HITL / AFK
- **Blocked by**: T-002 (or "None")
- **What to build**: one paragraph of end-to-end behavior
- **Acceptance criteria**: three-label list ([check: …] / [evidence: …] / [judgment: …])
```

Add its checkbox block to `todo.md`:

```markdown
## T-004 (ready-for-agent)
- [ ] criterion 1
```

Write `tickets/T-004.md` only when the body needs prototype snippets or interface contracts. A `Status:` line near its top carries the triage state.

## Reading a ticket

Read the `## [T-…]` section in `plan.md` in full before working. "Everything open" means the sections whose task is not checked off in `todo.md`.

## Closing a ticket

Check off its `todo.md` block and add one line under the plan section: `Closed <date>: <one-line resolution>`. Do not delete the section while the feature is in flight.

## Cleanup

When the feature lands and its truth is in code, commits, and ADRs, delete the whole `.dev/<slug>/` directory. `lifecycle/` and `audit/` stay.
