# pi-kernel-expert

*CUDA kernel optimization for pi: the KDA flow on pi-goal's frozen-contract loop, with kernel-wiki knowledge and Nsight Compute evidence.*

Status: **0.4.0 — loop complete.** Contract (schema v2 is on `main`, under Unreleased in `CHANGELOG.md`), baseline, profiling evidence, candidate lineage, and the `kernel-flow` skill are all in place. GPU verification started on an sm_90 node; Blackwell and the ncu collection path remain unverified (`docs/verify.md`).

## Why this exists

Three good sources describe how to optimize GPU kernels, and none of them can stop an agent from promoting a kernel because the story sounds right:

- **KDA** (NVlabs) describes the flow — task contract, plan draft, one candidate at a time, validate, measure, promote or record the rejection.
- **KernelWiki** (mit-han-lab) holds the Blackwell/Hopper knowledge; this package fetches a maintained copy, `kernel-wiki`, at a pinned revision.
- **ncu-report-skill** (mit-han-lab) holds the profiling procedure.

`pi-goal` already provides the part that must not be re-litigated in prose: a frozen contract with a hash, a deterministic gate, an append-only journal, and a reverted attempt kept as evidence.

This package connects them. Kernel rules ride in data pi-goal already accepts — generated `goal.sh` lines, generated `goal.checks.sh` scripts, and structured `asi` payloads. **pi-goal is used unmodified.**

## Requirements

| Piece | Version | Needed for |
|---|---|---|
| pi | >= 1.5.0 (`resources_discover`, `agent_before_settle`) | everything |
| `@ariesfish/pi-goal` | >= 0.5.3 | the loop, contract, gate |
| python3 | >= 3.11 | ncu helpers and kernel-wiki queries (no PyYAML needed) |
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
clones `ariesfish/kernel-wiki` at the recorded revision, verifies the checked-out
SHA, and scans the tree for `LicenseRef-NvidiaProprietary`. The 19 restricted
files are removed in the corpus itself and listed in its `SANITIZED.yaml`, so
the normal result is "0 removed" — the scan still runs, because an absence it
did not verify is an absence it cannot claim. A tree at another revision is
refused, never overwritten.

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

## Evidence and promotion

```text
kernel_profile({ command: "python bench.py", kernel: "fmha" })
# or attach a report produced on the GPU machine:
kernel_profile({ report: "profile/run1/reports/full.ncu-rep", reuse_analysis: true })

kernel_candidate({
  decision: "keep",
  description: "fuse the epilogue into the second GEMM",
  metrics: { geomean_speedup: 1.18, latency_us_s1024: 41.2, latency_us_s8192: 612.0 },
  profile_run: "run1",
  bottleneck_claim: "latency-bound on L1",
  bottleneck_metric: "l1tex__throughput.avg.pct_of_peak_sustained_elapsed",
})
```

- The summary records only metrics present in the report; absent key metrics are
  listed, never zeroed.
- The profile is bound to the contract hash and the diff hash. Editing code
  after profiling makes it stale and `kernel_candidate` refuses it.
- A keep carries the run's reading block (`goal.sh` stdout, the block alone, or
  its JSON). `kernel_candidate` checks that each claimed cell value is the
  geomean of the reading's groups, that the reading's contract sha matches this
  task, that the timed window was not host-bound, that the diff did not touch a
  harness glob, and that the candidate's `max_diff` stays within
  `3 * e_ref + max(ulp(dtype), 2^-17)` of the reference's own error. A run that
  never calibrated its precision ruler is `unmeasured`, never zero.
- A keep below the contract's `noiseFloorPct` needs `force_with_reason`, and the
  reason is recorded. A rejection needs a reason.
- `profile/` and `runs/` are excluded from the diff fingerprint, so evidence
  files never invalidate each other.
- Every recorded candidate refreshes `benchmark.csv` from the ledger: it is a
  derived view, never hand-edited.

A promotion that rests on a mechanism leaves a page behind, in kernel-wiki's own
shape:

```text
kernel_wiki_candidate({
  id: "single-pass-epilogue-fusion",
  title: "Fusing the gate-up epilogue into the second GEMM removes one global round-trip",
  type: "technique",
  mechanism: "the first GEMM's accumulator tile is staged into the second GEMM's smem operand instead of global memory",
  trigger: "ncu shows DRAM throughput above 60% with the intermediate tensor still in global memory",
  cost: "48 KiB more smem per block, so occupancy caps at two blocks per SM",
  conditions: "holds while the intermediate tile fits smem",
  gotchas: "the swizzle of the staged tile must match the mma layout",
  sources: ["c2", "profile/run1"],
})
```

