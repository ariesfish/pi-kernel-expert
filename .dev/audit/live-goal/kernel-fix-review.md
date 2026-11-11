agent: d76cf25d266864c64
description: Review kernel integration fix
type: general-purpose
model: zai/glm-5.3-flash
status: completed
exit code: unknown
started: 2026-11-11T08:48:13.087Z
cwd: /Users/ariesfish/Projects/github/dev-skills/pi-kernel-expert/.dev/worktrees/agent-d76cf25d266864c64
worktree: /Users/ariesfish/Projects/github/dev-skills/pi-kernel-expert/.dev/worktrees/agent-d76cf25d266864c64
---
**Verdict: the timeout fix and its tests are correct — safe to commit.** Findings below, all minor/informational.

## Fix correctness — verified against the real receiver
- Root cause confirmed in the installed peer: `~/.pi/agent/git/github.com/ariesfish/pi-goal/extensions/pi-goal/workflows/goal-contract-workflow.ts` — `criterionFrom` maps **only** `input.check.timeout_seconds` → internal `timeoutSeconds`; TypeBox `CriterionSchema` (`extensions/pi-goal/support/schema.ts:131-140`) declares only `timeout_seconds` and permits extra keys, so the old `timeoutSeconds` spelling validated, was silently dropped, and `execution/gate-runner.ts:193` fell back to 300 s. The rename in `extensions/pi-kernel-expert/kernel/contract-files.ts:63,100` is the correct and complete fix.
- No other consumer missed: repo-wide grep of `FreezeCriterion`/`timeoutSeconds` shows only `contract-files.ts` (fixed), the two updated tests, and the barrel re-export. `extensions/pi-kernel-expert/tools/contract.ts` never prints the check timeout; `readContract` doesn't read `kernel-freeze.json`; `skills/kernel-flow/SKILL.md`/`README.md` reference the file by name only. `contract.checksTimeoutSeconds` is always defaulted (900) by `normalizeContract`, so `timeout_seconds` is always emitted.
- AGENTS/ADR: no violations — `docs/adr/0006` lists freeze-payload fields without pinning the check spelling; `package.json`/`CHANGELOG.md` untouched so release hygiene isn't triggered; the peer edit lives in the pi-goal checkout as `plan.md` documents.

## Tests
- `tests/kernel/freeze-compatibility.test.mjs` correctly asserts the receiver-facing spelling (`timeout_seconds === 17`, `timeoutSeconds === undefined`). Green.
- `tests/kernel/contract-compatibility.test.mjs` normalization is scoped exactly to `check.timeout_seconds`→`timeoutSeconds`, key order survives JSON round-trip, so all 6 golden freeze digests are honestly preserved — the historical hashes are not weakened in substance.
- Two notes:
  1. **Slight weakening**: the on-disk freeze check (`contract-compatibility.test.mjs:71-72`) now goes through `JSON.parse`→restringify, so byte-formatting (indentation/whitespace) of the written `kernel-freeze.json` is no longer pinned — only content + key order. Semantic content is still hash-checked against the golden; acceptable, but the writer's exact bytes are now unverified by this test.
  2. The proof against the *real* receiver conversion lives only in `.dev/feature-live-goal/verify-timeout.mjs` (executes installed pi-goal's `executeFreezeCriteria`, asserts 17 survives) — that's under gitignored `.dev/`, so the committed suite asserts payload shape only. Fine for this repo's boundary (receiver behavior is the peer's to own), just be aware the durable regression is one-sided.

## Informational (no action needed for this commit)
The sealed live contract predates the fix: the approved artifact (`.dev/audit/live-goal/kernel-freeze.json`, sha `e60d3560…` matching `state.json`/`human-approval.json`) still carries `timeoutSeconds: 180`, and the frozen journal entry shows `"check":{"command":"bash goal.checks.sh","expect":"exit0"}` with no timeout → gate default 300 s. Harmless here (300 > 180) and the live loop has since passed all gates, but any future contract with timeout > 300 s must be regenerated post-fix and re-approved (new sha) to actually benefit.

Commit the refactor as-is.
