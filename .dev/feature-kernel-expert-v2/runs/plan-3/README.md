# T-015 evidence — the workspace carries a plan, and the skill says so

Run 2026-11-10 on the build machine. No GPU: this ticket wires the plan into the
workspace and the skill, and measures nothing.

| Artifact | What it is |
|---|---|
| `init.txt` | five steps, verbatim: init, the template, the refused template, two contract warnings |
| `run-init.mts` | the script, through the real tools |
| `skill-diff.txt` | the skill's own diff: the milestone step, three hard rules, nine failure rows |

What the run establishes:

1. **`kernel_init` writes `docs/milestone.md`** alongside the draft and plan, and
   says so in its created list.
2. **The template is refused, and every placeholder is named in one pass** — 17
   of them: the decision's heading and its four rows, three gate lines, the
   dead-end row, and each section body. A template that validated would be a
   plan nobody wrote and everybody trusted.
3. **`kernel_contract` warns and still freezes.** With the template in place:
   "docs/milestone.md is still kernel_init's template (1 placeholder decision(s)
   named D0.1)". With no milestone at all: "no docs/milestone.md: the contract is
   frozen but the plan is not addressable, so keeps cannot name a decision."
   Neither refuses: a single obvious change is a legal task.
4. **The candidate binding treats the template as a form, not a plan.** A keep
   recorded against an untouched template names no decision and says why — the
   same degradation as a workspace with no milestone, because `D0.1 <the first
   decision>` is not something a keep can implement.

`skill-diff.txt` is the ticket's named evidence: the step table gains `3b.
Milestone`, the hard rules gain the milestone/decision/M0/plateau rules, and the
failure table gains nine rows — the six refusals this module added plus the three
citations a reader will hit first.
