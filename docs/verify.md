# Verification Record

Append-only. Every entry states what ran, where, and what it does not cover.
Hardware claims name the GPU, clock state, and versions; without those they are
written as unverified.

Paths under `.dev/` and `runs/` belong to the machine that ran the check: the
ticket workspace is gitignored, and a run archive is a work product, not a
package file. A clean checkout records the result; the artifacts stay where the
run happened.

## 2026-11-07 — evidence + skill layer (0.4.0)

Host: same dev box. No GPU, no ncu, no `ncu_report`, no pi-goal install.

| Check | Command | Result |
|---|---|---|
| Unit + integration | `npm test` | 100 pass, 0 fail |
| Summary parsing | fixture `metrics_key_full.json` | only numeric metrics kept; two absent metrics listed, not zeroed |
| Rules ranking | fixture `rules_full.txt` | sorted by estimated speedup; a rule without one sorts last |
| Stall attribution | fixture `stall_hotspots_full.txt` | kernel-line table preferred over inlined frames; totalLines and top rows parsed |
| Summary writing | `buildProfileSummary` | `summary.json` carries contract hash, diff hash, GPU, clocks, ncu version, warnings |
| Missing analysis | no `metrics_key` | refuses with the exact missing path, no invented metrics |
| Attach mode | `reuse_analysis: true` + fake report | summary written; second run on the same dir refused |
| Collect without ncu | fake exec `spawn ncu ENOENT` | names the missing dependency and the attach path |
| Helper without ncu_report | fake exec | error names `ncu_report` and PYTHONPATH |
| Diff fingerprint | real git fixture | tracked edits, untracked content, and scope globs change it; `profile/`, `.kernel/`, `candidates.jsonl` do not |
| Candidate gate | real git + contract + profile fixtures | keep ok; noise floor, missing cell, stale profile, foreign contract, absent bottleneck metric, missing reason, path traversal each refused |
| Ledger lineage | two records | `C1`/`baseline`, `C2`/`C1`, one JSON line each |
| Derived CSV | two records | `benchmark.csv` header includes every metric column; free text quoted; empty ledger refused |
| Skill tool names | `tests/skills/kernel-flow.test.mjs` | every named tool exists in this package or pi-goal's documented set |

### Not covered

- A real `.ncu-rep` was never parsed: no GPU, no `ncu`, no `ncu_report`. The
  parser is exercised against helper-format fixtures only; the collection path is
  unit-tested for its failure modes.
- `kernel_candidate` never ran against a live pi-goal journal: pi-goal is not
  installed here. Ordering (profile → record → `log_goal`) follows its
  documented behavior, unverified end to end (T-008).
- Skill routing was linted (description triggers, exclusions), not evaluated
  against a model. A mutating trigger regression is a later `eval` concern.

## 2026-11-07 — contract layer (0.3.0)

Host: same dev box, bash 5.x, Node 26.5.0. No GPU, no ncu, no pi-goal install.

| Check | Command | Result |
|---|---|---|
| Unit + integration | `npm test` | 66 pass, 0 fail |
| Draft/plan gate | generated templates | every section flagged as a placeholder; a filled draft passes; a missing or empty section is named |
| Baseline run | `bash goal.sh` on a two-cell fixture | exit 0; `METRIC latency_us_a=10`, `latency_us_b=20`, `geomean_speedup=1`; `.kernel/baseline.tsv` written |
| Improvement | 2× faster fixture | exit 0; `geomean_speedup=2` |
| Regression guard | one cell 2× slower | exit 1; `guard: cell b regressed` |
| Contract integrity | one byte appended to `kernel.contract.json` | both scripts exit 2 with the expected/actual hash |
| Matrix env | cell vars `M=7,N=6` | benchmark saw `KERNEL_M`/`KERNEL_N` and printed 42 |
| Two-pass checks | failing cell | exit 1, `FAIL cell b (boundary cell) pass 1` |
| Flaky check | fails only on second call | exit 1, `FAIL cell a pass 2` |

### Not covered

- The generated criteria were not handed to a live `pi-goal` gate: pi-goal is
  not installed in this environment (status reports `not installed`). The
  payload shape follows its documented criterion schema; an end-to-end gate run
  is T-008.
