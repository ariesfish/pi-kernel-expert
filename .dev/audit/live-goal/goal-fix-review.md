agent: d4689d21534e24335
description: Review peer Git fix
type: general-purpose
model: zai/glm-5.3-flash
status: completed
exit code: unknown
started: 2026-11-11T08:48:13.195Z
cwd: /Users/ariesfish/Projects/github/dev-skills/pi-kernel-expert/.dev/worktrees/agent-d4689d21534e24335
worktree: /Users/ariesfish/Projects/github/dev-skills/pi-kernel-expert/.dev/worktrees/agent-d4689d21534e24335
---
Review complete. All evidence gathered from live git experiments (Apple Git 2.50.1, scratch repos in /tmp — nothing modified or committed in the pi-goal checkout; the fix remains uncommitted in its worktree as I found it).

## Verdict: the fix is sound; one low-severity behavior regression found

**Confirmed correct (reproduced, not assumed):**
- Old command `git add -A -- . :(exclude).goal :(exclude,glob)**/.goal/**` exits 1 on ignored `.goal/` via git's "paths are ignored by one of your .gitignore files" advice triggered by the literal exclude item; new command exits 0 and stages only candidate files.
- `:(glob)**/.goal/**` zero-directory matching works at repo root and nested (`pkg/.goal/...`) — root and nested journal state excluded in both ignored and unignored trees.
- Tracked-then-modified and tracked-then-`rm`-deleted research state (root + nested) is not staged; tracked state inside an ignored `.goal/` also fine (old command exits 1 on that same state — fix strictly improves).
- workDir-as-subdirectory: new command behaves identically to old (excludes `<workdir>/.goal/**`, never touches root `.goal` which is outside the positive pathspec anyway).

## Actionable findings

**F1 (low severity, real regression): the glob never matches the path `.goal` itself.**
`**/.goal/**` requires a trailing slash + content; the old literal `:(exclude).goal` prefix-matched the exact path `.goal`. Verified: an untracked unignored file/symlink named `.goal` at repo root is now staged and committed by a kept run, and a tracked `.goal` file deleted via `rm` now has its deletion staged (old command excluded both). pi-goal itself always creates `.goal` as a directory, so this needs a user-created `.goal` file to trigger — but it is the one behavior lost. **Fix:** append `:(exclude,glob)**/.goal` to the pathspec — verified this variant still exits 0 when `.goal/` is an ignored directory, so it does not reintroduce the exit-1 bug. Add a `.goal`-as-file regression test.

**F2 (minor, test gap):** committed tests cover only root `.goal` ignored/unignored; nested `pkg/.goal/**` exclusion and the `.goal`-itself path are untested. Suggest one parametrized nested case plus F1's file case.

**F3 (informational, pre-existing — not caused by this fix):** `commitKeptRunResult` still stages legacy root research files (`goal.md`, `goal.sh`, `goal.checks.sh`, `goal.ideas.md`, `goal.hooks/**`) that `isResearchStatePath` classifies as research state and that the reject-path revert script explicitly excludes — kept commits and rejected attempt patches treat them asymmetrically. Out of scope here; worth a follow-up issue.

## On "commit the fix now"

I can't do that: my task is explicitly read-only review ("do not modify or commit anything"), and I made no changes to the checkout. The reviewed one-line fix is already sitting uncommitted in the working tree and is safe to commit as-is (221 tests + tsc pass, live keep/reject verified); optionally fold in F1's one extra pathspec + test before committing.
