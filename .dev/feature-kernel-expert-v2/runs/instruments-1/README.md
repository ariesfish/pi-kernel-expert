# instruments-1 — the six SASS reads and a citation that can be refused

Run 2026-11-10 on `h200-7` (`ssh builder`, card 3 idle). Driver 580.178.04,
CUDA 13.0.88, Nsight Compute 2025.3.1. The kernel is the SAXPY fixture this repo
already uses; the dumps are real, the card is real, and nothing here is compiled
by the package.

| Artifact | What it is |
|---|---|
| `bench.sass` | `cuobjdump -sass bench` on the node: three kernels, real sm90 code |
| `coal.csv`, `details.csv` | an `ncu --set full` collection of the coalesced kernel: the source page and the details page |
| `sass-views.txt` | the seven views on those files, verbatim |
| `kb/sm90/` | one entry written from a real reading, with its symptom index |
| `docs/milestone.md` | a milestone whose `[VERIFY: sass-derived]` line prices itself with `KB:identical-census-different-addressing` |
| `run-views.mts` | the script, through the real tools |

What the run establishes, and one thing it corrected:

- **Both dump formats parse with one parser.** `census` on the cuobjdump text and on
  the ncu source page gives the same 32 instructions and the same families; the
  offsets count from the kernel's first instruction in both, even though ncu writes
  absolute addresses.
- **The kernel is never guessed.** A dump with three kernels and no execution
  counts refuses by name, listing each candidate and its instruction count.
- **`live` reports a lower bound and says so.** The SASS names R0..R7 (`peak=8`);
  the details page says `Registers Per Thread = 16`. That gap is the view's own
  caveat, printed with the reading.
- **`launch` reads the metrics, not the grid.** The real launch is a flat
  4096-block grid with `Cluster Size = 0` — no cluster — and the view reports the
  0 rather than inferring one. `ctas` is missing from the export and the verdict
  says `LAUNCH-PARTIAL` instead of inventing a 1.
- **`schedule` refuses to call a SAXPY kernel a failure.** No matrix multiply means
  `SCHED-SKIP`, not `SCHED-FAIL`.

The correction: the draft milestone claimed "4 elements per thread, 1024 elements per
block". The dump shows **one element per thread** — two `LDG.E`, one `FFMA`, one
`STG.E`, no loop — because the benchmark launches enough threads to cover N in one
pass. The reading wrote the milestone's `M0 Contract` and its gate line, not the
other way round, and that is what this module is for.

The entry that came out is not the one I expected to write. The two mappings carry
the same four real operations and are 11.39x apart in time; the count (32 against 40
instructions) differs only in padding and the loop, and what actually separates them
is one `IMAD` (`thread * blockDim + tid` against `tid * blockDim + block`). A
"footprint" number here would have been the 11.39x dressed up as a SASS property;
instead the entry records the structural fact and puts the percentage where it
belongs, on one structure on one card.

`kernel_kb cite` emits `KB:identical-census-different-addressing` (`priced.txt`); a
copy with the status downgraded to `UNVERIFIED` refuses, and the milestone's gate
line then fails with the citation tool's own reason quoted — one predicate, two
callers, so the price and the citation cannot disagree.
