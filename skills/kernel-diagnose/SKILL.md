---
name: kernel-diagnose
description: >-
  Use when a kernel optimization has plateaued: candidates keep getting rejected,
  the numbers stopped moving, or three attempts in a row died in the same place.
  Dispatches a readonly reviewer in a fresh context on a different model, gives it
  only the artifacts (not the reasoning), and turns its verdict into one `###
  Diagnosis <id>` block under `## 4. Dead Ends`. Chinese triggers: 卡住了, 一直没提升,
  plateau, 连续几次都没通过, 换个思路看看, 诊断一下为什么不动了.
  Not for ordinary candidate iteration, not for a first look at a slow kernel
  (that is kernel-flow), and not for anything with a working hypothesis left
  untested.
---

# Kernel diagnose

A plateau is not a reason to try harder; it is evidence that the plan's current
reading is wrong somewhere. This skill produces that reading as a record.

The reviewer is **adversarial and fresh**: a subagent on a different model with
no access to the implementing agent's reasoning, only the artifacts. A reviewer
that inherits the theory inherits its blind spot, and an agent asked to grade its
own plateau will grade its effort.

## When to invoke

- Three consecutive candidates rejected, or a keep whose geomean never moved.
- The same refusal fired on candidates that felt different.
- A gate line keeps failing while the number it should move does not.
- Not on a first slow kernel: `kernel-flow` plus a profile finds the bottleneck.
- Not while a hypothesis is untested: measure first, then diagnose.

## The reviewer brief

Dispatch with the `agent` tool, `readonly: true`, and a model that is not the
one running the loop. Paste this brief, fill the slots, and give the reviewer
**only** the payload below it.

```text
You are reviewing a stuck CUDA kernel optimization. You have the artifacts and
not the reasoning, on purpose: the reasoning is the thing under review.

Read these, in this order, and nothing else:
  1. docs/milestone.md        — the plan, its decisions D<m>.<n>, its gates, its dead ends
  2. candidates.jsonl         — every attempt, its decision id, its reading, its refusal
  3. profile/<run>/summary.json — the counters the last attempt rested on
  4. the last diff: <diff command or path>

Answer exactly four questions. No preamble, no summary of what you read.
  class: one of missing-decision | wrong-decision | measurement-defect | environment
      missing-decision: the plan has no decision that would move this. You must name it.
      wrong-decision:   a decision is aimed at the wrong limiter, or was never
                        the binding constraint. You must name it.
      measurement-defect: the number the loop is steering by is not measuring the
                        change (wrong grain, host-bound, a stale profile).
      environment:      the machine, clocks, foreign processes, driver or toolchain.
  decision: the single decision to add or change, by id (D<m>.<n>), or the id of the
      decision this diagnosis is about. Never a list: a plateau diagnosed as three
      things is a plateau not diagnosed.
  measurement: the cheapest measurement that tells your class apart from the
      alternatives. It must be runnable as one command on the frozen contract, and
      it must be able to come out falsifying you.
  abandon: what to stop doing. Name the candidate class or decision to drop. A
      diagnosis that abandons nothing has not decided anything.

Rules:
  - Cite the artifact and line for every claim about what happened. "Feels
    latency-bound" is not a finding; "M1 Gate:3 fails while cells stay within
    3% of each other, candidates.jsonl rows 4-6" is.
  - If the artifacts cannot support a class, say `measurement-defect` and name the
    measurement that is missing. That answer is a real answer.
  - Do not propose code. Do not propose a candidate. The output is a diagnosis.
```

## What comes back

One block, appended under `## 4. Dead Ends` in `docs/milestone.md`:

```text
### Diagnosis plateau-1
- class: wrong-decision
- decision: D1.2
- measurement: profile a 4-warp variant at m1024/typical and compare sectors per request
- abandon: the 128x128 tile; it spills before the mapping matters
```

Then `kernel_milestone` validates it. The block is checked by shape — the four
fields, one of the four classes, a decision id the milestone has — and **never
gates**: it cannot make a gate line pass, and a milestone whose only evidence is
a diagnosis is refused for having no gate line.

## Two failure modes to name out loud

- **The reviewer agrees with the plan.** If its `class` is `wrong-decision` and
  the decision it names is the one the plan already leans on, ask it once for the
  strongest case *against* its own answer before recording it. A diagnosis that
  ratifies the plateau is not a diagnosis.
- **No reviewer available.** If the `agent` tool is absent or no second model is
  reachable, the executor may diagnose itself, and the block must carry
  `- self-diagnosis: <why>`. The line is required precisely because a
  self-review smells the same as a review in the file.

## After the diagnosis

The agent that owns the milestone applies it — no teacher, no second author. A
`missing-decision` becomes a new `#### D<m>.<n>` row, `wrong-decision` rewrites
the named row's `Trigger` or `Purpose`, `measurement-defect` sends the loop back
to `goal.sh` or `kernel_profile`, and `environment` is a HITL seat: it is the one
class that can change the machine out from under a measurement.
