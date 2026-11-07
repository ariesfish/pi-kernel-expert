# Verification Record

Append-only. Every entry states what ran, where, and what it does not cover.
Hardware claims name the GPU, clock state, and versions; without those they are
written as unverified.

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
