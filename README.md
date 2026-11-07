# pi-kernel-expert

*CUDA kernel optimization for pi: the KDA flow on pi-goal's frozen-contract loop, with KernelWiki knowledge and Nsight Compute evidence.*

Status: **0.2.0 — knowledge wired.** The package loads, ships the vendored ncu profiling skill, fetches and sanitizes the KernelWiki corpus at a recorded revision, and answers wiki queries. The kernel contract generator, evidence layer, and workflow skill are the next tickets (see `.dev/feature-pi-kernel-expert/plan.md`).

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
extensions/pi-kernel-expert/   composition root, status, bootstrap + wiki tools, (next: contract, evidence)
  knowledge/                   fetch, sanitize, conflict scan, registration plan
skills/ncu-report-skill/       vendored upstream skill, revision in VENDORED.yaml
skills/KernelWiki/             fetched at runtime into the pi agent directory, never bundled
third_party_licenses/          verbatim upstream license texts
docs/adr/                      why the loop engine is reused, why the packaging split, why sm_90 first
```

## License

MIT for first-party code. Third-party boundaries are in `THIRD_PARTY_NOTICES.md`.
