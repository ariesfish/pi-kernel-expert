# Verification Record

Append-only. Every entry states what ran, where, and what it does not cover.
Hardware claims name the GPU, clock state, and versions; without those they are
written as unverified.

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

### How to close the hardware gap

On a machine with an sm_90 GPU, CUDA 13.2, and Nsight Compute 2026.3.1:

```bash
make gpu-smoke          # added in T-007
```

Record here: GPU name, clock state, driver, CUDA, ncu version, the report path,
and the summary JSON. Until then every profiling or speed claim stays
unverified.
