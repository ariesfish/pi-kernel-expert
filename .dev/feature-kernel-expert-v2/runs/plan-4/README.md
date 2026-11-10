# T-016 — one workspace, every plan behaviour, through the real tools

Run 2026-11-10 on the build machine. No GPU: the counters in `profile/` are built
by `buildProfileSummary` from fixture numbers, and the ticket is about the plan's
machinery, not about a measured speedup. Everything else is real: git, generated
`goal.sh`, the contract's own hashes, the tools' own refusals.

| Artifact | What it is |
|---|---|
| `workspace.txt` | steps 1–12: init → contract → plan → lock → refusals → thaw → ledger |
| `diagnosis.txt` | steps 12–13: the reviewer's block validated by `kernel_milestone` |
| `run-workspace.mts` | the script, `build` then `diagnose` |
| `reviewer.md` | the block the reviewer returned, in the five-line shape the brief asks for |

One workspace, `.work/`, and the whole module walks through it:

1. **`kernel_init`** creates the milestone template, and **`kernel_contract`**
   warns that it is still a template while freezing anyway. The contract takes
   `scope_globs: ["kernel/**"]`, so editing the plan later does not invalidate a
   profile — a plan edit is what the loop learns, not what the candidate changed.
2. **The plan is written against a profile that exists.** `profile:run1` in a
   gate line is refused until `profile/run1/summary.json` is on disk, so the
   order is: write, profile, validate.
3. **`lock: true` freezes M0** at `e65a5f291af5`.
4. **`decision-unknown`** refuses a keep naming `D3.7`, and names the ids the
   plan has (`D0.1, D0.2`) — nothing is recorded.
5. **`D0.3` lands**, the milestone validates, and **the same keep is recorded**
   (`C1 keep D0.3 profile=run1`), with the milestone sha it checked.
6. **`m0-thawed`** refuses the warp-roles edit, quoting the locked line beside
   the new one; **`unlock: true` with a reason** appends
   `- M0 | D0.3 splits the writeback ... | m0-contract@e65a5f291af5` to Dead Ends
   and **re-locking** freezes the new block at `976d17b9d863`.
7. **Three rejects on `D0.3`**, each against its own diff and its own profile
   (`run2`, `run3`, `run4`) — the plateau is three attempts that did measure.
8. **The reviewer** (`opus`, readonly, artifacts only) returned
   `measurement-defect` on `D0.3`, and **the block validates clean**: five lines,
   three-plus citations, every one opened by the tool.

Two things this run changed, and both were found by running it:

- **The first version profiled before the change.** All three profile summaries
  carried one `diffHash` that was no candidate's, and the reviewer said so:
  "run1/run2/run4 are one build that is no candidate's". That is the
  `profile-stale` rule working on me; the script now hashes each candidate's tree
  and profiles that.
- **A diagnosis block sat under `## 4. Dead Ends` and counted as a dead end.**
  Five rows of diagnosis inflated the count and could have banned a decision
  bundle through `dead-end-bundle`. The parser now skips diagnosis ranges.

The reviewer's verdict is worth reading twice, because it is about the plan and
not about code: the gate's own metric (epilogue share) appears in no collected
run, the trigger D0.3 was written against (local ld/st sectors) was never
recorded, and the dead end that forecloses `D0.2` cites a register count `run2`
does not contain. A loop can run three careful experiments under decision `D0.3`
and still never measure the number its gate is waiting for.