- It writes `.kernel/wiki-candidates/<id>.md` — frontmatter plus Mechanism,
  Trigger, Measured footprint and cost, Load-bearing conditions, Gotchas,
  Negative readings. `architectures` (H100/H200 → `sm90`, B200/GB200 → `sm100`)
  and `sources` are pre-filled from the newest `profile/<run>/summary.json` and
  `candidates.jsonl`; `mechanism`, `trigger`, `conditions` and `gotchas` are
  yours.
- It refuses a category trigger (`when needed`, `optimize`, `tune`, …), a
  `verified` confidence with no source that resolves here, a leftover `<...>` or
  template sentence, an id already in the cached corpus or in
  `.kernel/wiki-candidates/`, and a body that names this task's cells, harness
  commands or files (a fenced code block is the allow-list) — because the corpus
  is shared and the next operator cannot resolve them.
- It never writes the corpus. Publishing is a human step: `cp` the file into
  `kernel-wiki/wiki/<type>/`, run `generate-indices.py`, commit, bump
  `KERNEL_WIKI_PIN`.

## The skill

`/skill:kernel-flow` carries the loop: contract → draft → plan → freeze →
baseline → candidate → profile → record, plus the hard rules, the failure
table, and a GPU benchmark checklist.

## Validate the plan

If a task keeps `docs/milestone.md`, `kernel_milestone` validates it as an
addressable plan: the seven sections, the phases `M0..Mk` and their order, every
decision's five-tuple (`Action`, `Purpose`, `Trigger`, `Cost`, `Depends on`)
with its `⇐`/`⊗`/`⇒` edges, the typed `[VERIFY: …]` gate lines, and the
dead-end rows. It reports every refusal in one pass — rule, row, and fix — and
never writes the file. `kernel_init` does not create the milestone: you write
it, this tool judges it.

The plan's hard choices — tile, smem inventory, warp roles, register budget,
issue order, accumulator precision — go in `### M0 Contract`, one
`- <item>: <value>` line each. Lock them once they are right:

```text
kernel_milestone({ lock: true })
```

From then on the block is byte-identical or the file is refused as `m0-thawed`,
naming the item that moved. To change M0 on purpose, `unlock: true` with a
reason: it lands in `## 4. Dead Ends` as a diagnosis, so a thaw is a decision
with a date instead of an edit nobody remembers making.

## Check what is wired

```text
/kernel-expert
```

```text
pi-kernel-expert 0.4.0
  loop engine   pi-goal installed
  ncu skill     vendored @c7980a43cb88 at .../skills/ncu-report-skill
  kernel-wiki   cached at ~/.pi/agent/kernel-expert/cache/kernel-wiki@377d4560840d
```

The ncu skill is vendored and works offline. The kernel-wiki corpus is fetched
at a recorded revision, never bundled: it is ~37 MB and its artifacts carry
upstream terms. The fetch scans for the restricted marker rather than trusting
it absent, and records what it removed in the cache's `SANITIZED.yaml`.

## What runs where

The build machine has no GPU, ncu, or nvcc, so nothing hardware-dependent is
claimed as verified without a recorded GPU run. `docs/verify.md` records exactly
what ran, on what, and what was deferred — including the sm_90 reading block and
one clock-locked run, and the Blackwell and `.ncu-rep` paths that remain
unexercised. The `make gpu-smoke` target and a CPU end-to-end fixture are still
open; until they land, hardware claims stay unverified.

## Layout

```text
extensions/pi-kernel-expert/   composition root, status, and the eight tools
  knowledge/                   fetch, sanitize, conflict scan, registration plan
  kernel/                      contract, generated scripts, reading block, precision
                               ruler, refusals, profile summary, candidate gate,
                               milestone validator, wiki-candidate entry
  workspace/                   task workspace layout, draft/plan gate
skills/kernel-flow/            the loop, the failure table, the benchmark checklist
skills/ncu-report-skill/       vendored upstream profiling skill, revision in VENDORED.yaml
third_party_licenses/          verbatim upstream license texts
docs/adr/                      why the loop engine is reused, why the packaging split, why sm_90 first

~/.pi/agent/kernel-expert/cache/kernel-wiki@<pin>/   corpus fetched at runtime, never bundled
```

## License

MIT for first-party code. Third-party boundaries are in `THIRD_PARTY_NOTICES.md`.
