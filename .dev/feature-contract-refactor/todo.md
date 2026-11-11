# Contract refactor

User request: refactor and improve the current code. Keep this pass focused on contract processing and harness protection.

- [x] Inspect the domain context, ADRs, contract callers, and current tests.
- [x] Establish the baseline: 347 tests and TypeScript checks pass.
- [x] Capture six artifact fixtures from e770065 and verify them before changes.
- [x] Separate contract modeling, script generation, and artifact I/O behind the existing interface.
- [x] Move contract reading out of candidate recording while retaining legacy exports.
- [x] Share harness glob matching between warnings and refusals; test path semantics.
- [x] Run artifact compatibility, full tests, typecheck, dependency checks, and diff review.

Acceptance: preserve existing exports, tool parameters, diagnostics, policy thresholds, generated artifact bytes, and file write order. No GPU performance claim is part of this work.

Completed: 371 tests pass, typecheck passes, and both independent reviewers report no blocking findings. Evidence: `.dev/audit/contract-refactor/verification.md`.
