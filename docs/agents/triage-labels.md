# Triage Labels

The canonical role vocabulary. Markers live on the `todo.md` heading, or in a ticket file's `Status:` line.

| Role | Marker | Means |
|---|---|---|
| needs-triage | `(needs-triage)` | Not yet read; no decision on type or priority. |
| needs-info | `(needs-info)` | Blocked on a question only the reporter can answer. |
| ready-for-agent | `(ready-for-agent)` | Acceptance criteria are executable as written; an agent can start. |
| ready-for-human | `(ready-for-human)` | Needs a human decision, hardware access, money, or an irreversible step. |
| wontfix | `(wontfix)` | Deliberately not doing; checked off with the reason. |

Rules:

- A ticket with an unlabeled acceptance criterion is not `ready-for-agent`.
- A ticket whose acceptance needs a GPU run is `ready-for-human` until a machine exists.
- Moving to `wontfix` requires one line of reason in `plan.md`.