- `kernel_init` detected "not a git repository" via a stubbed host in the tool
  test; the real git path is exercised only by the fixture scripts.

## 2026-11-07 — knowledge layer (0.2.0)

Host: same dev box, Node 26.5.0, python3 3.14.6, **no PyYAML installed**.

| Check | Command | Result |
|---|---|---|
| Real fetch | `kernel_bootstrap` against `github.com/mit-han-lab/KernelWiki` | installed in 5.7 s at `b6b4301f15e8…`, `rev-parse HEAD` matches, 1589 files |
| Sanitization | fetch + `grep -rl LicenseRef-NvidiaProprietary` | 19 files pruned under `artifacts/`; 0 remain; paths in `SANITIZED.yaml` |
| Refusal paths | unit tests with a local git fixture | wrong pin, wrong existing revision, missing SKILL.md, malformed pin, clone failure each refuse and leave no temp dir |
| Idempotence | second `kernel_bootstrap` | `already`, 0.1 s, no re-clone; a reintroduced restricted file is pruned and appended to the record |
| Query without PyYAML | `python3 scripts/query.py "fuse gate-up dual GEMM on Blackwell" --compact` | 10 results with page ids and paths, exit 0 |
| Page fetch | `python3 scripts/get_page.py kernel-flash-attention-4 --body-only` | FlashAttention-4 body printed, exit 0 |
| Corpus status | `python3 scripts/repo_status.py` | 1041 indexed pages / 944 PR pages / 52 wiki pages |
| Pin discovery | old pin `76d27b5` queried | `ModuleNotFoundError: No module named 'yaml'` — it predates the bundled fallback; pin changed, old cache removed |

### Not covered

- Registration through `resources_discover` was exercised in unit tests
  (plan + conflict scan), not in a live TUI; `/reload` behavior on this host is
  unverified.
- The fetched `SKILL.md` name is not Agent Skills compliant; pi's loader warns
  and still loads it (inspected in `dist/core/skills.js`), unverified live.

## 2026-11-07 — scaffold (0.1.0)

Host: Linux dev box, Node 26.5.0, npm 11.x.
Hardware: **no GPU, no `ncu`, no `nvcc`** (`nvidia-smi`, `ncu`, `nvcc` all absent).

| Check | Command | Result |
|---|---|---|
| Typecheck | `npx tsc --noEmit` | pass, no diagnostics |
| Unit + integration tests | `npm test` | 18 pass, 0 fail |
| Package loads in pi | `pi -e . --no-tools --mode json -p "/kernel-expert"` | session started, no extension error events, exit 0 |
| Tarball contents | `npm pack --dry-run` | 41 files, 113.1 kB packed / 329.5 kB unpacked; no `.dev`, no `node_modules`, no corpus |
| Vendored skill provenance | `tests/skills/frontmatter.test.mjs` | `c7980a43cb88…` parsed from `VENDORED.yaml`; every skill frontmatter valid and uniquely named; the upstream reference set is present |
| KernelWiki pin | `paths.test.mjs` | `76d27b56f804…` present in cache path |

### Not covered

- Any ncu collection or report parse: `ncu` and `ncu_report` are absent, and no
  `.ncu-rep` fixture exists yet. The parser path is unexercised (T-005).
- Any kernel compile or run: no `nvcc`, no GPU (T-007).
- The KernelWiki fetch: not implemented yet (T-003).
- Interactive `/kernel-expert` rendering: the command ran in print mode where
  `ui.notify` has no output surface; command registration is covered by unit
  test only.

### How to close the remaining hardware gap

The sm_90 gap named here was closed on 2026-11-09 (entry above): a real reading block, real clocks,
real `max_diff`, a failing input group, and a host-bound refusal on h200-7, CUDA 13.0.88, driver
580.178.04. What is still unverified is narrower:

- **Blackwell (sm_100/sm_120)** — no compile, no run, no clock reading.
- **Profile evidence** — no `ncu` collection on this node, so no `.ncu-rep`, no parsed metrics, no
  written `summary.json`. The collection and report paths stay fixture-tested until a profiled run
  is recorded here with GPU name, clock state, driver, CUDA, ncu version, report path and summary JSON.
