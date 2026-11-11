agent: dfb36b11c52a14917
description: Review installer standards
type: general-purpose
model: zai/glm-5.3-flash
status: completed
exit code: unknown
started: 2026-11-11T10:17:38.463Z
cwd: /Users/ariesfish/Projects/github/dev-skills/pi-kernel-expert/.dev/worktrees/agent-dfb36b11c52a14917
worktree: /Users/ariesfish/Projects/github/dev-skills/pi-kernel-expert/.dev/worktrees/agent-dfb36b11c52a14917
---
Review complete (read-only). Files: AGENTS.md, ADR 0001, script, test, and both diffs.

**Boundary compliance — clean.** ADR 0001 holds: pi-goal is installed as a peer, nothing forked, no phase machine/journal/gate in this package. `package.json` diff adds only `scripts/install-git.sh` to `files`; no dependency, version, or API change, so CHANGELOG hygiene isn't triggered. README correctly avoids GPU/speedup claims per evidence rules.

**Tests — meaningful.** Order (peer first), fail-fast at each install step with exit-code propagation (asserts 23 and no later calls), missing-tool refusal for both packages, and — notably — pi exiting 0 without the marker not being reported as success. Gaps are trivial only: the usage guard (`exit 2`) is untested; acceptable.

**Temp handling — safe.** `mktemp -d` + quoted `rm -rf --` on an EXIT trap, heredoc quoted, verify isolated in the temp cwd. No findings.

**Findings (2):**

1. **Scope inconsistency between install and verify steps (doc truthfulness risk).** Installs run from the caller's cwd; verification runs from a temp cwd. README claims "separate global pi packages" and that rerunning "reconciles" sources — both depend on `pi install` being user-scoped by default and a Git install superseding any prior npm install. If pi supports project-local installs (or a project config is present), installs could land locally while the temp-cwd verify sees nothing, failing despite success. Confirm pi's scoping semantics, or run the installs in the same isolated cwd / pass an explicit scope flag, and soften "reconcile" if unverified.

2. **Minor:** the hardcoded 20-tool list in `verify.mjs` duplicates the compatibility pin. Breaking on upstream rename is intended fail-fast per ADR 0001, but consider a comment pointing at the compatibility test so the two don't drift.

No other findings.
