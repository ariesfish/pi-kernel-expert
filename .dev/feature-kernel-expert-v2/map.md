# Capability Map: pi-kernel-expert v2 (valid readings, addressable plans, instruments)

Initiative dir: `.dev/feature-kernel-expert-v2/` (gitignored process memory).
Source: `.dev/forgekernel-gap/research.md` (the gap analysis this map builds from).

| Module id | Responsibility | Depends on |
|---|---|---|
| `evidence` | A recorded reading is a measurement: basis, host-bound precondition, same-job pairing, input groups, precision gate, harness immutability, archive provenance | — |
| `plan` | The plan is an addressable artifact: decision rows with five-tuple + DAG + typed gate lines, candidate→decision linkage, dead-end table, plateau diagnosis by adversarial reviewer | `evidence` (a gate line is only meaningful when the reading behind it is valid) |
| `corpus` | A promotion that rests on a measured mechanism leaves a validated candidate entry in the workspace; publishing to `kernel-wiki` is a human `mv` + pin bump | `evidence` (the reading), `plan` (the decision id, optional) |
| `instruments` | The agent can answer structural questions without guessing: static SASS reads (operand census, ptxas serialization, launch shape, barrier identity, liveness), job-env check, KB container (symptom index, schema, lint, refusal-bearing citation) | — (independent of `plan`; KB certification additionally needs the `evidence` runner) |

Spec files: `evidence` → `spec.md` (shipped, 9 tickets, 2026-11-10); `plan` → `spec-plan.md`
(approved, T-010 shipped, T-011..T-016 open); `corpus` → `spec-corpus.md` (approved 2026-11-10);
`instruments` → `spec-instruments.md` (approved 2026-11-10, T-020..T-027 open).

Build order: `evidence` → `plan`; `instruments` may start any time after `evidence` lands its
runner, and its KB certification half waits for `evidence`.

## Carried decision (from the design question: teacher vs reviewer)

**No teacher role.** A second planner adds a serialization point and doubles token spend without
adding information: in pi the agent that talks to the human *is* the architect, and a teacher sharing
its context inherits its theory.

What the loop actually needs at a plateau is **disagreement**, not instruction. So:

- **Plan edits stay with the executing agent, but only through a validated artifact.** `plan`'s
  validator refuses an unknown `changed_entries` id or a byte-identical milestone — the tool, not a
  second model, is what stops a self-serving plan edit. (This is ForgeKernel's
  `_patch_landing_violations` idea without its second agent.)
- **Plateau diagnosis is an adversarial reviewer** in a fresh context (pi subagent, readonly,
  different model), required to return: the one decision that is missing or broken, the cheapest
  discriminating measurement, and what to abandon. Reviewer-shaped, not planner-shaped.
- **Unattended runs** get a supervisor with a decision menu (advance / stop / escalate), which is a
  reviewer with an action set — still not a teacher.

Rationale and evidence: `research.md` §"D · 外层循环与角色"; `notes/method.md` §1.3, §5.5.

## Host capabilities: consumed, never owned

Delegation and mid-run questions are host features, not package features. Verified against the
installed trees:

| Capability | Where it lives today | This initiative |
|---|---|---|
| subagent dispatch (`agent`: batch, worktree, readonly, per-task model) | pi-dev-mode's extension (`pi/index.ts`, `agents.ts`, `batch.ts`) | consumed as an optional capability; the kernel package ships the *policy* (roles, briefs, return contract), not the engine |
| `ask_user_question` (structured HITL) | pi-dev-mode's extension (`pi/ask.ts`) | used in the **build** lane and at **freeze**; never inside the candidate loop (a blocking dialog in an unattended run is a deadlock) |
| blind diff reviewer | **pi-goal already has it** (`review_goal` → `execution/review-adapter.ts`: isolated temp dir, payload only, JSON findings, blocks only on an executed failing repro) | reused; the kernel package adds only the *trajectory* reviewer at plateau |
| harness protection | **pi-goal already has it** (benchmark protection on `goal.sh`/`goal.checks.sh`, shell-write interception, `scope_globs`, `test_globs`) | narrowed to naming: `harnessGlobs` + a default `scopeGlobs` that excludes the comparator |

Consequence for `evidence`: the harness-immutability ticket shrinks to a naming/default fix plus a
second, cheap check in `kernel_candidate`. The enforcement already exists one layer down.

## HITL placement

Three seats only — freeze, contract change, environment. `flow.md` carries the table. The rule that
matters for this module: **no ask inside the candidate loop.** pi-goal's own design agrees — the human
pre-authorizes (`/goal allow-tests`, `/goal allow-benchmark`) instead of being interrupted.
