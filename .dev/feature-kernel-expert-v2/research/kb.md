# ForgeKernel `hw_kb/` — the knowledge base and the prompt pipeline that fills it

Read note for a gap analysis against `pi-kernel-expert` (which instead vendors
mit-han-lab's KernelWiki corpus + the `ncu-report-skill`). Repo:
`/Users/ariesfish/Projects/github/dev-skills/ForgeKernel` (rev at 2026-11-09).

Inventory, so the volume is on the record and out of the way:

| tree | files | entries | `index.md` rows |
|---|---|---|---|
| `hw_kb/cuda/sm100/` | 65 | 64 | 64 |
| `hw_kb/cutedsl/sm90/` | 55 | 54 | 54 |
| `hw_kb/cutedsl/sm100/` | 75 | 74 | 74 |

195 `.md` under `hw_kb/`; 190 carry `## Purpose`, 191 carry `## Sources`, 79 carry a
`Certification source` line, 31 name B200. There is **no `hw_kb/TEMPLATE.md`** — the template
is per language: `hw_kb/cuda/TEMPLATE.md` (39 L), `hw_kb/cutedsl/TEMPLATE.md` (39 L).

---

## 1. Entry schema

### 1.1 The five mandatory sections and what each is for

Both templates are byte-for-byte the same skeleton with the code language swapped
(`hw_kb/cuda/TEMPLATE.md:1,5,8,11,18,21` ≡ `hw_kb/cutedsl/TEMPLATE.md:1,5,8,11,17,21`):

| Section | Line | Purpose as written in the template | What it actually forces |
|---|---|---|---|
| `# <interface name>` + `>` preamble | `cuda/TEMPLATE.md:1-3` | — | One file per **hardware interface**, "Operator-agnostic: mechanism only". The H1 carries the mechanism plus, usually, the whole thesis in parentheses (`elect_one.md:1` is 4 clauses long). |
| `## Purpose` | `:5` | "What hardware-level problem this interface solves (one sentence)." | The mechanism's reason for existing, with no operator in it. |
| `## When needed (trigger)` | `:8` | "Which student need / symptom calls for it (profiler symptom / SASS footprint / dataflow shape / compiler error text)." | **An observable.** Not "when you need better perf" — a thing you can see in a tool. |
| `## Minimal runnable example` | `:11-16` | "Minimal, self-contained... From a verifiable source; nothing made up. Show only 'how to use this interface'; do not embed any specific operator's algorithm." | The KB is the only code-bearing artifact in the repo, and this section is why. CUDA variant additionally requires the full PTX constraint string and a `// fk-cuda-cflags:` line (`cuda/TEMPLATE.md:13-16`). |
| `## Gotchas` | `:18` | "What error a misuse raises / where it goes silently wrong (e.g. alignment requirements, descriptor fields, phase counting, memory order and fences, drain timing)." | The failure taxonomy: hard error vs **silent** wrong. Every gotcha must name a symptom. |
| `## Sources` | `:21-38` | Three and only three citation kinds; forbidden list | The leak boundary, see §2.4. |

### 1.2 The template is a floor, not a ceiling

Section-heading census over `hw_kb/**/*.md` (grep `^## `):

```
191 ## Sources      190 ## Purpose      188 ## When needed (trigger)
188 ## Gotchas      177 ## Minimal runnable example
 11 ## Mechanism          5 ## Certification boundary [UNVERIFIED-BOUNDARY]
  5 ## Out of scope       5 ## Minimal runnable example (CuTe DSL)
  4 ## Machine-read footprint (acceptance criteria)
  3 ## Certification boundary [UNVERIFIED-BOUNDARY]
  2 ## Why it exists      2 ## Load-bearing conditions / condition
```

Notably the template has **no slot for measured numbers at all** — every serious entry adds one:
`## Measured footprint and cost (probe, B200)` (`cuda/sm100/mbarrier_wait_scope.md:33`),
`## Machine-readable footprint (what to look at after a depth change, and what not)`
(`cutedsl/sm90/ring_depth_lever.md:86`), `## Readings (probe; B200, SM clock locked at 1500 MHz)`,
`## Ceiling`, `## Load-bearing conditions (… this entry's readings are the side where it is **not**)`
(`cutedsl/sm100/consumer_warpgroup_pingpong_parity.md:108`). 62 distinct `##` headings do not
appear in either template. The schema is a prompt contract, not a machine check (§2.6).

### 1.3 Certified vs candidate vs recipe

Three evidence classes earn `✅` and nothing else does (`hw_kb/cuda/sm100/index.md:7-10`,
`hw_kb/cutedsl/sm100/index.md:8-13`):

1. **`PROBE PASS` on a GPU** — the default.
2. **A shipped KEEP whose own NCU dossier census shows the contract axis moved** — exists because
   some knobs are "**numerically invisible** — descriptor modes, cache-policy bits, DEPBAR depth:
   both spellings compute the same bytes, and a `max_diff` probe cannot see such a change"
   (`hw_kb/cuda/sm100/index.md:8-9`).
3. **Transcription with a `Certification source` line** — a methodology entry re-homed from another
   tree, keeping the arch it was read on: "**location is not provenance — that line is**"
   (`hw_kb/cutedsl/README.md:38-42`). Such a row reads
   `Transcribed (certified in CuTe DSL mode; not re-checked in CUDA mode)`
   (`hw_kb/cuda/sm100/index.md:93-94`).

The declared legend is `Status: ⬜ TODO / 🟡 draft / ✅ Verified (the example runs and its source is cited).`
(`hw_kb/cutedsl/sm90/index.md:72`). Live examples of each below-verified state:

- `⬜ TODO` — `griddepcontrol_pdl` (`cutedsl/sm90/index.md:46`), i.e. a name with no file.
- `🟡 draft` — `tma_multicast_cluster`: `🟡 draft (sources checked against CUTLASS 4.4.2/4.6.1;
  GPU probe pending, promoted to ✅ once it passes)` (`cutedsl/sm90/index.md:41`).
- A fourth class the legend does not name but the tree uses everywhere: `✅ reading method (...)`,
  for entries that prescribe an *interpretation procedure* rather than a mechanism
  (`cutedsl/sm90/index.md:57` `smem_traffic_triage`, `:58` `mma_operand_source_verify`,
  `:63` `gather_index_prefetch`). `cuda/sm100/smem_traffic_triage.md:6-7` states the distinction:
  "**This is a reading recipe (a diagnosis method), not a mechanism recipe**".
- A fifth: certified-with-a-hole. Index cells carry parenthetical scope limits — `✅ Verified (CUDA
  probe; certifies only SASS, not the gain)` (`cuda/sm100/index.md:108`), `(CUDA probe; pair
  uncertified)` (`:120`), `(CUDA probe; `cta_group::2` uncertified)` (`:130`).

### 1.4 One real entry, verbatim

`hw_kb/cuda/sm100/elect_one.md` — headings:

```
:1    # elect_one (single-thread election: the scope of PTX `elect.sync`, the outer predicate,
          and "which instructions need an election and which must not have one")
:3-7  > **Certification source: B200 GPU-certified in CUDA mode (all 5 contracts PROBE PASS; the
          probe is not included in this release).**
      > Certification covers: `elect.sync` is warp-scoped; a warp-uniform outer predicate + elect
          = exactly one thread in the whole CTA; ...
      > **Uncertified (written from the PTX ISA documentation)**: the consequences of wrapping a
          whole-warp `.sync.aligned` instruction in elect (deadlock / undefined; the probe did not
          trigger it);
:11   ## Purpose
:19   ## When needed (trigger)
:27   ## Minimal runnable example
:72   ## Gotchas
:97   ## Sources
```

The `>` preamble is where the confidence split lives — **before** any section, so a reader who
stops after the first screen already knows what is not proven. One full evidence line, `:105`:

```
  `PROBE PASS max_diff=0.0 elect_one/R0-no-elect-control per_warp=[32, 32, 32, 32]`,
```

Note the shape: verdict token + error norm + `<entry>/<contract-id>` + the measured reading inline.
Five such lines at `:105-109`, one per contract, all five PASS, and the mechanism under test is
named in the contract id (`R1-elect-is-warp-scope` with `per_warp=[1, 1, 1, 1]` against a
`[32, 32, 32, 32]` control).

---

## 2. The certification pipeline

```
G3 diagnosis (deficient_locus: KB:<interface>)
  └─> meta/kb_recipe_prompt.md  ── teacher writes 2 artifacts: recipe .md + probe script
        └─> PROBE_REQUEST: notes/<name>.py   ── driver commits to -kbprobe, pushes, submits GPU job
              └─> log tail + verdict audit ──> PROBE FAIL → fix, loop (max_probe_rounds)
                    └─> PROBE PASS → teacher marks ✅ in index.md, emits RECIPE_CERTIFIED: <path>
                          └─> lint gate (certify) → hit: bounce once, then quarantine
                                └─> student's next iteration may read it
  └─> OR meta/kb_harvest_prompt.md  ── no GPU at all; certification already happened
        └─> RECIPE_RECORDED: <path>   for each generalizable lesson
```

### 2.1 What a GPU probe must show

`meta/kb_recipe_prompt.md:28-35` is the whole contract. Requirements on the probe:

- **Self-contained script** at `WORKSPACE/notes/<name>.py`, exercising **only the recipe's mechanism
  path**: "build known values → run the mechanism → compare against a trivial numpy reference"
  (`:29-30`). Must not run the main kernel, must not read the answer branch.
- **Exactly one line per contract**: `PROBE PASS max_diff=<x>` / `PROBE FAIL max_diff=<x>` (`:29-30`).
- **`max_diff` must be a real error norm, finite, ≤ `1e3`** (`:32`).
- Non-numerical contract (compiles? deadlocks?) → `PROBE PASS max_diff=n/a` (`:32-34`).
- **`PROBE PASS` without max_diff, or a max_diff used as a status code stuffed with a bitmask, is
  always judged uncertified** (`:33-34`).
- Several contracts → several lines, **all must PASS for the probe to PASS** (`:34-35`).
- Turn protocol (`:37-51`): first turn ends with the literal line `PROBE_REQUEST: notes/<name>.py`;
  on `NO VERDICT` ("not a single PROBE line in the log = the probe did not compile or the job died")
  the instruction is explicitly *"**This is not a numerical problem**; first get it to run"* (`:45-46`).

The verdict-probe design rules that back this (`meta/verdict_probe_brief.md:26-39`): pair all
variants **within one job** and read only ratios, because "node bimodality makes absolute values
drift ±6% across jobs, wider than most single-round gains" (`:27-28`); one variable per variant with
pre-registered criteria printed by the script (`:29-33`); a control contract that fails affects only
its own line and "does not wipe a decisive contract's PASS into a FAIL" (`:32-33`); "PASS and FAIL
are both evidence: a FAIL in a verdict experiment is not a failed experiment, it is a falsified
hypothesis" (`:34-35`); "**Measure only, do not build**" (`:36`).

### 2.2 The harvest path (the second entrance)

`meta/kb_harvest_prompt.md` is a **single turn, no GPU** (`:1`, `:17-22`): the winning probe has
already returned PASS, "and **that run itself is the certification evidence**". Two triggers:

1. **kb-tripwire** — a student probe burned ≥ the threshold number of GPU rounds before PASS
   (`:3-7`): "an N-round pyrrhic victory exposes exactly a knowledge gap that very nearly got stuck".
2. **contract-axis change** — a KEEP moved a contract axis of the SASS dossier (loop roles,
   mbarrier objects/layering, ring shape, NamedBarrier rulings, cross-role edges, DEPBAR in-flight
   depth, reduction placement, supply issue order, cache-policy bits) without a probe tug-of-war
   (`:9-15`). What gets recorded is "**knob + SASS footprint + under which conditions it carries
   load**", not the percentage (`:14-15`).

The recipe body for class 2 records exactly three things (`:59-63`): the **knob** ("if the change
record does not make the DSL spelling clear, mark it `[to be checked]`"), the **footprint** (axis
readings before/after, verbatim), and the **load-bearing condition** ("worth X% under <this run's
structural conditions>, not a universal percentage"). Index evidence parenthesis format:
`(KEEP in job <n>, axis <axis> <before>→<after>, gate <ms_before>→<ms_after>)` (`:56-58`).

Harvest hard rules that matter structurally: "**Unverified rows of the recon table do not enter the
KB**... they **must not** be written into `{KB_DIR}` as a `[pending certification]` pitfall, a `⏳`
placeholder or in any other form — **the KB's only entrance is a probe-certified recipe**"
(`:72-76`); "Experiment narrative does not go into any file of `{KB_DIR}` (index.md included): run
names/dates, iter numbers, commit/cubin shas are never written (`kb_lint` machine-checks this)"
(`:79-81`).

### 2.3 `kb_lint.py` — every mechanical check, with its condition

`src/forgekernel/loop/kb_lint.py`, 455 L, docstring `:1-52` enumerates four checks; the code adds
three more (fail-closed, job-id policy, exam surfaces). Per file, findings are
`path:line: reason` strings.

**Rule 1 — banned words.** `BANNED_WORDS` at `:69-76`, three patterns:
`_word("oracle")`, `_word("teacher")`, `reference[- ]implementations?`.
Condition: `re.compile(rf"(?<![A-Za-z0-9]){term}(?![A-Za-z0-9])", re.IGNORECASE)` (`:66-70`).
Boundaries are **ASCII-only on purpose**: "Python's `\b` treats CJK as word characters, so `oracle`
followed directly by a CJK character would slip through a `\b`-delimited pattern — and an agent may
still write CJK prose into an entry" (`:18-21`). Catches `oracle_kernel`, `ORACLE:`, `oracle一词`;
does not catch `coracle`. Applied at `:300-302`.
Skip: `SKIP_NAMES = {"README.md", "TEMPLATE.md"}` (`:60`) — rule files legitimately name the thing
they forbid; filtered in `lint_kb_dir` at `:333-334`.

**Rule 2 — reference tokens.** Condition: **case-insensitive substring**, `tok_low in low` (`:321-324`)
— no word boundaries, so `flash_attn_dsl` also hits inside a longer identifier. Two token sources:
- static `REFERENCE_TOKENS` (`:80-127`): `flash-attention`, `flash_fwd_sm90`, `flash_bwd`,
  `mainloop_bwd_sm90`, `flash_attn_dsl`, `mma_one_n_block`, `mma_one_m_block`, `intrawg_overlap`,
  `RescaleOBeforeGemm`, `first_half_block_overlap`, `last_half_block_overlap`,
  `_sm90_compute_tile_shape_or_override`, `_make_smem_layouts`,
  `_make_tma_store_atoms_and_tensors`, `_get_tiled_mma`, `_get_smem_layout_atom`, `workload/src`,
  `acc_to_smem_epi_tile`, `flash_mla`, `flashmla`, `sparse_attn_fwd_kernel`, `deep_gemm`.
  Comment at `:107-110` records a deliberate *non*-entry: `_make_tma_atoms_and_tensors` is the
  official CUTLASS `dense_gemm` example helper and entries may cite it.
- `derive_reference_tokens(oracle)` (`:128-224`): reads the resolved oracle tree and derives tokens
  **mechanically** — source basenames, stems, and Python `def`/`class` names (`_PY_DEF` at `:139`,
  `:209-214`) — "so protection does not depend on a human editing it per operator" (`:151-153`).
  Guards: name length ≥ 6, dunders skipped (`:196-199`), `_DERIVE_STOPLIST` (`:116-126`:
  `forward backward kernel kernels common config configs helpers launch params static template test
  tests utils wrapper interface benchmark setup schedule sharedstorage namedbarrier`), first 500
  files, `_SOURCE_EXTS` = `.py .cu .cuh .cc .cpp .cxx .hpp .hh .h` (`:137`). Degrades **loudly**: a
  missing oracle path emits `report("missing", …)` and the CLI prints
  `[kb-lint] warning: oracle path not readable — …` (`:176-188`, `:436-437`). Closed-binary runs have
  no derivation and need the recon symbol names appended by hand (`:113-115`).

**Rule 3 — line-number citations with no whitelisted source.** `_LINE_REF` at `:228-231`:
```
\bL\d{2,}\b                      # L123; single digit excluded so L1/L2 cache levels pass (:226-227)
|\.(?:py|cu|cuh|cc|cpp|cxx|hpp|hh|h):\d+
|\blines?\s*~?\s*\d+
```
Condition (`:328-340`): a match is a finding **only if** neither the line nor its **block head**
contains any `SOURCE_WHITELIST` entry (`:206-220`): `docs.nvidia.com`, `nvidia.github.io`,
`forums.developer.nvidia.com`, `PTX ISA`, `cutlass`, `CUTLASS`, `cute/`, `CuTeDSL`, `cpasync`,
`quack`, `third_party`, `examples/python`, `probe_`, `notes/`, `scripts/`, `hw_kb/`, `.md)`.
Blocks are formed by `_BLOCK_START = ^(?:[-*] |\d+\. |#)` or a blank line (`:232`, `_blocks` at
`:235-248`). Two deliberate narrowings: `probe_` and `notes/` are whitelisted **as path forms**, not
the bare word `probe` — "that word must not bless a line ref" (`:164-166`), and there is a test for it
(`tests/test_kb_lint.py:106 test_bare_probe_prose_does_not_bless_a_line_ref`); the match is
per-line-not-per-block, because "one stray 'probe' in a block must not bless every unattributed line
ref around it" (`:152-154`).

**Rule 4 — experiment narrative.** `NARRATIVE_RULES` at `:262-273`, five patterns:

| # | regex core | why |
|---|---|---|
| 1 | `0[789][0-3][0-9]` with non-alnum boundaries | run date (MMDD). Only months 07–09: "later months collide with ordinary numbers like 1024 and are caught through the `<date> … run` form instead" (`:255-259`) |
| 2 | `20[0-9]{2}-[01][0-9]-[0-3][0-9]` | calendar date |
| 3 | `(?:0[789]\|1[012])[0-3][0-9]\s*(token[_\-]token\s+)?(?:arm\|run)\b` | run reference (`<date> … run`); the middle token must contain `_` or `-` "so "1024 threads run" stays prose while "1015 dsa_sparse run" is flagged" (`:256-259`) |
| 4 | `iter\s*[0-9]+` | iteration number of a past run ("`every eval iter` as a noun is prose", `:263-265`) |
| 5 | `(?=[0-9a-f]*[a-f])(?=[0-9a-f]*[0-9])[0-9a-f]{7,12}` | commit / cubin sha — "a sha needs both a digit and a hex letter" (`:261`) |

**Rule 5 — job id, policy-dependent.** `_JOB_ID = (?<![A-Za-z0-9_])job\s*\*{0,2}[0-9]{5,12}(?![0-9])`
(`:277`), width 5–12 "same width as `driver._KB_CERT_MARK` so what certifies an entry is what a
template may not carry" (`:274-276`). Inside `hw_kb/` it is **allowed** — `lint_text` calls
`lint_narrative_text(..., allow_job_ids=True)` (`:341`) because it is "the certification pointer the
harvest prompt requires" (`:38-40`). On prompts/templates it is banned (`:287-288`).

**Rule 6 — fail closed on a missing tree.** `lint_kb_dir` returns
`f"{kb_dir}:0: kb_dir does not exist — nothing was scanned (fail closed)"` (`:336-337`): "a
mispointed kb_dir (e.g. a shared venv resolving to the wrong worktree) must not certify as leak-free a
tree that was never scanned" (`:330-333`).

**Rule 7 — the other exam surfaces.** `lint_exam_surfaces` (`:374-435`):
`EXAM_SURFACE_DIRS = ("meta", "src/forgekernel/card_template", "skills")` (`:348`),
`EXAM_SURFACE_FILES = ("docs/milestones-template.md",)` (`:349`), `EXAM_SURFACE_PY =
("src/forgekernel", "skills")` (`:350`), `_SURFACE_EXTS = {".md", ".toml"}` (`:351`). Markdown/TOML
linted whole; Python only through **non-docstring string constants** via an AST walk
(`_py_prompt_strings`, `:383-398`) — "docstrings and comments are exempt; agents never see them"
(`:43-46`). Job ids banned here too.

Three gate points (`:9-13`): **loop start** (whole tree, catches manual edits), **certification** (the
file the teacher just wrote, before the student can read it), **harvest**. On a certification hit the
entry is bounced back for revision, and if it still fails it is **moved** (not deleted) to
`<repo>/kb_quarantine/` (`driver.py:3445-3468`, `qdir = lang_mode.kb_repo_root(ctx.kb_dir) /
"kb_quarantine"` at `:3459`). The move is load-bearing: "a moved tracked entry shows up as a deletion
in git status, so the next run's `kb_blockers` guard forces a human through here before anything
restarts" (`driver.py:3458-3461`).

**What it does NOT check** — and they know it:

- **No section-presence check.** Nothing in `src/` or `tests/` asserts that an entry has `## Purpose`
  / `## Gotchas`; `TEMPLATE.md` is enforced only by prompt text (`kb_recipe_prompt.md:17-19`).
- **No semantic check.** `hw_kb/cuda/sm100/smem_traffic_triage.md:33-34`: "the machine check does not
  verify this (prose is hard to lint); it is enforced by the distill obligations and by comparison
  with this recipe."
- **No paraphrase detection.** `docs/kb-harvest.md:60-62`: "**a narrated paraphrase without proper
  names gets past the lint, and only a human reader catches it** — that is the blind spot of this
  review axis."
- **No causality check.** `docs/kb-harvest.md:45-46`: "A recipe's only gate is **a probe written by the
  same agent** — it shows the mechanism runs on the GPU, not that the recipe belongs in the knowledge
  base."

### 2.4 How provenance is recorded

`docs/kb-provenance/README.md` — the split is by **reader**, not by topic (`:29-34`):

| Where | What | Readers |
|---|---|---|
| `hw_kb/<language>/<arch>/<entry>.md` "Sources" | certification status, probe path, official-doc links, **API symbols** of public infra | student + people (`:33`) |
| `docs/kb-provenance/<entry>.md` (`docs/kb-provenance/cuda/` for the CUDA KB) | where in the reference implementation it came from (file / function / line), paraphrased content, the reference's measured footprint, the experiment narrative | people only (`:34`) |

The rationale (`:23-27`): an exact public-repo symbol "is also a retrieval key into the base model's
pretraining memory, with more bandwidth than any paraphrase. Blackbox mode's premise that the
reference cannot be read would no longer hold." And the sharp edge of the definition (`:36-38`): a
**tool's** symbols may be cited (cutlass / CuTe DSL / quack / PTX instruction names); the
**reference solution's** may not.

What writes there (`:40-51`): recipe certification (`meta/kb_recipe_prompt.md:23-27`); the end-of-run
write-up or `forge harvest` (`docs/kb-harvest.md:38-41`); and `gaps/<op>.md`, the gap queue of
`VERIFY none` rows, mechanically generated by the driver, which "**never enter the knowledge base**
(neither as a `[pending certification]` slot nor as a placeholder row)" (`:45-51`).

Operational details that matter:
- "**This directory is not subject to the lint** — it is where that content is meant to live" (`:67`);
  `lint_kb_dir` only walks `kb_dir.rglob("*.md")` (`kb_lint.py:333`).
- A file here has **the same name as the entry it backs** (`:60`); the two KBs map to one provenance
  root with a `cuda/` subdir so a shared entry name keeps one provenance file per KB
  (`lang_mode.py:40-43`).
- `{PROVENANCE_DIR}` is injected as an **absolute path** on purpose: "your cwd is the student
  workspace, and a relative path would write the archive into a tree the student can read and that
  the kbprobe branch force-pushes" (`meta/kb_recipe_prompt.md:22-25`; binding at `driver.py:687-690`).
- The directory is in **no** agent read set: "the student's L0 readable list holds only the knowledge
  base itself, and the teacher's inputs do not include it either" (`README:3-5`).
- **In this release it holds only the README** — the shipped entries' provenance records and
  certification probes are not included (`:7-10`). Every template/prompt still says "the probe is not
  included in this release" (e.g. `hw_kb/cuda/sm100/elect_one.md:3`).

### 2.5 The gap between KB and repo (why `harvest.py` exists)

`src/forgekernel/loop/harvest.py:1-20`: the teacher writes recipes into the **main repo working tree**,
but "every git call the driver makes is scoped to the student workspace (`RealBackend` runs `git -C
<workspace>`)", so a certified recipe "survives only as a dirty file, and an unattended run drops it
the moment someone checks out another branch in that clone." Two cheap guards:

- `kb_blockers(root, kb_dir)` (`:85-94`) → non-empty list blocks a start (exit 3,
  `docs/kb-harvest.md:26-31`), so run N+1 cannot bury run N's recipes.
- `format_report` (`:64-78`) lists leftovers at run end with **absolute** paths —
  "`_repo_root()` follows the installed package rather than the cwd and the tree that received the
  recipes is not always the one being watched" (`:17-20`).

Plus `forge harvest .artifacts/<op>_<id>` for a run that never reached its finish (`docs/kb-harvest.md:38-41`).

### 2.6 Skills

`src/forgekernel/skills/__init__.py` is unrelated to `hw_kb` mechanically: it makes `skills/` an
importable package so the harness can `from forgekernel.skills import sass_tools` (`:1-11`) and mirrors
every `skills/<name>/` into `<workspace>/.claude/skills/<name>/` at `MIRROR_RELPATH =
.claude/skills` (`:22`, `mirror()` at `:30-40`), replacing whatever a previous turn left. It is the
**counter-example** to the KB's design: skills are per-workspace copies of scripts, the KB is a single
shared tree with an enforced single-tree read set (§3). `skills/` is however an exam surface for the
narrative lint (`kb_lint.py:348,350`).

---

## 3. How the KB is consumed

### 3.1 Where the prompts send the agent

- `meta/student_prompt.md:3`: "You read only the **milestone** (a natural-language decision graph) +
  the **hardware knowledge base (KB)**; you **never** look at the original operator's source".
- `:7`: "**You cannot see "the answer"**: you compose the performance-optimized implementation
  yourself from the milestone's decisions. When you do not know how to use a hardware interface, look
  it up in the KB."
- `:11` is the binding: `KB_DIR = {KB_READ_DIR}` — "operator-agnostic hardware-interface examples…
  This is this architecture's (`{KB_ARCH}`) own tree; **its entry point is its `index.md`**. Other
  architectures' trees are not in your read set — their readings were taken on other hardware and are
  not conclusions for this architecture."
- Restated as an action at `:46` (step 3): "When you do not know how to use a hardware primitive, look
  it up in `KB_DIR`."
- The continuation round re-injects the freshly certified recipe by name — `driver.py:938`:
  "A new KB recipe was just certified into the KB: `{ctx.fresh_recipe}`, for the…".

The teacher side gets the same tree with an explicit template and listing (`kb_recipe_prompt.md:12`:
"The template is `{KB_DIR}/TEMPLATE.md`, the listing is `{KB_DIR}/{KB_ARCH}/index.md`"), and the
write-side prompts register every new recipe in that `index.md` (`kb_recipe_prompt.md:47`,
`kb_harvest_prompt.md:50-51`).

### 3.2 Scoping by language + arch

Three independent selectors, one enforcement point:

- **Language → mode**: `lang_mode.py:36` `CUDA_LANGUAGES = frozenset({"cuda-sol"})`; `mode_of()`
  (`:49-51`) returns `cuda` for `cuda-sol` and `cutedsl` for **anything else**. `KB_ROOT = {MODE_CUTEDSL:
  "hw_kb/cutedsl", MODE_CUDA: "hw_kb/cuda"}` (`:39`); provenance subdir and prompt overlay follow the
  same dict (`:43-44`).
- **Arch → tree**: `kb_read_dir(ctx) = Path(ctx.kb_dir) / ctx.kb_arch` (`driver.py:645-661`). The
  docstring states the whole design: "hw_kb/ is one tree per architecture with no shared root. A
  hardware recipe earned on one architecture is not evidence about another — the MMA trunk, the
  register file it was budgeted against and the asynchrony it pipelines against all change — so the
  run gets its own tree and nothing else".
- **Enforcement**: `{KB_READ_DIR}` is rendered from *that same function* (`driver.py:684-687`), "so a
  prompt cannot name a tree the loop does not enforce"; and `KB:<entry>` lookup + the three lint gates
  + quarantine all go through it — "what the run may read and what is held to the leak rules are the
  same set by construction" (`driver.py:657-660`).

Fail-closed at launch: `EXIT_KB_ARCH_MISSING = 14` (`cli.py:2043`), `_kb_arch_problem` (`:2089-2107`)
refuses when `<kb_dir>/<arch>/` is absent or has no `index.md` — "Fail closed at launch, not at the
first `KB:` citation hours later" (`:2092-2095`), listing the trees that do exist.

Cross-tree contamination is handled by rule, not code:
- `hw_kb/README.md:14-16`: "The two language trees are independent: a reading certified with one
  language's probe is not carried over to the other."
- `hw_kb/cuda/README.md:14-22`: DSL entries are "**not copied over as they are** — their readings were
  taken on the DSL spelling. For the same mechanism to enter here, the example must be rewritten in
  CUDA and the readings re-taken on a CUDA probe… the DSL side's readings and conclusions are only
  hypotheses to be verified and must not be carried over."
- `hw_kb/cutedsl/README.md:34-42`: an entry belongs to a tree by **what it depends on**, not where it
  was written; arch-neutral entries are deliberately duplicated with a `Certification source` line.
- Within a tree, disagreement is resolved by authority: "where they disagree with the DSL side, this
  tree wins" (`hw_kb/cuda/sm100/index.md:14`).

### 3.3 How a lever / patch is traced to a KB entry

`KB:<entry>` is a first-class citation token, accepted in four positions:

| Position | Form | Source |
|---|---|---|
| Diagnosis locus | `deficient_locus: KB:<interface>` → routes the G3 fix | `meta/diagnose_prompt.md:162`; `kb_recipe_prompt.md:9` |
| Reopen price | `reopen_price: <±x.x%> via KB:<entry>` | `meta/diagnose_prompt.md:165`; `patch_prompt.md:106` |
| Gate-line price | `[PRICED: <delta>, <job N \| KB:<entry> \| ref-price>]` | `meta/distill_prompt.md:211-213`; `meta/cuda/patch_prompt.md:118-119` |
| Methodology reference | `hw_kb/cutedsl/{KB_ARCH}/ptx_escape.md` in the `[EXPR]` ladder | `meta/distill_prompt.md:206` |

Resolution of a `KB:` cite is `_verify_reopen_price`'s final branch (`driver.py:3252-3265`):

```python
name = re.sub(r"\.md$", "", name.split("/")[-1])          # basename only
if name in _KB_NOT_ENTRIES:                                # {"index","README","TEMPLATE"}
    return f"KB:{name} is not a recipe entry"
hit = next(kb_read_dir(ctx).rglob(f"{name}.md"), None)      # this run's arch tree only
if hit is None: return f"KB entry {name} not found under {kb_read_dir(ctx)}"
if not _KB_CERT_MARK.search(text):
    return (f"KB entry {name} carries no GPU certification (no PROBE PASS / [PRICED] / "
            f"job pointer) — a transcribed recipe is not a price")
```

`_KB_CERT_MARK` (`driver.py:3168-3169`):
`PROBE PASS|\[PRICED|GPU-certified|✅ Verified|probe_kb_|job\s*\*{0,2}\d{5,12}` — "Job ids are 5-7
digits on the Hopper pools and 10 on the Blackwell pool (the sm100 tree's KEEP-census entries cite
nothing else); the width matches `kb_lint._JOB_ID`" (`:3165-3167`).

So the full trace is:
`gate line / reopen price` → entry name → **must resolve inside `hw_kb/<language>/<arch>/`** → entry
text **must carry a certification mark** → the entry's `## Sources` names the probe path and contract
id → the probe file lives on the workspace `-kbprobe` branch (`driver.py:3527-3533`,
`docs/kb-harvest.md:64-66`: "the probe script is not in the knowledge-base directory… the next
certification overwrites it") → job id in the loop log, "the only place it is ever written"
(`driver.py:3540-3543`).

Two asymmetries worth naming for the gap analysis:
- **A KB cite is not staleness-checked.** A lever price read on another tree is refused —
  `_stale_price`: "a stale price is not a price for this tree; list it in `levers.json` again so the
  driver re-prices it here" (`driver.py:3267-3277`). A KB entry has no `best_ref` binding; it is
  treated as valid for any tree in its arch.
- **A KB cite is not gated on the entry being operator-relevant**, only on it being certified. The
  semantics rely on the diagnosis step (`diagnose_prompt.md:162`) pointing at the right entry.

### 3.4 What stops an agent inventing a mechanism that is not in the KB

Six distinct gates, none of them a whitelist over the student's code — the KB constrains **claims and
acceptance criteria**, not authorship:

1. **The teacher's hard rule.** `kb_recipe_prompt.md:59`: "**Operator facts are cited only from the
   ORACLE / official documentation**: assuming from memory a mechanism not in the inputs =
   contamination; stop." Harvest version, `kb_harvest_prompt.md:70-71`: "**Write only what has
   evidence**: every claim must point back to a probe verdict, a job log or a per-round commit
   message; adding from memory a mechanism not in the inputs = contamination; better to leave it
   out."
2. **Intake refusal.** Unverified recon rows "**must not** be written into `{KB_DIR}` as a
   `[pending certification]` pitfall, a `⏳` placeholder or in any other form — the KB's only entrance
   is a probe-certified recipe" (`kb_harvest_prompt.md:72-76`); they go to `gaps/<op>.md` instead
   (`kb-provenance/README.md:45-51`).
3. **The price gate.** Every `[VERIFY: sass-derived]` line entering a gate block must carry
   `[PRICED: …]` — "a shape is an acceptance line only once it has been priced; an unpriced one goes
   into the decision body as description" (`distill_prompt.md:211-213`). The three legal sources are
   `job N`, `KB:<entry>`, `ref-price`, and the driver machine-checks "that the source was really
   measured" (`diagnose_prompt.md:179`). A KB cite is only accepted if `_KB_CERT_MARK` hits (§3.3) —
   i.e. you may not launder an uncertified idea into an acceptance criterion by pointing at a file.
4. **Exclusion claims need a source.** "exclusion claims such as "can only come from smem" must have
   a `[MEASURED]` or hw_kb certification source" (`distill_prompt.md:141`).
5. **The expressibility ladder.** For a modifier/variant delta between oracle and student, the
   five-tuple must carry `[EXPR: A=…; B=…; C=…]`, and "**C may be written only after A and B have both
   been measured as none**" (`distill_prompt.md:202-206`), with rung B evidence defined as "the
   footprint counts after issuing the PTX per `hw_kb/cutedsl/{KB_ARCH}/ptx_escape.md`".
6. **No free-play on the student side** — not a KB check but the adjacent constraint:
   "**There is no free-play phase**: once every decision in the phase order is done, output
   `EXHAUSTED: <reason>`; **do not** invent decisions of your own to keep optimizing"
   (`student_prompt.md:43-45`). Uncited ideas have no decision slot.

The mechanism that does *not* exist: the student may write any hardware interface it likes; nothing
compares its code against the KB. The KB is a supply of evidence and triggers, not an allowlist. What
catches a fabricated mechanism is the **measurement** gate (probe verdict, gate line, dossier axis),
and the KB is what supplies the price when the measurement hasn't been run yet. That is the real
shape of the design and the thing worth copying.

---

## 4. Contrast in kind (not volume)

### 4.1 What a `hw_kb` entry asserts

Six separable claims, each with its own label:

1. **A mechanism exists and is spelled like this** — the code block, "from a verifiable source;
   nothing invented" (`cuda/TEMPLATE.md:13`).
2. **A trigger**: an observable that says "this applies now". Not a category — a reading.
   `mbarrier_wait_scope.md:29-31`: "In SASS, `SYNCS.PHASECHK.TRANS64.TRYWAIT` is immediately followed
   by `CCTL.IVALL` (one per wait point)"; `elect_one.md:24`: "a count / reduction result is exactly
   32× the right value (or 4× = one per warp)"; `pipeline_tma_umma_stage_count.md:69-72`: "the
   per-CTA cap is 232448 B… `cudaFuncSetAttribute(MaxDynamicSharedMemorySize)` accepts 232448 and
   refuses 232449".
3. **Numerics are unaffected or affected, stated as a bound.** `elect_one.md:105-109` five
   `max_diff=0.0` lines; `mbarrier_wait_scope.md:125-127` mixes `max_diff=n/a` (SASS-shape contracts)
   with `max_diff=0` (data contracts) — the type of each contract is visible in the line.
4. **A footprint, in same-job paired numbers with the pairing stated.**
   `mbarrier_wait_scope.md:54-56` (cycles, median): ring 424.5 / 424.5 / 426.6; ping-pong no-access
   106.1 / 106.1 / 107.1; ping-pong +8 L1 words **147.1 / 147.2 / **407.2****. Three spellings, three
   rows, one job — the 2.8× is readable without trusting the prose.
5. **A cost model / failure mode** — `## Gotchas`, each item naming what goes wrong *and* how you see
   it. `elect_one.md:87-90` is the negative list ("Which instructions must never be wrapped in elect…
   `tcgen05.alloc` / `dealloc` / `relinquish_alloc_permit`, `tcgen05.ld` / `st` / `wait::*`,
   `setmaxnreg`… undefined behavior (typically a hang). This entry's probe did not trigger this shape;
   the basis is the documentation."). `mbarrier_wait_scope.md:102-103` is the honest limit of a numeric
   probe: "**a probe cannot detect "used cta where cluster was required"**. Measured: downgrading…
   was still numerically right in all 3 repetitions; that only shows it did not go wrong this time on
   this machine, not that it is legal."
6. **The applicability condition and the ceiling.** `consumer_warpgroup_pingpong_parity.md:108-117`
   (`## Load-bearing conditions… this entry's readings are the side where it is **not**`), stating
   4 warpgroups, 512 threads, 1 CTA/SM, the MMA thread's per-round chain byte-for-byte identical, and
   then: "Under these conditions the two landings gave −0.38% / +1.09%, both within the noise floor
   (1.62%) of that tree's ablation: **doubling the consumer segment's thread count did not change the
   period**… if a later run wants to open it, first confirm on the timeline that the MMA thread is
   waiting on this segment's full / empty."

Plus a seventh, the strongest and least copyable: **the negative reading as a first-class artifact.**
`ring_depth_lever.md:138-145` devotes a gotcha to a lever that did not work — "gate window 0.435 →
0.4379 ms (**+0.67%, worthless**). Under this structure ring depth is not a lever…" — and says why it
is recorded: `:5-7` "one KEEP reading that was not load-bearing ("worthless" is itself a transferable
reading — so the next run does not make ring depth its prime suspect again)". Same pattern in
`pipeline_tma_umma_stage_count.md:79` ("measured S=12 is 7.7% slower than S=6… Depth is not "as deep
as fits"").

Confidence vocabulary in actual use across `hw_kb/**/*.md` (occurrence counts): `[EXPR` 623,
`[MEASURED]` 348, `[PRICED` 53, "uncertified" 55, `[INFERRED]` 30, `[UNVERIFIED-BOUNDARY]` 26,
"not priced" 15, `[to be checked]` 9. Two orthogonal axes: **how do we know** (`[MEASURED]` /
`[INFERRED]` / `[UNVERIFIED-BOUNDARY]`) and **who paid** (`[PRICED: … job N | KB:<entry> |
ref-price]`).

### 4.2 What a KernelWiki page asserts

From `pi-kernel-expert` metadata (no checkout exists at `~/.pi/agent/kernel-expert/cache`, so this is
the repo's own description, not the corpus):

- **A page id + one confidence label from a 4-value enum**: `verified`, `source-reported`, `inferred`,
  `experimental` (`CONTEXT.md:60-61`, "Wiki Citation").
- Cited as *page id + label*; tool contract: "Cite the page id and its confidence label; never present
  an inferred or experimental page as verified" (`extensions/pi-kernel-expert/tools/wiki.ts:99`).
- Retrieval is **natural-language search with filters, or fetch one page by id** (`wiki.ts:94-97`) —
  ranked by retrieval, not keyed by a diagnosed symptom.
- The corpus is upstream-owned: 1589 files, ~37 MB, pinned at `b6b4301f15e8…`, MIT for original
  material but "verbatim artifact bundles under `artifacts/` retain their upstream terms", 19 files
  `LicenseRef-NvidiaProprietary` pruned into `SANITIZED.yaml` (`THIRD_PARTY_NOTICES.md:22-36`;
  `docs/adr/0002-…:12-22`).
- The one hard rule already matches hw_kb's instinct: "**A Wiki Citation may support a direction or a
  diagnosis; it never supports a measurement**" (`CONTEXT.md:76`).

### 4.3 What the vendored `ncu-report-skill` asserts

- **Six analysis dimensions** with metric names and *thresholds*: "Waves / SM < 1: grid is too small";
  "Theoretical occupancy 100% but achieved << 100%: stalls are the bottleneck"; "Sectors per request…
  the ideal is 4 for 4-byte loads, 8 for 8-byte, 16 for 16-byte" (`05-analysis-dimensions.md:14-42,
  248-255`).
- **15 patterns A–O**, each with a fixed five-part shape: `Signals` / `Why` / `First-line fix` /
  `Deeper fixes` / `Exceptions` / `Cross-ref` (`06-diagnosis-playbook.md:9-19`), e.g. Pattern A at
  `:23-45`, Pattern B at `:49-72`.
- Ranking rule: "Rank them by magnitude using NCU's `Est. Speedup: X%` fields… **after checking each
  estimate against the counters it rests on**" (`:19`).

### 4.4 The structural differences

| Axis | `hw_kb` | KernelWiki | `ncu-report-skill` |
|---|---|---|---|
| **Producer** | the same loop that consumes it, from a probe in the same repo (`kb_recipe_prompt.md:37-51`) | upstream `mit-han-lab`, fetched at a pin (`THIRD_PARTY_NOTICES.md:24-26`) | upstream, vendored verbatim + `VENDORED.yaml` |
| **Write path in-repo** | yes: G3 → recipe → probe → certify → harvest | none; a correction is an upstream sync | none; "fix bugs upstream, then re-sync" (`THIRD_PARTY_NOTICES.md:17-19`) |
| **Evidence unit** | a `PROBE PASS max_diff=…` line + contract id + job number, re-runnable | a confidence label, unbacked in-repo | NCU counters, re-collectable only on *your* kernel |
| **What the label means** | **measurement status** ("we ran it; here is the norm") | **source trust** ("verified / source-reported / inferred / experimental") | none — the numbers are yours |
| **Verified vs load-bearing** | two labels, always separated (`✅ Verified` + `[UNVERIFIED-BOUNDARY]`; `Certification boundary` sections in 5 entries) | one label along one axis | one mode: diagnose from counters |
| **Failure modes** | mandatory `## Gotchas`, symptom-first, incl. silent-failure taxonomy | descriptive, upstream | `Exceptions:` per pattern, keyed to kernel classes |
| **Applicability** | `## Load-bearing conditions`, per structure, with the negative reading recorded | per page, implicit | per dimension, thresholds assume dense GEMM-ish kernels |
| **Negative results** | recorded as transferable knowledge (`ring_depth_lever.md:138-145`) | n/a | n/a |
| **Arch keying** | enforced by directory + read set + exit 14 (`lang_mode.py:39`, `cli.py:2043`) | one corpus, pinned revision; arch mismatch handled by an ADR note (`docs/adr/0003-…:9`: material is Blackwell-first, verification target is sm90) | metric table is Blackwell-specific (`adr/0003:9`) |
| **Read path** | `index.md` "Look up by symptom first (this section is the entry point, not a table of contents)" — 64 rows `cuda/sm100/index.md:17-87`, 74 rows `cutedsl/sm100/index.md` | NL search + page id (`wiki.ts:96-99`) | six dimensions in a fixed order, then a pattern table |
| **Scope discipline** | operator-agnostic hard rule + no-reference-symbols rule, both in the same file (`cuda/TEMPLATE.md:21-38`) | not applicable (no reference solution to protect) | not applicable |
| **Provenance** | split by reader into two layers, one of them not in any agent read set (`kb-provenance/README.md:29-34`) | one layer, upstream | one layer, upstream |
| **Numbers** | same-job paired, pairing structure stated | not carried | reference thresholds (148 SMs on B200) |
| **Cost of a wrong entry** | contaminated training signal for every later operator's student (`docs/kb-harvest.md:52-54`) | an upstream bug, fixable by pin bump | a wrong fix direction on one kernel |

The single sharpest structural difference: **`hw_kb` separates "the mechanism works" from "the
mechanism pays", and records both.** `index.md` cells say `certifies only SASS, not the gain`
(`cuda/sm100/index.md:108`), `certifies only the spelling and numerics` (`:118`), `not the gain`
(`:131-132`). A vendored corpus cannot do this because it never ran the mechanism on your machine;
a diagnosis playbook cannot do this because it never ran *any* mechanism — it only observed counters.

---

## 5. Portability into a pi extension

### 5.1 What survives unchanged

1. **The KB directory shape.** `kb/<language>/<arch>/index.md` + `<entry>.md`. Pure markdown, zero
   runtime. `index.md` as the *symptom table* is the highest-value single artifact: it converts
   retrieval into lookup. Port `## Look up by symptom first (this section is the entry point, not a
   table of contents)` verbatim as a contract (`cuda/sm100/index.md:17`).
2. **The five-section schema** (`cuda/TEMPLATE.md:5,8,11,18,21`) + the rule that a trigger must be an
   observable, not a category.
3. **The lint, as a deterministic TS module.** ~455 L of Python, no dependencies beyond regex + AST:
   - Rule 1 banned words with ASCII-only boundaries (`kb_lint.py:66-76`) — trivially portable, and the
     CJK-adjacency reasoning (`:18-21`) applies to any agent that might write Chinese prose.
   - Rule 2 reference tokens, static list + `derive_reference_tokens` (`:128-224`). The derivation
     generalizes past ForgeKernel: "derive tokens from whatever corpus/board you consider the answer"
     (file basenames + stems + `def`/`class`, ≥6 chars, stoplist, 500-file cap).
   - Rule 3 line-ref-without-whitelisted-source with the per-line-not-per-block scoping
     (`:228-256`) — the whitelist becomes `docs.nvidia.com | PTX ISA | cutlass | kb/ | probe`.
   - Rule 4 narrative patterns (`:262-273`) + Rule 5 job-id policy (`:277`).
   - Rule 6 fail-closed on a missing tree (`:336-337`).
   - Rule 7 exam-surface walk (`:374-435`) → "lint every prompt template the extension ships".
4. **The provenance two-layer split** as a directory convention: `docs/kb-provenance/<entry>.md` outside
   every read set, same basename, not linted (`kb-provenance/README.md:29-34,60,67`).
5. **The `PROBE PASS` format contract** (`kb_recipe_prompt.md:32-35`): one line per contract, a real
   finite error norm ≤ `1e3`, `n/a` for non-numerical, no bare PASS, no bitmask, all must pass. This is
   a *parsing* contract — a pi extension can enforce and record it even when it cannot execute it.
6. **The `KB:<entry>` citation token + `_KB_CERT_MARK`** (`driver.py:3168-3169, 3252-3265`). ~15 lines.
   It is the cheapest piece with the biggest behavioural effect: a doc citation becomes a *resolvable
   pointer* that is **refused** unless the target text carries evidence of certification. Port this
   even if nothing else.

### 5.2 What breaks, and why

| ForgeKernel dependency | pi extension reality | Effect |
|---|---|---|
| **GPU probe runner** (`be.submit_gpu(...)`, `driver.py:3538`) | none | The `PROBE PASS` gate has no executor. Certification class 1 collapses to "trust the author"; class 2 (KEEP dossier census) also dies, because it needs a per-iteration NCU job + a per-axis diff — pi-kernel-expert has report *analysis* helpers (`helpers/analyze_reports.py`, `extract_stall_hotspots.py`) but no per-iteration census ledger. |
| **Long-lived loop** with `max_probe_rounds` and a status ledger | a session, no `status.jsonl`, no iter numbering | Both harvest triggers evaporate: kb-tripwire needs "≥ N GPU rounds on one probe" (`kb_harvest_prompt.md:3-7`); contract-axis needs "a KEEP that changed a dossier axis in this iteration" (`:9-15`). The KB then only grows by hand. |
| **`kb_blockers` start gate** (`harvest.py:85-94`, exit 3) | no run start | No mechanism forces human review of unreviewed entries; the pile grows silently. The substitute is a review checklist run as a command, i.e. weaker. |
| **`-kbprobe` branch + workspace reset** (`driver.py:3495-3533`) | no reset, no side branch | Probe scripts either pollute the repo or are lost. `docs/kb-harvest.md:64-66` ("the next certification overwrites it") has no analogue. |
| **Three lint gate points** (start / certify / harvest) | hooks exist (tool-call interception, session events) but the **two-strike protocol** ("bounce for revision first, quarantine if it still fails") is a driver loop, not an API | You can block a write; you cannot run the bounce. Quarantine-by-move (`driver.py:3459-3467`) becomes a manual step, so the fail-safe is weaker. |
| **`[PRICED: <delta>, <job N \| KB:<entry> \| ref-price>]`** (`distill_prompt.md:211-213`) | no ledger, no lever price table, no `ref-price` run | "Priced" has nowhere to come from. The gate becomes unenforceable or decorative — and a decorative price tag is worse than none, because it looks like evidence. |
| **`_stale_price`** (`driver.py:3267-3277`) | no `best_ref` chain | Even the KB's own (weaker) staleness story disappears. |
| **The B200/sm100 numbers in the shipped corpus** | pi-kernel-expert's verification target is sm90, and its own ADR names the mismatch (`docs/adr/0003-…:9`) | Porting entry text with its readings is exactly what `hw_kb/cuda/README.md:14-22` forbids: "the DSL side's readings and conclusions are only hypotheses to be verified and must not be carried over". A ported entry without a re-run is, **by the KB's own rule**, a hypothesis. |
| **`derive_reference_tokens` needs a resolved oracle tree** (`kb_lint.py:145-166`) | no oracle | Rule 2 degrades to the static list. Must be written down as a degradation, not discovered later (`kb_lint.py:176-188` is the model: report the missing path loudly). |

### 5.3 What a minimal honest version looks like

Six artifacts, no GPU, no loop:

**(a) `kb/<arch>/index.md` — the symptom ledger.** Columns: symptom (an observable) | entry | status.
Status vocabulary reduced to three values, each with an invariant:
`✅ MEASURED <gpu> <date>` / `🟡 UNVERIFIED — <what is missing>` / `⬜ TODO`.
Port the "Look up by symptom first… this section is the entry point, not a table of contents" heading
as a literal contract.

**(b) `kb/<arch>/<entry>.md` — the five sections**, plus two mandatory additions the ForgeKernel
template lacks but every real entry grows:

- a `>` header block with `**Certification: …**` and an explicit `**Uncertified**: …` sentence
  (`hw_kb/cuda/sm100/elect_one.md:3-7` is the model);
- `## Certification boundary` bounding the claim (`cutedsl/sm100/consumer_warpgroup_pingpong_parity.md:191-194`,
  `cutedsl/sm90/wg_exchange_face_mbarrier.md:35`), even when the boundary is "we never ran this".

**(c) `lint.ts` — rules 1–5 + fail-closed**, run as a pre-write hook on any path under `kb/`, plus the
exam-surface walk over the extension's own prompt templates. Stage: banned words → reference tokens
(static list; derive from a vendored corpus if one is pinned) → line-refs without a whitelisted source
→ narrative patterns + job-id policy → missing directory. Keep the two narrowing decisions: per-line
not per-block whitelisting, and `probe_`/`notes/` as path forms rather than the bare word.

**(d) A citation tool, `kb_cite(entry)`**, that emits the citation **only if** the entry text matches
the certification mark regex. Port `_KB_CERT_MARK` nearly verbatim, and return the same refusal class
of message: "carries no GPU certification — a transcribed recipe is not a price". Without the probe
runner this is the last place the honesty boundary can be enforced mechanically, so it must be a tool
the agent calls, not a convention in a prompt.

**(e) A harvest substitute that costs one turn.** No trigger, just a command:
`/kb-harvest <dir>` → "for each lesson in this session, decide generalizes / does not; if it
generalizes write the recipe with knob + footprint + load-bearing condition; if the evidence is a
session reading and not a probe, the entry status is 🟡 and the boundary says so." Keep the two
ForgeKernel phrases that carry the most weight per word:
"worth X% under <this structure>, not a universal percentage" (`kb_harvest_prompt.md:61-63`) and
"worthless is itself a transferable reading" (`ring_depth_lever.md:5-7`).

**(f) A review checklist** replacing the quarantine: the two axes from `docs/kb-harvest.md:48-62` —
operator-agnostic (a mechanism, not an algorithm), and source-pointed-not-paraphrased — plus the one
they admit is un-lintable: "a narrated paraphrase without proper names gets past the lint, and only a
human reader catches it".

**Deliberately drop:** the `[PRICED]` gate, the KEEP-axis evidence class, the three gate points,
quarantine-by-move, `_stale_price`. Each needs the loop; keeping a crippled copy teaches the agent
that a price tag can be decorative.

**Deliberately keep, even with no GPU:** the `Certification source` line on every transcribed or
vendored entry — including when it reads "not re-checked". `hw_kb/cutedsl/README.md:41-42` gives the
reason and it is the whole portability thesis in one sentence: "**location is not provenance — that
line is**."

**One thing not to port at all: the numbers.** A vendored corpus's value in pi-kernel-expert is
`page id + confidence label` → a direction. That is already the right epistemic level
(`CONTEXT.md:76`: "A Wiki Citation may support a direction or a diagnosis; it never supports a
measurement"). What `hw_kb` adds is not more confidence labels — it is a **second tier of entries that
carry their own norm, their own footprint, and their own boundary**, produced locally. A port that
copies entry *text* without that tier produces a KB that looks like `hw_kb` and behaves like a wiki.

---

## The 5 KB mechanisms `pi-kernel-expert` most lacks

Ranked by "how much of the missing behaviour each one restores per line of code".

1. **The symptom-indexed read path.** `index.md`'s "Look up by symptom first (this section is the
   entry point, not a table of contents)" (`hw_kb/cuda/sm100/index.md:17-87`, 64 rows; 74 in
   `cutedsl/sm100`) maps *an observable you just saw* → *the entry*. KernelWiki exposes NL search +
   page fetch (`wiki.ts:94-99`) — retrieval ranked by similarity, which returns what is
   *about* your symptom, not what *fixes* it. The index row is the difference between "read this" and
   "these are the readings that mean this applies".
2. **The certification header split: "the mechanism works" vs "the mechanism pays".** Every real entry
   opens with `**Certification source: …**` + `**Certification covers: …**` +
   `**Uncertified**: …` (`elect_one.md:3-7`), and 5 entries carry a full
   `## Certification boundary [UNVERIFIED-BOUNDARY]` section. `pi-kernel-expert` has one confidence
   axis (page label) and one evidence rule ("never supports a measurement") — correct, but it has no
   *second* tier to put measured material into, so the rule can only ever subtract.
3. **Load-bearing conditions plus the recorded negative reading.** `hw_kb` entries state the structure
   under which the lever carries load and record the reading where it did not:
   "−0.38% / +1.09%, both within the noise floor (1.62%)… **doubling the consumer segment's thread
   count did not change the period**" (`consumer_warpgroup_pingpong_parity.md:114-117`);
   "+0.67%, worthless… so the next run does not make ring depth its prime suspect again"
   (`ring_depth_lever.md:138-145`). `ncu-report-skill`'s 15 patterns all end in a fix; none records
   "this fix was measured null on this structure". That is the difference between a playbook and a KB.
4. **`[PRICED: <delta>, <job N | KB:<entry> | ref-price>]` + `_KB_CERT_MARK` — a citation that can be
   refused.** The rule (`distill_prompt.md:211-213`) makes "unpriced" a legal state (description, not
   acceptance criterion), and the resolver (`driver.py:3168, 3252-3265`) refuses a `KB:` cite whose
   target text lacks `PROBE PASS|[PRICED|✅ Verified|job N`. Together: *you may not promote an idea to
   an acceptance criterion by pointing at a file*. `pi-kernel-expert` has the vocabulary
   (`Noise Floor`, `Profile Evidence`, "stale evidence is not evidence", `CONTEXT.md:12-19`) but no
   resolver — a `Wiki Citation` is never machine-checked against its own label.
5. **The provenance split enforced by a deterministic, fail-closed lint.** Two layers keyed by reader
   (`kb-provenance/README.md:29-34`), one of them outside every agent read set, with 5 regex rules +
   a fail-closed missing-directory finding (`kb_lint.py:60-337`) and the reason spelled out: an exact
   symbol "is also a retrieval key into the base model's pretraining memory, with more bandwidth than
   any paraphrase" (`:23-27`). `pi-kernel-expert` vendors two corpora with no leak lint at all — it
   relies on license hygiene (`THIRD_PARTY_NOTICES`, `SANITIZED.yaml`) and has nothing that stops an
   agent writing "as in `<upstream-file>.py:412`" into a skill or a plan.

Runner-up, if a sixth is wanted: **the fail-closed KB tree resolution** — `EXIT_KB_ARCH_MISSING = 14`
and `_kb_arch_problem` refusing to launch when `<kb>/<arch>/index.md` is absent (`cli.py:2043,
2089-2107`), because "Fail closed at launch, not at the first `KB:` citation hours later".
