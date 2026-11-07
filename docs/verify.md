# Verification Record

Append-only. Every entry states what ran, where, and what it does not cover.
Hardware claims name the GPU, clock state, and versions; without those they are
written as unverified.

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