- **Clock-locked runs** — `nvidia-smi -lgc` has not been used, and the producer has no `clockLocked`
  field yet, so a locked reading could not be recorded even when the operator takes one.

Until those are recorded, no profiling claim and no Blackwell claim is verified.

## 2026-11-09 — a reading block from a real sm_90 node (T-003, T-005, T-007)

Host **h200-7** (`ssh builder`): 8x NVIDIA H200 139.8 GiB, sm_90, **cards idle for this work**.
Driver 580.178.04, CUDA 13.0.88 (`nvcc` `/usr/local/cuda-13.0/bin/nvcc`), Nsight Compute 2025.3.1,
torch 2.14.1+cu130 in `/root/pkex/venv` (installed; the fixture does not use it).
One card per run, claimed with `CUDA_VISIBLE_DEVICES=3`; clocks unlocked (no `nvidia-smi -lgc`).
Fixture: `.dev/feature-kernel-expert-v2/fixtures/saxpy/`; archive:
`runs/T-003/` and `runs/T-005/` with per-artifact READMEs.

| Check | Command | Result |
|---|---|---|
| Honest reading, run 1 then run 2 | `CUDA_VISIBLE_DEVICES=3 bash goal.sh` on card 3 | exit 0; block `basis: device`, `basisSource: task-reported`, GPU `NVIDIA H200` index 3 visible `"3"`, SM clocks 345 → 1980 MHz, mem 3201 MHz, foreign 0 MiB at both samples, `hostEnqueueMs 0.002059`, `deviceMs 0.004476`, `hostBoundRatio 0.4600`, `hostBoundVerdict ok`, 3 groups x 5 samples (spread 2.6 / 4.0 / 2.8 %), `pairing absent` |
| METRIC provenance | same run | `METRIC latency_us_saxpy_typical=4.473`, `…_zero_block=4.561`, `…_tail=4.476`, `latency_us_saxpy=4.503149335`, `geomean_speedup=0.9997405793` — the block's device/enqueue figures are these lines, not shell time |
| Parser round-trip | `parseReadingBlock` over the archived stdout | ok: 3 cells, samples 5, `hostBoundVerdict` agrees with `verdictForRatio(0.4600)` |
| Refusal set on the honest reading | `collectRefusals` with the archived contract, no diff | 0 refusals |
| Group that fails | `CUDA_VISIBLE_DEVICES=3 bash goal.checks.sh` | exit 1: `FAIL cell saxpy group zero_block pass 1`, `max_diff=0.9999853373`; `typical` and `tail` exit 0 at `max_diff=1.192092896e-07`. The same data with the reference kernel (`--impl plain`) is exact, so the failure is the candidate's zero-input fast path, not the data |
| Host-bound control | same contract, `benchmarkCommand` `bench --n 1048576 --sleep-ms 2` | exit 0; `hostEnqueueMs 2.092463`, `deviceMs 2.089599`, **`hostBoundRatio 1.0014`**, **`hostBoundVerdict host_bound`**; replayed through `collectRefusals` → 1 refusal, `host-bound (charged to the candidate)` with the four host causes and the fix |
| Second broken enqueue path | `bench_bad.py` (ctypes launch, 2 ms sleep per call, wall clock as device time) | `hostBoundRatio 1.0012`, `host_bound` — same verdict through a real Python wrapper |
| Real `max_diff` on fp32 | `verify --n 1048576` (grid 4096 x 256, N+37 for `tail`) | `1.192092896e-07` against a double CPU reference; no NaN, no zero |

### Not covered

- **Blackwell is unverified.** Every number above is sm_90. No sm_100/sm_120 compile or run happened.
- No clock lock: `nvidia-smi -lgc` was not used, and the block has no `clockLocked` field to record a
  lock even if one had been (the spec asks for it; `reading.ts` does not emit it). Every reading here
  is unlocked, and carries both its start and end clocks.
- No `referenceCommand`: `pairing` is `absent` in every reading here; same-job ABBA pairing (T-006)
  and ABBA spread are unexercised on hardware.
- The refusal text above comes from calling the refusal rules directly. `kernel_candidate` itself was
  not invoked inside a live pi-goal journal (pi-goal is not installed on this host).
