# pi-kernel-expert

*CUDA kernel optimization for pi: the KDA flow on pi-goal's frozen-contract loop, with KernelWiki knowledge and Nsight Compute evidence.*

Status: **0.3.0 — contract wired.** The package loads, ships the vendored ncu profiling skill, fetches and sanitizes the KernelWiki corpus, and freezes a kernel task into executable criteria. The evidence layer and workflow skill are the next tickets (see `.dev/feature-pi-kernel-expert/plan.md`).

## Why this exists

Three good sources describe how to optimize GPU kernels, and none of them can stop an agent from promoting a kernel because the story sounds right:

- **KDA** (NVlabs) describes the flow — task contract, plan draft, one candidate at a time, validate, measure, promote or record the rejection.
- **KernelWiki** (mit-han-lab) holds the Blackwell/Hopper knowledge.
- **ncu-report-skill** (mit-han-lab) holds the profiling procedure.

`pi-goal` already provides the part that must not be re-litigated in prose: a frozen contract with a hash, a deterministic gate, an append-only journal, and a reverted attempt kept as evidence.

This package connects them. Kernel rules ride in data pi-goal already accepts — generated `goal.sh` lines, generated `goal.checks.sh` scripts, and structured `asi` payloads. **pi-goal is used unmodified.**

## Requirements

| Piece | Version | Needed for |
|---|---|---|
| pi | >= 1.5.0 (`resources_discover`, `agent_before_settle`) | everything |
| `@ariesfish/pi-goal` | >= 0.5.3 | the loop, contract, gate |
| python3 | >= 3.11 | ncu helpers and KernelWiki queries (no PyYAML needed) |
| CUDA toolkit + Nsight Compute | 13.2 + 2026.3.1 documented target | profiling |
| NVIDIA GPU | sm_90 verified in v1 | measuring anything |

Install the loop engine separately — pi does not hydrate peer packages:

```bash
pi install npm:@ariesfish/pi-goal
pi install npm:@ariesfish/pi-kernel-expert
```

## Start here

```text
/kernel-expert            # what is wired
```

Not cached yet? Ask the agent to run `kernel_bootstrap`, then `/reload`. It
clones the recorded KernelWiki revision, verifies it, removes the 19 files
marked `LicenseRef-NvidiaProprietary`, and writes `SANITIZED.yaml` next to the
corpus. A tree at another revision is refused, never overwritten.

Then query it:

```text
kernel_wiki({ query: "fuse gate-up dual GEMM on Blackwell" })
kernel_wiki({ page: "kernel-flash-attention-4", follow_sources: true })
```

## Freeze a kernel contract

```text
kernel_init({})                       # workspace + draft/plan templates
# fill docs/draft.md and docs/plan.md — the generator refuses placeholders
kernel_contract({
  objective: "cut attention decode latency",
  check_command: "python check.py --cell $KERNEL_CELL",
  benchmark_command: "python bench.py --cell $KERNEL_CELL",
  cells: [
    { id: "s1024", dtype: "bf16", vars: { SEQ: "1024" } },
    { id: "s8192", dtype: "bf16", vars: { SEQ: "8192" }, boundary: true },
  ],
  rtol: 1e-2, atol: 1e-3,
})
```

It writes `goal.sh`, `goal.checks.sh`, `kernel.contract.json`, and
`kernel-freeze.json`. The commands get `KERNEL_CELL`, `KERNEL_DTYPE`,
`KERNEL_RTOL`, `KERNEL_ATOL`, the cell's vars, and `KERNEL_BOUNDARY`; the check
command exits non-zero on a mismatch, the benchmark prints one number.

- First `bash goal.sh` records `.kernel/baseline.tsv` and reports
  `METRIC geomean_speedup=1`.
- Later runs report `METRIC <metric>_<cell>=<median>` per cell and a geomean;
  a cell that regresses beyond `guard_pct` fails the run.
- `bash goal.checks.sh` runs every cell twice — a first-pass-only success is
  reported as pass 2.
- Both scripts verify the contract hash and refuse to run after a hand edit.
- Pass `kernel-freeze.json` to `freeze_criteria`; use `geomean_speedup` /
  `higher` for the experiment.

## Check what is wired

```text
/kernel-expert
```

```text
pi-kernel-expert 0.2.0
  loop engine   pi-goal installed
  ncu skill     vendored @c7980a43cb88 at .../skills/ncu-report-skill
  KernelWiki    cached at ~/.pi/agent/kernel-expert/cache/KernelWiki@b6b4301f15e8
```

The ncu skill is vendored and works offline. KernelWiki is fetched at a recorded revision, never bundled: it is ~37 MB, its artifacts carry upstream terms, and the restricted files are pruned at fetch time rather than trusted to be absent.

## What runs where

No GPU, ncu, or nvcc exists on the build machine, so nothing hardware-dependent is claimed as verified. `docs/verify.md` records exactly what ran, on what, and what is deferred. The GPU smoke target is written first and executed when a machine exists.

## Layout

```text
extensions/pi-kernel-expert/   composition root, status, bootstrap + wiki + init + contract tools
  knowledge/                   fetch, sanitize, conflict scan, registration plan
  kernel/                      contract model, script + freeze-payload renderers
  workspace/                   task workspace layout, draft/plan gate
skills/ncu-report-skill/       vendored upstream skill, revision in VENDORED.yaml
skills/KernelWiki/             fetched at runtime into the pi agent directory, never bundled
third_party_licenses/          verbatim upstream license texts
docs/adr/                      why the loop engine is reused, why the packaging split, why sm_90 first
```

## License

MIT for first-party code. Third-party boundaries are in `THIRD_PARTY_NOTICES.md`.
