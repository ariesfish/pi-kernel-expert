# T-013 evidence — a candidate names its decision

Run 2026-11-10 on the build machine. No GPU: this ticket binds a record to a
plan, and every number here is a fixture reading that the existing gates already
accept (the point is the attribution, not the speedup).

| Artifact | What it is |
|---|---|
| `binding.txt` | the eight steps, verbatim: the degradation, two refusals, three records |
| `run-binding.mts` | the script — a real git repo, a real contract, a real `docs/milestone.md` |

What the run establishes:

1. **No plan is a declared degradation, not a refusal.** C1 is recorded, and the
   report says the candidate names no decision. A workspace that never wrote a
   plan still gets lineage; it does not get attribution it never had.
2. **`decision-unknown` names the id and the ids the plan does have.** `D3.7`
   against a plan holding `D0.1, D0.2` is refused and nothing is written.
3. **The same keep with `D0.1` is recorded**, with the milestone sha it checked
   (`2b57f5376257`).
4. **`dead-end-bundle` bans the combination, not its members.** `D0.1+D0.2` is
   refused because `## 4. Dead Ends` recorded the pair spilling 190 registers;
   the refusal quotes that row and asks for a precondition.
5. **The same pair with a precondition is recorded**, and the precondition is
   kept beside the bundle in the ledger.
6. **The CSV carries `milestone_decision`**, empty for the unattributed C1 and
   canonical (`D0.1+D0.2`, sorted, deduped) for the bundle.

The rule the ledger now enforces, in one line: a keep is a claim that this
change implements a decision the plan already made, and a claim nobody can look
up is not a record.
