# T-032: Joint Git installer

User-approved scope: add one installation entry point that installs pi-goal before pi-kernel-expert, stops on failure, and verifies both packages' required tools in a fresh pi process. Keep pi-goal as an independently installed peer.

- [x] Inspect the package manager, CLI, extension API, and current package layout.
- [x] Add executable behavior tests for ordered installation and failure handling.
- [x] Add the installer and document its use, including the separate wiki bootstrap.
- [x] Run the installer against the real Git installations and verify registered tools without a model request.
- [x] Run the repository suite, typecheck, package-content check, and review the diff.
- [x] Commit the completed increment and leave the workspace clean.

Verification:

- `node --experimental-strip-types --test tests/scripts/install-git.test.mjs`: 6 passed. The initial missing-installer failure is retained in `red.txt`.
- `npm test`: 378 passed, 0 failed, 0 skipped.
- `npm run typecheck`: passed.
- `bash -n scripts/install-git.sh`: passed.
- `npm pack --dry-run --json`: includes executable `scripts/install-git.sh` (83 files total).
- Real execution: `bash scripts/install-git.sh` installed both configured Git sources and printed `PI_KERNEL_STACK_READY`. See `live.txt`. On this host, invocation-scoped Git URL rewriting selected SSH for GitHub; no persistent Git settings were changed.
- Fresh installation: a separate empty `PI_CODING_AGENT_DIR` installed both Git checkouts and their production dependencies and printed the same readiness marker. See `fresh-install.txt`. Git source URLs were temporarily mapped to the existing local checkouts for this isolated test; the regular GitHub installation path was covered by the live execution above.
- The temporary verifier uses a fresh cwd, loads configured global extensions, inspects the real tool registry via a slash command, and exits without a model request. Both installed checkouts remained clean.

The installer intentionally keeps wiki acquisition separate: `kernel_bootstrap` fetches the pinned corpus when needed, and existing sessions use `/reload` after installation or a new corpus fetch.

Review: the correctness reviewer found no actionable defects. The standards review's scope concern was checked against pi 1.5.2's `docs/cli.md`: `pi install` uses global settings unless `--local`/`-l` is supplied; the installer supplies neither. Its rerun claim is limited to the same Git sources, not replacement of separately configured npm packages. Both the existing-install and isolated fresh-install runs passed. The hardcoded tool list is an intentional compatibility check, independently checked against current extension registrations.
