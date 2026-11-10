# Todo: feature-kernel-expert-v2 / `evidence`

**evidence** complete: T-001..T-009 closed, all live GPU evidence collected on h200-7.

## T-001 (ready-for-agent) — toolchain bootstrap on h200-7
- [x] `~/pkex/` venv (uv, python ≥3.11) + CUDA 13.0-compatible torch
- [x] `job-env-check` script resolves nvcc 13.0.88, ncu 2025.3.1, `torch.cuda`, GPU identity
- [x] output archived under `runs/T-001/`
- [x] no system-wide install, no sudo write, no GPU state change

## T-002 (ready-for-agent) — contract schema v2
- [x] `schemaVersion: 2`, `basis`, `harnessGlobs`, `referenceCommand`
- [x] v1 contract refused with "regenerate with kernel_contract"
- [x] `harnessGlobs` defaults to comparator / bench / check runner
- [x] `kernel_contract` params + `freezePayload` carry the fields
- [x] `docs/adr/0006-contract-v2-reading-provenance.md`
- [x] `npm test` + `npm run typecheck`

## T-003 (blocked: T-002) — reading block from `goal.sh`
- [x] `=== KERNEL READING ===` JSON block with basis, GPU, clocks, util, host enqueue, per-cell spread
- [x] parser → typed record; absent stays absent; no-enqueue ⇒ `unmeasured`
- [x] tests: round-trip, absent fields, `bash -n`
- [x] live run on an exclusive card archived under `runs/T-003/` (card 3, SM 345→1980, ratio 0.4600)

## T-004 (blocked: T-002, T-003) — `kernel_candidate` refusals
- [x] refuse: no basis / host-bound / harness diff / missing cell×group / stale profile
- [x] each refusal names rule + charged side + fix
- [x] five negative fixtures (authored by T-005's planner, not this implementer)
- [x] different subagent than T-003

## T-005 (blocked: T-003, T-004) — negative control
- [x] fixture task with a 2 ms host sleep inside every timed call
- [x] live run on h200-7: reproducible, correctness-green, refused by host-bound rule
- [x] archived under `runs/T-005/` with exit code and refusal text
- [x] regression test replays the archived block

## T-006 (blocked: T-003) — `referenceCommand` + ABBA pairing
- [x] 4 s burn-in, `ref, kernel, kernel, ref`, mean of two device readings per side
- [x] `pairing: mirrored|absent`; ≥2 ratios, spread ≤5% admissible
- [x] no half pair when the second reference window fails
- [x] live paired run — card 3, `pairing: mirrored`, ratios [0.9821, 1.0141], spread 3.20%, `paired_speedup 0.998` (null-pair control)

## T-007 (blocked: T-002) — input groups
- [x] `cells[].groups[]` ≥3 for non-boundary cells; `intent` required
- [x] `KERNEL_GROUP` exported; checks and bench iterate cells × groups
- [x] group failure distinguishable from shape failure
- [x] live run: correct on `typical`, wrong on `zero_block` (`runs/T-003/checks-zero-block.txt`, `max_diff=0.9999853373`)

## T-008 (blocked: T-007) — precision gate
- [x] `max_diff` from the check command; calibration records `e_ref` per dtype
- [x] refuse `e_cand > 3·e_ref + max(ul(dtype), 2^-17)`, showing both errors
- [x] missing `e_ref` ⇒ `unmeasured` ⇒ refused
- [x] live run archived under `runs/T-008/`


---

# Module `plan`

## T-010 (ready-for-agent) — milestone format + validator
- [x] `kernel/milestone.ts` parser + `kernel_milestone` tool
- [x] eight refusals, each naming row id + rule
- [x] parse → render → parse byte-identical
- [x] trigger phrase list fires; an observable trigger passes

## T-011 (closed 2026-11-10) — M0 freezes by hash
- [x] lock writes `.kernel/milestone.lock.json` (block text included, so a thaw names the item)
- [x] `m0-thawed` names the changed item; re-locking a thawed file refuses with the same diff
- [x] unlock requires a reason (≥16 chars), recorded as a Dead Ends row
- [x] runs/plan-2 evidence: lock, thaw.diff, three refusals, unlock, re-lock

## T-012 (closed 2026-11-10) — citations: measurement vs knowledge
- [x] measurement pointers (`profile:`, `cell-group:`) resolve; `gate-citation-unresolved` names pointer + path
- [x] `wiki:<id>#<confidence>` on rows only; `gate-cites-knowledge` on a gate line, `wiki-citation-misplaced` on Cost
- [x] corpus absent ⇒ row passes, report carries `knowledge-source-absent` naming kernel_bootstrap
- [x] one real page id resolved from the fetched corpus (migration-wgmma-to-tcgen05, source-reported)

## T-013 (closed 2026-11-10) — candidate names its decision
- [x] `milestoneDecision` + `milestoneSha` on the record (the field `decision` was taken by keep/reject)
- [x] `decision-unknown`, `milestone-stale`, `dead-end-bundle`, `decision-missing` (not forceable)
- [x] `precondition` accepted and recorded
- [x] benchmark.csv gains `milestone_decision`

## T-014 (blocked: T-010) — diagnosis record
- [ ] `kernel-diagnose` skill + brief
- [ ] `### Diagnosis` shape validation, never gates
- [ ] `self-diagnosis` when no `agent` tool

## T-015 (blocked: T-010) — workspace + skill
- [ ] `kernel_init` writes the milestone template
- [ ] `kernel_contract` warns when missing/empty
- [ ] kernel-flow skill: step, refusal rows, plateau move

## T-016 (blocked: T-013, T-014) — real evidence
- [ ] runs/plan-1 refused→accepted + diagnosis
- [ ] runs/plan-2 M0 thaw
- [ ] tests + typecheck green


---

# Module `corpus`

## T-017 (ready-for-agent) — entry schema + `kernel_wiki_candidate`
- [x] `kernel/wiki-entry.ts` schema, validate, render, parse
- [x] pre-fill architectures/sources from the workspace
- [x] refusals: category trigger, unverified `verified`, placeholder, taken id, reference leak
- [x] writes `.kernel/wiki-candidates/<id>.md`, never the corpus

## T-018 (blocked: T-017) — the keep records its entry
- [x] `wiki: {id} | "none" | "declined"` on the ledger row
- [x] warning (not refusal) when profile + bottleneck but no wiki field
- [x] benchmark.csv column

## T-019 (blocked: T-017, T-018) — one real promotion → one entry
- [x] entry + regenerated index diff + the four publish commands
- [x] user judgment: merge-worthy