- No `ncu` collection: the fixture benchmarks with CUDA events, so no `.ncu-rep` and no summary JSON
  were produced. The report parser is still exercised only against fixtures.

## 2026-11-09 — clock lock and the loaded sample (T-009)

Same node and card as above (h200-7, card 3, driver 580.178.04, CUDA 13.0.88). Clocks were locked
with `nvidia-smi -i 3 -lgc 1500` for one run and reset with `-rgc` immediately after; the archive is
`runs/T-009/`.

| Check | Result |
|---|---|
| Locked run | `clockLocked {declaredSmMhz 1500, declaredMemMhz 3201, observedSmMhz 1500, held: true}`; `gpu.loaded {clocksSmMhz 1500, clocksMaxSmMhz 1980, utilPct 2}`; `hostEnqueueSamples 15`, `deviceSamples 15` |
| Same contract, unlocked | `observedSmMhz 1980`, `held: false`, warning naming both frequencies |
| Not detectable | `nvidia-smi` has no "lock in force" field; an undeclared lock is invisible, so the field is absent rather than `held: false` |

## 2026-11-10 — Node query layer and pi-schema tool schemas

Host: same dev box, Node 24.21.0; no GPU, no ncu, no pi-goal install.

| Check | Command | Result |
|---|---|---|
| Typecheck | `npm run typecheck` | pass |
| Unit + integration | `npm test` | 347 pass, 0 fail |
| Schema shape | `tests/tools/schemas.test.mjs` | every registered tool compiles as plain JSON Schema; no TypeBox `~kind`/`~unsafe` marker; an undeclared argument field is rejected |
| Corpus fetch at pin | `fetchPinnedCorpus` with `remote` = local kernel-wiki clone, `pin` = `70530df1cd08` | installed, checkout revision equals the pin |
| Query at pin | `node scripts/query.mjs --tag nvfp4 --type kernel --compact` in the fetched tree | 4 results, including `kernel-nvfp4-gemm` |
| Page fetch at pin | `node scripts/get_page.mjs kernel-flash-attention-4 --frontmatter-only` | `id: kernel-flash-attention-4`, exit 0 |

### Not covered

- The pin commit exists only in the local kernel-wiki clone. Fetching it from
  `github.com/ariesfish/kernel-wiki` was not run and will fail until that
  repository is pushed.
- Tool arguments were compiled and validated with `@earendil-works/pi-schema`
  in tests, but not exercised through a live pi session's tool loop.

## 2026-11-10 — Published JavaScript corpus pin

Host: Node 24.21.0 on the dev box. Corpus revision:
`486ea701bbd1c88cb9bb3369ecdb7af50c91fc16`, published to kernel-wiki's
`origin/master` before this pin update.

| Check | Method | Result |
|---|---|---|
| Consumer regression suite | `npm test` | 347 passed, zero failures or skips |
| TypeScript diagnostics | IDE diagnostics for the workspace and edited extension modules | no diagnostics |
| Remote visibility | `git ls-remote` over HTTPS and SSH | both return the exact pinned revision |
| Remote fetch | `fetchPinnedCorpus` using GitHub SSH and a temporary agent cache | installed the exact pin, zero warnings |
| Registered query tool | `kernel_wiki` with `query: nvfp4`, `type: kernel`, `compact: true` | five results including `kernel-nvfp4-gemm`, exit 0 |
| Registered page tool | `kernel_wiki` with `page: kernel-flash-attention-4` | requested page returned, exit 0 |
| Cache reuse | repeat `fetchPinnedCorpus` at the same target | `already`; revision still matches |
| Runtime installation | inspect the fetched corpus | no `node_modules` installation |

The new corpus uses JSON machine data and Node.js maintenance commands.
Candidate publication guidance uses `node scripts/generate-indices.mjs`.
Replay evidence is under `.dev/audit/wiki-pin-update/`.

### Limits

- The default HTTPS remote was visible, but full clones timed out at 45 and
  90 seconds on this host. The successful full fetch used
  `git@github.com:ariesfish/kernel-wiki.git`; this run does not certify the
  default HTTPS clone path.
- Registered tools ran through the test host backed by real child processes,
  not an interactive pi session. No GPU, compiler, ncu, or upstream evidence
  recapture is claimed by this pin verification.
