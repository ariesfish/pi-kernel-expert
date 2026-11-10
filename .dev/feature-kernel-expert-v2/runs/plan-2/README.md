# T-011 evidence — the M0 freeze on a real milestone file

Run 2026-11-10 on the build machine (no GPU involved: this ticket is file IO and
validation, so there is nothing hardware-dependent to claim).

| Artifact | What it is |
|---|---|
| `milestone.md` | the milestone as written: 6 frozen items under `### M0 Contract`, two decisions, four gate lines |
| `milestone.lock.json` | the freeze written by `lock: true` — both shas, the timestamp, and the block text |
| `thaw.diff` | the edit that caused the refusal: two items changed, one added |
| `milestone.after.md` | the same file after unlock + re-lock: the new M0, and the unlock's row in `## 4. Dead Ends` |
| `transcript.txt` | the ten tool calls, verbatim, in order |
| `run.mts` | the script that produced them, through the real `kernel_milestone` tool and the test host |

What the transcript shows, in the order it happened:

1. The file validates clean, and the report says there is no lock: the block may still change.
2. `lock: true` freezes the block at `1d6404233512` with the milestone sha `97078ea2ce84`.
   The lock file carries the block's own text, not only its hash — a hash says *that*
   something moved, and the author needs to know *which item*.
3. Three M0 items edited, validated: `m0-thawed` three times, each naming its item
   (`tile`, `register budget`, `vector width`), quoting the locked line beside the new
   one, and pointing at the unlock as the only way out.
4. `lock: true` on the thawed file refuses with the same three refusals. Re-locking is
   not a way to absorb an edit.
5. `unlock: true` without a reason is refused (`unlock-reason`), and the freeze stays.
6. `unlock: true` with a reason thaws the block and appends
   `- M0 | <reason> | m0-contract@1d6404233512` to `## 4. Dead Ends`.
7. The file validates again, and re-locking freezes the new block at `e582a5a80357`
   with seven items.

Two limits, recorded because they are the kind of thing this project refuses to
let pass silently:

- **The lock is a file, not a signature.** Anyone who edits `.kernel/milestone.lock.json`
  by hand can freeze a block after the fact. What the rule buys is that the edit has to be
  deliberate and visible in a diff, not that it is impossible.
- **A corrupt lock file is refused, not ignored** (`lock-unreadable`): silently treating an
  unparseable lock as "unlocked" would make deleting a byte a way to thaw the block.
