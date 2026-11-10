# corpus-1 — one promotion, one page

Card 3 on `h200-7`, driver 580.178.04, `scripts/job-env-check` green. Fixture
`.dev/feature-kernel-expert-v2/fixtures/saxpy`.

## The optimization was real, and the contract did not change

`bench.cu` grew two mappings of the same arithmetic: `coalesced` (consecutive threads on consecutive
elements) and `strided` (a transposed grid-stride, correct but every warp load is 32 sectors). The
default is a **compile-time** choice, so "optimize the kernel" meant rebuilding it:

```
baseline   nvcc -DSAXPY_DEFAULT_MODE="strided"   → METRIC latency_us_saxpy=698.36
candidate  nvcc -DSAXPY_DEFAULT_MODE="coalesced" → METRIC latency_us_saxpy=61.30
                                                    METRIC geomean_speedup=11.39232152
```

N = 16 777 216 floats; 128 MB across both arrays, against a 60 MB L2 — the working set is what makes
the mapping matter.

## What the tools recorded

```
recorded C1 (keep) — parent baseline
  diff 2694147683ec  contract 523e38b2f233
  geomean_speedup 11.39232152
  reading: basis device, hostBoundRatio 0.0332, verdict measured, pairing absent
  wiki: coalesced-warp-mapping-memory-bound
```

Two design flaws surfaced only by running it, and both are fixed:

1. **The entry and the ledger row cited each other.** The candidate must cite the page and the page
   must cite its evidence, and the tool refuses a page whose source does not resolve — so nothing
   could be written first. `contract:<sha>` is now a resolvable source: a reading identifies itself
   by the contract it ran under.
2. **`verified` was silently downgraded to `inferred`** when the workspace had no profile, and
   `contract:` sources were reported as unresolved. Both were the prefill computing its own answer
   instead of calling the validator's `resolvesSource`.

## A claim that was written from expectation, and what replaced it

The first draft's `## Negative readings` said a 128-bit vector load "changed nothing measurable (0.0613
vs 0.0612 ms)". **That experiment was never run.** It was written from expectation, in the one section
of the one artifact whose entire purpose is to stop that. It was caught by re-reading the entry
against the session's commands, not by the tooling — `validateEntry` cannot tell a measured number
from a plausible one, and no schema will.

The replacement is a measurement, and it falsified the draft's own load-bearing condition:

| N (working set) | coalesced | strided | ratio |
|---|---|---|---|
| 1 Mi (8 MB) | 0.004424 ms | 0.043901 ms | **9.9x** |
| 4 Mi (32 MB) | 0.012256 ms | 0.168481 ms | **13.7x** |
| 16 Mi (128 MB) | 0.061417 ms | 0.701747 ms | **11.4x** |

The draft claimed the gap collapses when the set fits L2. At 8 MB it is still 9.9x, because the cost
is sectors *requested per warp*, not bytes moved — L2 residency removes the latency, not the request
amplification. Both the condition and the gotcha were rewritten, and the negative reading now records
the wrong hypothesis and the three numbers that killed it.

## A remaining weakness: the source token

`sources: [contract:523e38b2f233]` resolves **only inside the task workspace** — it is the sha of that
contract file. A corpus reader cannot check it. That is a gap in the source vocabulary, not in this
entry: `corpus` needs a durable token (e.g. `task:<op>@<reading-id>` with the reading archived), and
`contract:<sha>` is honest but local. Recorded here rather than papered over.

## Publish

`publish.diff` is the whole change a publish applies to `kernel-wiki`:

```
queries/by-architecture.md                          |  1 +
queries/by-technique.md                             |  1 +
wiki/techniques/coalesced-warp-mapping-memory-bound.md | 33 +++++++++++
```

`generate-indices.py` regenerated the two index pages; `check_dod_fixtures.py` passes. The entry
appears in `by-technique.md` as `verified` — the only `verified` row in that table, because it is the
only one measured in the workspace that wrote it.

## A claim that was written from expectation, and what replaced it

The first draft's `## Negative readings` said a 128-bit vector load "changed nothing measurable (0.0613
vs 0.0612 ms)". **That experiment was never run.** It was written from expectation, in the one section
of the one artifact whose entire purpose is to stop that. It was caught by re-reading the entry
against the session's commands, not by the tooling — `validateEntry` cannot tell a measured number
from a plausible one, and no schema will.

The replacement is a measurement, and it falsified the draft's own load-bearing condition:

| N (working set) | coalesced | strided | ratio |
|---|---|---|---|
| 1 Mi (8 MB) | 0.004424 ms | 0.043901 ms | **9.9x** |
| 4 Mi (32 MB) | 0.012256 ms | 0.168481 ms | **13.7x** |
| 16 Mi (128 MB) | 0.061417 ms | 0.701747 ms | **11.4x** |

The draft claimed the gap collapses when the set fits L2. At 8 MB it is still 9.9x, because the cost
is sectors *requested per warp*, not bytes moved — L2 residency removes the latency, not the request
amplification. Both the condition and the gotcha were rewritten, and the negative reading now records
the wrong hypothesis and the three numbers that killed it.

## A remaining weakness: the source token

`sources: [contract:523e38b2f233]` resolves **only inside the task workspace** — it is the sha of that
contract file. A corpus reader cannot check it. That is a gap in the source vocabulary, not in this
entry: `corpus` needs a durable token (e.g. `task:<op>@<reading-id>` with the reading archived), and
`contract:<sha>` is honest but local. Recorded here rather than papered over.

## Publish commands (the human step)

```
cp wiki-candidates/coalesced-warp-mapping-memory-bound.md <kernel-wiki>/wiki/techniques/
cd <kernel-wiki> && python3 scripts/generate-indices.py \
  && python3 scripts/check_dod_fixtures.py && python3 scripts/check_version_freshness.py
git add -A && git commit -m "feat(techniques): coalesced warp mapping on memory-bound kernels"
# then bump KERNEL_WIKI_PIN in pi-kernel-expert and re-run kernel_bootstrap
```
