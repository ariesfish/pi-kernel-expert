agent: d700dc255738048ad
description: Check split dependencies
type: general-purpose
model: zai/glm-5.3-flash
status: completed
exit code: unknown
started: 2026-11-11T06:24:44.111Z
cwd: /Users/ariesfish/Projects/github/dev-skills/pi-kernel-expert/.dev/worktrees/agent-d700dc255738048ad
worktree: /Users/ariesfish/Projects/github/dev-skills/pi-kernel-expert/.dev/worktrees/agent-d700dc255738048ad
---
Review complete on the final diff — **no findings; no contract violations.**

What I verified, independently of the implementer's own tests:

1. **Artifact bytes preserved.** I rendered `goal.sh`, `goal.checks.sh`, `kernel.contract.json`, and the freeze payload from the pre-split code (clean worktree at HEAD `e770065`) for the 6 fixture contracts and confirmed the captured hashes in `tests/fixtures/contract/artifacts.json` match HEAD's output exactly; the compatibility suite then proves the split code reproduces them byte-for-byte. A line-multiset diff of the moved code confirmed `contract-scripts.ts` is verbatim (0 lines altered) and the only implementation deltas in the whole move are: inline `createHash` sha → `contractSha(text)` (identical output), `globMatches` → `matchesGlob`, and the new re-export line.

2. **Glob semantics — both original call-site behaviors preserved exactly, including the corner where the two former copies differed.** `support/glob.ts` holds the shared core normalizing the *glob* only (old `contract.ts` variant); `refusals.ts` retains its 4-line wrapper normalizing the *changed path* once (old variant, so `././x` → no match, unchanged); `commandTokens` still normalizes warning tokens once, so `uncoveredHarnessWarnings` behaves identically. The new `././` regression in `tests/kernel/harness.test.mjs` pins that corner in both directions, and the stale "contract.ts has the same matcher" comment was replaced with accurate ones.

3. **No new dependency cycle.** `schemaRefusal` moved together with `readContract` into `contract-files.ts` (this was the one cycle risk: leaving it in `candidates.ts` would have created candidates → files → candidates). Final graph: model → {node, glob}; scripts → model; files → model+scripts+layout; facade → model/files/scripts; candidates → facade; refusals → facade+glob+precision.

4. **Surface parity.** All 35 pre-split exports are re-exported by the facade (checked name-by-name); `readContract`/`ContractOutcome` added; the compatibility test asserts `candidates.readContract === contract.readContract` so the three tool consumers (now on `kernel/contract.ts`) and any legacy `candidates.ts` importer share one function — consistent with ADR0006's single-reader and crash-safe-write requirements, moved verbatim.

5. **Suite**: 371/371 pass, `tsc --noEmit` clean. (One earlier full-suite run showed a single phantom failure at `refusals.test.mjs:164` that never reproduced in three subsequent runs — consistent with reading a file mid-write while the implementation was still landing, not a code defect.)
