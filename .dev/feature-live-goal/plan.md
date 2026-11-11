# Live pi-goal integration

Objective: exercise the installed pi-goal extension with pi-kernel-expert through pi's real extension runtime, using one isolated task repository and an explicitly selected H200.

| Ticket | Scope | Dependency | Acceptance |
| --- | --- | --- | --- |
| T-028 | Runtime driver and isolated task | None | Both extensions load through pi's resource loader; nested tool calls pass schema validation and extension hooks. |
| T-029 | Same-kernel GPU checks and measurement | T-028 | Three input groups, reference calibration, GPU identity/clocks, and raw output are recorded on builder card 3. |
| T-030 | Frozen-contract loop and rollback | T-029 | One human-approved contract, baseline, measured candidate, keep or rejection, and a failing candidate with archived patch and restored checkpoint. |

- [x] Build and exercise the runtime driver.
- [x] Generate and review the concrete Task Contract.
- [x] Obtain pi-goal's required one-time freeze confirmation.
- [x] Run the baseline and candidate cycles; record every run.
- [x] Archive journal, ledger, metrics, hardware details, and limitations in docs/verify.md.

T-028..T-030 complete: the repaired keep landed in the temporary task repository, the incorrect candidate was rejected and reverted with its patch preserved, and restored checks passed. Evidence: `.dev/audit/live-goal/README.md`.

Separate follow-up: failed Git settlement must not append a keep Run Result or allow the next iteration. The original failed-settlement entries remain archived; they are not counted as committed keeps.

No GPU clock changes or global installs. All automatic commits and resets happen in a new temporary git repository. The GPU task uses new files in a dedicated remote directory.

Live execution exposed a peer bug: `commitKeptRunResult` fails to stage when `.goal/` is ignored because of its explicit directory exclusion. The fix and real-git regressions live in the local pi-goal checkout, rather than being copied into this package. The original no-peer-edit plan was revised for this reproduced blocker; no pi-goal version or published package was changed.
