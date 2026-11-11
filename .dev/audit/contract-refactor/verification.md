# Contract refactor verification

Baseline: `e770065`.

The contract implementation is separated into `contract-model.ts`, `contract-scripts.ts`, and `contract-files.ts`, with `contract.ts` preserving the existing interface. Contract reading now belongs to the contract module; `candidates.ts` retains its legacy exports. The harness warning and refusal paths share glob compilation, while each input reader retains its original one-time path normalization.

## Checks

| Check | Result | Evidence |
| --- | --- | --- |
| Original full suite | 347 passed, 0 failed | `baseline-tests.log` |
| Final full suite | 371 passed, 0 failed, 0 skipped | `final-tests.log`; run `npm test` |
| TypeScript | Passed | `typecheck.log`; run `npm run typecheck` |
| Generated artifact compatibility | Six fixture contracts preserve the bytes of contract JSON, both shell scripts, and freeze payload | `tests/kernel/contract-compatibility.test.mjs`, `tests/fixtures/contract/artifacts.json` |
| Baseline differential checks | 72 valid contracts, 20 invalid inputs, 21 harness warning combinations match | `equivalence.json`; run `node --experimental-strip-types .dev/audit/contract-refactor/verify-equivalence.mjs` |
| Export compatibility | All original runtime exports retained; 12 original type declarations unchanged | `verify-equivalence.mjs`; the candidate reader export aliases the canonical reader |
| Source move integrity | 51 retained contract declarations match baseline source exactly, allowing only the shared matcher call rename | TypeScript AST comparison against `git show e770065:extensions/pi-kernel-expert/kernel/contract.ts` |
| Dependencies | 38 TypeScript modules resolve local imports without cycles | Local import graph traversal |
| Package contents | All extracted modules and the shared matcher included | `npm pack --dry-run --json` |
| Diff whitespace | Passed | `git diff --check` |
| Independent dependency review | No actionable findings | `dependency-review.md` |
| Independent verification review | No blocking findings | `verification-review.md` |

Environment: Node.js `v24.21.0`, npm `11.19.0`.

The added harness tests cover `*`, `?`, `**`, directory boundaries, literal regular-expression punctuation, and single/repeated `./` prefixes. Path normalization stays at the input readers so sharing the matcher does not normalize a command token twice.

The independent verification review's optional comment suggestion is addressed by explicitly documenting one-time changed-path normalization at `harnessGlobMatches`. Audit artifacts and the local task checklist are intentionally retained for review with the working changes.

This is a maintainability refactor. No GPU performance measurement or new hardware verification was performed. No commit or release was created.
