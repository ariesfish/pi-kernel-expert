# ForgeKernel — methodology and product surface (dense note)

Source read: `ForgeKernel/` at the state below. All citations are `path:line` relative to
`/Users/ariesfish/Projects/github/dev-skills/ForgeKernel/` unless absolute.

Read in full: `README.md`, `README_zh.md`, `meta_milestone.md` (700 lines), `docs/milestones-template.md`,
`docs/design/milestone-distillation.md`, `docs/design/v1-launch.md`, `docs/blackbox-mode.md`,
`docs/safeguard-refusals.md`, `docs/correctness-monitor.md`, `docs/leaderboards.md`,
`docs/kb-harvest.md`, `docs/kb-provenance/README.md`, `meta/verdict_probe_brief.md`,
`meta/m0_audit_prompt.md`, `meta/distill_blackbox_prompt.md` (+ `meta/student_prompt.md`,
`meta/diagnose_prompt.md`, `meta/recon_prompt.md` for the role text they define),
`scripts/self_evolve.py`, `scripts/claude-goal.sh`, `scripts/agent_policy_hook.py`,
`scripts/blackbox-guard.sh`, `pyproject.toml`, `src/forgekernel/__main__.py`,
`src/forgekernel/launch.py`, `src/forgekernel/baseline_cli.py`, `src/forgekernel/scaffold.py`,
`src/forgekernel/task.py` (config layering), `src/forgekernel/taskcard.py` (generated `loop.toml`),
`src/forgekernel/loop/agent_policy.py`, `src/forgekernel/milestone.py`, `src/forgekernel/runs.py`,
`src/forgekernel/loop/parse.py` (plateau), `global_config/*.toml`.

**README vs README_zh.** The Chinese file is a near-verbatim translation (same sections, same
numbers, same claims). The only shifts are claim strength and pointers: EN "A reference helps most"
(`README.md:297`) becomes "有参照时效果最好" (`README_zh.md`, Limitations); EN "matches or beats"
(`README.md:24`) becomes "追平或超过"; the zh install prompt names `README_zh.md` instead of
`README.md`. No methodological divergence — for a gap analysis, cite the English README and the
`docs/` corpus. The real content is in `meta_milestone.md` + `docs/`.

---

## 1. The methodology in one page

### 1.1 What the loop actually asserts

Five assertions, in increasing strength:

1. **Operational equivalence** (the measurable claim): "on the same hardware and the same test cases,
   an agent that cannot see the reference's code reproduces the reference's correctness and
   performance from the milestone" (`docs/design/milestone-distillation.md:19-21`). Performance is a
   threshold/ratio, not an exact reproduction.
2. **The milestone is a performance-equivalent natural-language rendering of the operator**
   (`docs/design/milestone-distillation.md:12-14`) — not "the code written as prose". A milestone is
   "the structure of the optimization path", decomposed into locally easy decisions in dependency
   order (`meta_milestone.md:16-24`).
3. **Decisions are the transferable representation.** Architecture decisions and parameter values
   may be given; implementation bodies may not (`meta_milestone.md:328-346`). The invariant is
   one sentence: "**give 'contracts' and 'decisions', not 'implementation bodies'**"
   (`meta_milestone.md:346`).
4. **The ceiling moves.** Every accepted kernel becomes the next run's reference, so the chain must
   beat its own last answer, not a fixed library (`README.md:55-60`, `scripts/self_evolve.py:1-21`).
5. **Hardware mechanisms transfer across operators.** A probe-certified mechanism goes into an
   operator-agnostic KB (`hw_kb/`) and is prescribed to later operators
   (`docs/design/milestone-distillation.md:7-9`, 39-45).

What is *not* asserted: that the loop finds the global optimum; that a plateau is proof of one
(`README.md:300-302`); or that an architecture can be written from nothing (the ablation stalls
without a reference, `README.md:297-299`).

### 1.2 Stage by stage, and what each stage buys

| # | Stage | Actor / artifact | What it asserts, concretely | What it buys | Evidence |
|---|---|---|---|---|---|
| S0 | Task definition | user writes `tasks/<op>/{task.toml,description.md,shapes.json,[inputs/],[reference/]}` | the problem, not the process | a run cannot silently re-scope the problem; runs are comparable | `docs/design/v1-launch.md:15-19`, `:21-22`; `src/forgekernel/launch.py:87-140` |
| S1 | Judge | teacher writes `check/{definition.json,judge.py,groups.json}` from `description.md` **alone**; compared with the reference on GPU; ≤3 attempts | an exam that is independent of the answer and that the reference itself passes | correctness is not self-graded; a wrong judge cannot be absorbed into tolerance (match cap 5%) | `docs/design/v1-launch.md:223-247`, `:446-449`; `src/forgekernel/judge.py:39` |
| S2 | Reference measurement | harness, one reference, every run | one number, measured on this machine, with NCU signature when available | target = ref/ratio, anchored to a real reading, not a default | `docs/design/v1-launch.md:262-277`; `src/forgekernel/baseline_cli.py:1-20` |
| S3 | Recon | teacher + GPU probes (NCU, SASS, live ranges, residency, inter-kernel ledger) | the reference's *structure* as measurements/inferences with confidence | distillation has facts, not vibes; blackbox mode still has facts | `meta/distill_blackbox_prompt.md:6-10`; `meta/recon_prompt.md:1-30` |
| S4 | Distillation v1 | `operators/<op>/milestone.md` per `POLICY §9` | a DAG of five-tuple decisions, M0→Mk, gates with typed lines | a curriculum a low-capability agent can climb; machine-checkable | `meta_milestone.md:445-460`; `src/forgekernel/milestone.py:249-683` |
| S5 | M0 gate + M0 audit | gate row + a mandatory separate teacher audit | "did the student build what the milestone says" **and** "was the milestone drawn correctly" | the foundation is checked structurally before hours are stacked on it | `meta/m0_audit_prompt.md:5-13`; `docs/milestones-template.md:124-133` |
| S6 | Inner loop | student, one decision/bundle per commit; one GPU job judges + times + profiles | one local move, measured; correctness failure = hard REVERT; perf regression allowed only at noise/companion-group level | cheap, attributable moves; build-phase commits are `NEUTRAL`, not fake readings | `README.md:143-160`; `meta_milestone.md:118-135` |
| S7 | Outer loop | teacher diagnoses (G/R classes), patches the milestone; prefix reuse | the milestone is the object being optimized; the student's failures become data | plateau/`EXHAUSTED` is a *defect of the curriculum*, not license to improvise | `meta_milestone.md:404-443`; `docs/design/milestone-distillation.md:4.1-4.4` |
| S8 | Finish | repeated confirmation, correctness monitor, KB harvest, report | the best kernel is confirmed on re-measurement; out-of-distribution behaviour is recorded | a single lucky reading cannot declare success; KB growth is reviewed, not auto-committed | `docs/correctness-monitor.md:51-67`; `docs/kb-harvest.md:27-40` |
| S9 | Self-evolution | script creates `tasks/<op>-g<k>/` with the best kernel as reference | each generation must beat the last by more than its own noise | the bar moves past the expert library; the stop is measured, not chosen | `scripts/self_evolve.py:1-21`, `:50-76`, `:105-118` |

Each stage has a refusal attached (see §3). That is the design: a stage is not "advisory" — it either
produces a measured fact or it stops, and the stop is named.

### 1.3 "Architecture-first" vs "tune-a-kernel"

ForgeKernel is not a kernel tuner. The distinction is *what is frozen and when*.

| | Architecture-first (ForgeKernel) | Tune-a-kernel (the thing it replaces) |
|---|---|---|
| Unit of work | a decision with a trigger, cost and dependency (`meta_milestone.md:48-84`) | a parameter value, or a candidate implementation |
| First milestone | **M0 delivers the final architecture** — kernel split, dataflow/stationarity, intermediate ABI, precision contract, tile, warp roles, register budget, smem layout + access atoms, issue order + live-set budget (`meta_milestone.md:92-135`; `docs/milestones-template.md:54-134`) | a naive version, then search |
| What is tunable | only **levers** (stage count, swizzle mode, `wg_wait` depth), given as starting values, planned as M1+ decisions, measured round by round (`docs/milestones-template.md:190-307`) | everything, at any time |
| Freeze | signature + topology contract frozen at M0 PASS; "M1+ must not modify it" (`docs/milestones-template.md:128-131`; `meta_milestone.md:172-173`) | no freeze; retile whenever |
| When a ceiling resists | "M0 was written wrong" → go back and amend M0, with a mandatory trigger: lever domain fully swept + gate still short + reference uses the losing candidate ⇒ coupling, not a knob (`meta_milestone.md:310-318`; `docs/milestones-template.md:368-373`) | sweep harder, or rewrite |
| Evidence that a mechanism landed | a mechanism-verification line anchored to the reference's measured signature, not the end-to-end number (`docs/milestones-template.md:400-417`) | the number went down |
| Explicit anti-pattern | "**Do not write a naive phase** … M0→M1 is necessarily a full rewrite; worse, it leaves the driver's KEEP/REVERT ratchet spinning idle" (`meta/distill_blackbox_prompt.md:194-196`) | naive → optimize is the plan |

Why the freeze is claimed to be right, not just tidy:

- The topology is where the **global ceiling** is set; levers are "scalar/enum values inside an
  established topology" (`docs/milestones-template.md:289-304`). Changing topology late = retrofitting:
  "by retrofit time the overlap graph is saturated, the resident quantities no longer fit → spill
  explodes → it can never land" (`docs/milestones-template.md:303-307`).
- The cost of changing milestone *d* ≈ the inner work stacked on it, so the foundation must be right
  early (`docs/design/milestone-distillation.md:4.3`).
- Single-variable readings can be actively misleading: the granularity-coupling exception says a
  stage-count sweep with unchanged consumer granularity has "**zero evidential weight**"
  (`meta_milestone.md:96-112`).
- Access atoms are "a cliff, not a knob": pinning swizzle without pinning the atom is a void
  contract (`docs/milestones-template.md:203-206`).

The honest weakness, stated by ForgeKernel itself: in blackbox mode the architecture is an
inference, and **architecture-conformance lines check against the values the milestone itself
declared**, so they verify obedience, not inference (`meta/distill_blackbox_prompt.md:100-110`,
`:270-274`). A wrongly inferred architecture is only exposed by the performance line, after
"a dozen-plus rounds". That is the load-bearing risk of architecture-first, and the reason for the
confidence discipline (`meta/distill_blackbox_prompt.md:76-100`).

---

## 2. Deny list / information barrier

### 2.1 Who may see what

| Mode (decided by what the task gives) | Teacher | Student | Evidence |
|---|---|---|---|
| `source` (`[reference].source` + `run`) | reads the source + hardware behaviour | cannot read it | `docs/design/v1-launch.md:180-187` |
| `blackbox` (only `run`, or `blackbox = true`) | may run, time, profile, disassemble; **not read source** | same | `docs/blackbox-mode.md:1-9`; `docs/design/v1-launch.md:180-187` |
| no reference (`generate`) | judge written first; `/goal` writes the reference independently; teacher does not read the generated source | cannot read it | `docs/design/v1-launch.md:190-202` |
| leaderboard | the board's judge/inputs/clock; the reference may be a sealed solution | same | `docs/leaderboards.md:5-6`; `docs/design/v1-launch.md:248-260` |

The teacher's read set is a superset of the student's in source mode only. In blackbox and generate
mode both are denied the source; the difference is that the teacher got a *measured* recon report.

### 2.2 What exactly is denied, and who derives it

The list is **derived by the harness**, not written by the user. The user can only add
(`[reference].deny`), never remove (`docs/design/v1-launch.md:215-219`).

`src/forgekernel/launch.py:330-351` (`deny_paths`) appends, in order:

1. `task.reference.run_file.parent` — wherever the reference callable lives;
2. `task.reference.source` — the reference source tree, when given;
3. `<run snapshot>/reference` — the run's own copy of the source;
4. every path in `[reference].deny` (user additions);
5. for a leaderboard task: the frozen card's parent (which carries the sealed reference **and its key**)
   and the snapshot's board dir (the recon tree);
6. **every other run directory** under `.artifacts/` — so two runs cannot read each other's answers.

The result is written into the operator tree's generated `loop.toml` as `ref_source_paths` /
`ref_source_urls` (`src/forgekernel/taskcard.py:290-312`, esp. 307-308), which is what the agent
policy and the hook consume. The user never writes `loop.toml` (`docs/design/v1-launch.md:397-412`,
Appendix A.2).

### 2.3 How it is enforced — four layers, each with a different strength

1. **Claude Code project settings, rewritten before every turn** (`src/forgekernel/loop/agent_policy.py:1-60`):
   `permissions.deny` removes `WebFetch`/`WebSearch`, refuses `Read`/`Edit` on every denied path, and
   refuses network-shaped Bash prefixes; deny rules "hold under `--dangerously-skip-permissions` and
   inside subagents" (`agent_policy.py:24-29`). Writes are role-scoped: student only its workspace,
   teacher the run repo; both are denied editing `.claude` and the hook (`:261-266`).
2. **The Bash sandbox** — the actual boundary: `filesystem.denyRead` stops `python3 -c "open(...)"`,
   `deniedDomains=["*"]`, `WebFetch(domain:*)`, and `failIfUnavailable: True` so a sandbox that cannot
   start stops the agent instead of running unsandboxed (`agent_policy.py:30-42`, `:269-284`).
3. **The PreToolUse hook** (`scripts/agent_policy_hook.py`) — a named refusal instead of an opaque
   sandbox error, and the web side for a blackbox teacher that keeps the network. It is explicitly
   "**a tripwire, not a boundary**" (`agent_policy_hook.py:14-24`); it normalises `:` to `/` and
   lowercases, matches `org/repo` and package-name fetches (`:36-52`, `:96-116`), and if the policy
   file is unreadable it **denies** (`:171-177`). Refusal texts are named: `BLOCKED by the
   ForgeKernel agent policy: …` with the rule and the role (`:126`, `:131`, `:138`, `:147`).
4. **The in-job guard** (`scripts/blackbox-guard.sh`), for the GPU machine, where the policy hook is
   not present. It is seeded into the reference tree's `notes/` and sourced by `gpu_entry.sh`; the
   `cmd` task scans the command string **and every `notes/*.py|*.sh`, cumulatively**, and exits 3 on a
   hit (`:31-33`, `:108-139`). The base forbid list is the sealed blob, key, unsealer, module object,
   `getsource`/`linecache`/`sys.modules[...]`, JIT caches, `--print-source cuda`, the upstream repo
   names, and shell hex/strings tools (`:61`). Refusal text names the boundary and the fix
   (`:138-139`): "this run treats the reference as a closed binary — do not read, locate or unseal
   the reference kernel source … Drive the reference only through the tree's ref runner".

**Sealing** backs the in-job side (`docs/blackbox-mode.md:140-180`): every source file of the
reference becomes one keyed payload (`ref_bin/ref_payload.bin`) committed into both trees; the key
lives only in the gitignored `submit.local.toml` and is denied to agents by layer 1/2; `gpu_entry.sh`
moves it to a 600 file and re-execs without it in the environment; the module is materialised in
memory; the header carries the plaintext sha256 and a copy with a few lines changed is refused at
≥40% overlap (`:172-174`). The doc is explicit about where protection really comes from: "on the
machine that runs `forge`, what stops unpacking is this denial, not the encryption"
(`docs/blackbox-mode.md:159-161`).

A reference that is an **installed library** gets two more closures:
`deny_urls` (repo/URL fragments refused by the hook) and `deny_modules` (import/distribution names
refused in probes and by the judge, so the student "can neither read the installed copy nor forward
to it", `docs/blackbox-mode.md:25-42`).

### 2.4 Why this exists

The experimental variable is *"can a natural-language optimization decision graph let an agent that
cannot see the original code reproduce the performance"* (`meta_milestone.md:328-330`). If the
student can read the reference — or fetch its upstream — the measurement is void: the agent copies,
and the loop records a promotion it did not earn. The same reasoning is applied to the KB: file
names, function names, line numbers and paraphrased content of the reference are kept in
`docs/kb-provenance/` which is in **no agent's read set**, because "an exact symbol name … is also a
retrieval key into the base model's pretraining memory" (`docs/kb-provenance/README.md:23-28`).

The boundary is deliberately *not* total: SASS, NCU metrics, timings and public algorithms stay open
(`docs/blackbox-mode.md:11-22`), and introspecting the DSL package is allowed. Over-blocking is
treated as a bug, with named failure modes: a `BLACKBOX_EXTRA` token that matches the reference
kernel's symbol name refuses every legitimate `-k` probe and, because `notes/` is cumulative, every
later round too (`docs/blackbox-mode.md:86-100`); naming the tree's own measurement wrapper
"refuses every probe that does the sanctioned thing" (`:102-112`). The guard also skips only a
byte-identical copy of itself, so a probe cannot hide under its filename (`blackbox-guard.sh:108-116`).

### 2.5 Drift worth knowing before porting

- `docs/design/v1-launch.md:213-214` and §13 still say the old two-reference design is merged into
  one reference; `meta_milestone.md:281-289` still reasons about `arch_baseline.json` vs
  `ref_baseline.json` and forbids anchoring to a past DUT. The **product** has one reference; the
  **distillation policy** still speaks in two. For a port, decide which one is authoritative before
  copying the anchoring rules.
- The deny list protects against reading, not against remembering: a model that saw a public kernel
  in pretraining is not blocked. `docs/kb-provenance/README.md:23-28` acknowledges this and that is
  why symbol names are quarantined.

---

## 3. Safeguard refusals

There are two unrelated families in this repo, and conflating them is a real hazard.

### 3.1 Model safeguard refusal — the CLI silently downgrades the session

`docs/safeguard-refusals.md` is about **the model refusing**, not the harness. The Claude Code CLI
reports no error: it writes a `system` record with `subtype: model_refusal_fallback`, `scope: session`,
switches the **whole session** to a fallback model, and continues (`:1-9`). Exact record shape:

```json
{"type":"system","subtype":"model_refusal_fallback","trigger":"refusal","scope":"session",
 "originalModel":"<requested>","fallbackModel":"<fallback>",
 "apiRefusalCategory":"cyber",
 "apiRefusalExplanation":"This request triggered restrictions on violative cyber content …",
 "refusedUserMessageUuid":"…"}
```

Classes seen in practice: `cyber`, `frontier_llm`, `reasoning_extraction`, `bio` (`:100`).
Policy, verbatim in substance:

- "**ForgeKernel does not currently detect refusals**: a downgraded turn runs to the end on the
  fallback model and is recorded like any other" (`:16-18`). Consequence: if turns produce nothing
  or an unconfigured model shows up, check by hand.
- "A refusal is not a channel problem" (`:91`) — retries do not help, the same context is refused
  again (`:96-97`).
- The refused unit is **the whole request context**, not the message the UUID points at (`:34-40`).
- Locate by calling the raw API with `max_tokens:16` and looking only at `stop_reason == "refusal"`;
  bisect lines, ~10 probes; "Finding the triggering line in one file does not mean you have found
  them all" (`:42-58`).
- The recurring carriers are long-lived files read back every round: the milestone, KB entries,
  probes (`:88-95`). Their worked example is exactly this domain: a teacher-written symptom-table
  line describing an out-of-bounds shared-memory write "hit the `cyber` classifier", and from then on
  every turn that read the milestone was refused (`:70-87`).

What it buys: the correct response is **reword the long-lived context**, not rotate a gateway or
retry. What it costs: an undetected refusal burns budget silently; the doc admits a second cluster
whose trigger was never located (`:86-89`). For a kernel-agent product this is a first-class risk:
the domain's debugging prose looks like exploit text.

### 3.2 Harness refusals — loud, named, attributed

These are machine-enforced and each names the rule:

| Refusal | Trigger | Wording / code | What it buys |
|---|---|---|---|
| Agent policy (network / cluster / reference) | offline role calls `WebFetch`/`WebSearch`/`curl`/`pip`/`ssh`; any role names the reference repo/module | `BLOCKED by the ForgeKernel agent policy: the {role} works offline …`; hook exit 2 (`agent_policy_hook.py:126,131,138,147`) | the barrier is stated, not discovered by failure |
| Blackbox guard | a probe command or any resident `notes/*` names the payload/key/unsealer/module/getsource/upstream repo | `BLACKBOX-GUARD REFUSED (… matched: …)`, exit 3 (`blackbox-guard.sh:138-139`) | a leak attempt is loud and leaves the matched tokens in the log |
| Clock lock | an SOL task's clock lock does not hold or read-back is off | prints `REFUSED`, exit 3; treated as "a job that did not run", resubmitted, run stops after 3 in a row (`docs/leaderboards.md:163-168`) | a reading at the wrong clock cannot pass as a score |
| Dirty knowledge base | KB or provenance has uncommitted changes before a **new** run | refuses to start, exit 3 (`docs/kb-harvest.md:25-31`) | the previous run's certified recipe is not buried under the next |
| Baseline overwrite | `forge <op> baseline` on an existing archive without `--force` | error + exit 3 (`baseline_cli.py:456-462`) | every gate anchored to it cannot move silently |
| Language / kernel-file mismatch | a CUDA language with `kernel.py`, or `.cu` with a DSL language | refused at start, **exit 18** (`docs/leaderboards.md`, CUDA mode section) | no wasted GPU job on the wrong toolchain |
| Judge vs reference disagreement | after 3 attempts | `RuntimeError`: "the judge did not agree with the reference after 3 attempts" (`launch.py:444-446`) | a broken exam cannot be absorbed into tolerance; the 5% match cap is the numeric guard (`v1-launch.md:446-449`) |
| Milestone schema | missing section / five-tuple / mark / mechanism line / tagged ruling | violations returned for rewrite; "if v1 is still non-compliant after the rewrite rounds are used up the run stops outright and never reaches the GPU" (`meta/distill_blackbox_prompt.md:287-289`; `src/forgekernel/milestone.py:249-683`) | the exam is well-formed before any GPU hour is spent |
| Run exit | target not met | `forge run` exits 2, 0 only at target (`launch.py:12-13`, `:369`) | CI and scripts can branch on success without parsing prose |
| Monitor alarm (the one veto) | final confirmation at target but the monitor raised `alarm` | `confirmed_at_target` returns False (`launch.py:384-394`; `docs/correctness-monitor.md:65-67`) | a kernel that fails stressed inputs cannot be counted as done |

The design principle is worth copying verbatim: **a refusal must be loud**. The guard's own header
documents the bug where an unquoted glob made the job die at the aggregation line before printing
why, so "the teacher sees a bare `rc=1` it cannot tell from its own probe crashing, and retries
again and again" (`blackbox-guard.sh:126-136`). Every aggregation pipeline now ends in `|| true`.

### 3.3 What the refusal discipline buys, overall

- **Attribution**: every failure is charged to the right side — probe bug, run config, machine,
  or kernel. The clock-lock case is explicit: "a transport failure or a clock lock that does not
  hold is reported as 'did not run' and never charged to the kernel" (`docs/design/v1-launch.md`,
  §14 item 14).
- **No silent pass**: the correctness monitor is the only advisory layer, and even it is allowed one
  veto at the exit code.
- **Cost control**: a schema-invalid milestone or a missing provider key fails before a GPU job.

---

## 4. Self-evolution

### 4.1 Promotion rule (the whole thing is 3 lines of logic)

`scripts/self_evolve.py`:

- `NOISE_FLOOR_MIN = 0.015` (`:42`), the same as the loop's plateau margin.
- floor = `max(0.015, (max(ratios) - min(ratios)) / min(ratios))` over the generation's **same-job
  confirmation ratios** (`:50-55`).
- promote iff `gain is not None and gain > 1.0 + floor`; otherwise the chain stops (`:112-117`).
- also stops when the generation ends without a confirmed best kernel (`:105-109`), and at
  `--max-gen` if given (default: none, `:120-122`).

The script is deliberately outside the core and "uses only the public commands"
(`docs/design/v1-launch.md:372-386`). Each generation is an ordinary `forge new` + `forge run`.

### 4.2 What is copied into the next generation

`next_generation` (`:58-78`):

- `description.md`, `shapes.json`, and `inputs/` if present — copied;
- the best kernel's **source text** written to `reference/kernel.py` (`:70-71`);
- `task.toml` read and rewritten: `[reference] = {run: "reference/kernel.py:run", source: "reference"}`,
  `[target].ratio = --step` (default 1.05), `[target].ms` removed (`:73-76`);
- `load_task(dest)` validates the new task before it is handed on (`:77`).

Not copied: the milestone, the judge, the trajectory, the KB entries. Consequence worth noting:
each generation re-does judge writing + calibration + recon + distillation, because it is a new run
of a new task. The example run's own timing shows recon alone was 44 of 84 minutes
(`docs/design/v1-launch.md`, §14 item 13). The chain is cheap in code and expensive in GPU hours.

Also: only `cutedsl` tasks are supported, because the next reference must be sealed as Python
(`:64-66`; `docs/design/v1-launch.md`, §14 item 8).

### 4.3 What the teacher / student see per generation

The promoted kernel carries its source, so **every generation after the first runs in source mode**:
the teacher reads the previous best, the student never does; the harness seals it for same-job
pairing (`README.md:205-215`; `docs/design/v1-launch.md:392-393`). This is the cleanest illustration
of the design: the "answer" is available to the lesson-writer and withheld from the learner, every
generation, without changing the mode machinery.

### 4.4 How a plateau is decided — two distinct levels

1. **Within a run** (`src/forgekernel/loop/parse.py:657-681`): plateau when the last 3 *evaluated*
   iterations set no new best beyond 1.5% of the prior best, measured **in the same gate window the
   loop stops on**. The docstring gives the empirical basis: "the same kernel re-measured spans
   ~1.37% on this harness (4-sample span) — so the margin is relative" (`:666-675`). A plateau
   triggers **meta**, not a stop.
2. **Across generations** (`self_evolve.py:50-55`): the floor is the spread of that generation's
   same-job confirmation ratios, floored at 1.5%. A gain inside it stops the chain.

Stopping is the driver's job: target reached / plateau / max iterations / meta budget
(`meta_milestone.md:319-321`). The milestone is forbidden from writing stop conditions.

### 4.5 What it buys, and its stated costs

- Buys: a ratchet that needs no absolute ceiling; every generation's exam is anchored to the last
  accepted answer; the noise floor comes from the same job's own spread rather than a global constant;
  a plateau is a measured boundary, not an opinion.
- Costs: "A plateau is an estimate, not a proof. Self-evolution stops at the same-job noise floor:
  the loop found nothing more, which does not mean nothing more exists" (`README.md:300-302`).
  The floor is computed from a handful of confirmation ratios. And the chain can stop at budget
  exhaustion rather than true saturation.

---

## 5. Product surface

### 5.1 CLI verbs

Public surface (`src/forgekernel/__main__.py:1-16`, `:53-56`; entry point `forge =
forgekernel.__main__:main`, `pyproject.toml:13-14`):

```
forge init <op>                     # tasks/<op>/ from tasks/_template/
forge init <op> --leaderboard …     # one board problem, frozen
forge new tasks/<op> [--dry-run]    # create a run; --dry-run prints the plan only
forge run .artifacts/<op>_<id>      # run, or continue where it stopped
forge status [.artifacts/<op>_<id>] # progress (all runs when omitted)
forge harvest .artifacts/<op>_<id>  # KB write-up of a run that did not finish
forge export .artifacts/<op>_<id>   # best kernel (or the board's solution JSON)
```

Internal, "listed for debugging a run, not as a second way to configure one"
(`__main__.py:22-37`): `forge <op> baseline|loop|ncu-trace|window|leaderboard|monitor|submit|status|logs|stop`.

`forge run` exits 0 only at target, 2 otherwise (`launch.py:12-13`). A run takes hours and is meant
to be launched under tmux (`README.md:118-125`).

### 5.2 What the user writes vs what the harness generates

**User writes** (three files, ~10 keys):

- `description.md` — signature, semantics, legal inputs. Must be complete enough that the teacher can
  write the judge from it alone (`docs/design/v1-launch.md:122-134`).
- `shapes.json` — shapes + optional input groups; every group of every shape is judged and timed
  equally; fewer than 3 groups per shape are topped up by the teacher (`:135-167`).
- `task.toml` — language, arch, reference, target, agents, budget (`:63-118`).

**Harness generates** (the whole process): run directory and snapshot; the judge + input groups +
frozen tolerance; the operator tree and the recon tree; the sealed payload and key; `loop.toml`;
`submit.toml`; `window.toml` (derived from the reference call and judge signature); the deny list;
`gpu_entry.sh`; git identity/branch; the two-layer loop; the report; `best/`. The "off the launch
surface" table is the best single list: ~40 tuning knobs fixed, all `--allow-*`/`--skip-*` removed,
`window.toml`/deny list/job entry/`--kernel-file` derived, `--hours`/`--equivalence-ratio`/
`--target-ms`/`--language` no longer runtime overrides (`docs/design/v1-launch.md:397-412`).

The principle: "**The user writes the problem, not the process**" (`:15`) and "**A run cannot change
the problem**" (`:21`).

### 5.3 Config layering

- Bottom layer `global_config/` — `models.toml` gives every `[agent]` key, `loop.toml` every
  `[target]`/`[budget]` key (`global_config/models.toml:1-13`, `global_config/loop.toml:1-10`).
- Top layer `tasks/<op>/task.toml` — only what differs.
- Merge order: global `[agent]` → global `[agent.<role>]` → task `[agent]` → task `[agent.<role>]`;
  a task `[target]` with `ratio` or `ms` replaces **both**; validation runs on the merged result
  (`src/forgekernel/task.py:43-49`, `:357-381`).
- Machine and credentials never in the task: `local.env` (`FK_DELIVERY`, `FK_GPU`, `REMOTE_HOST`,
  `REMOTE_WORKDIR`, keys) — `docs/design/v1-launch.md:326-352`.
- The run snapshots the task; "the task definition is the snapshot's"; a run cannot be reconfigured
  from the command line (`:320-324`).

Defaults: target 1.2× in device time, 4 h loop, 3 teacher rounds, 8 h to write a missing reference
(`global_config/loop.toml:3-10`).

### 5.4 Run state and resume

`.artifacts/<op>_<id>/` = `run.json` (status, stop reason, target_met), `task/` (snapshot),
`check/` (judge, groups), `operators/<op>/` (card, milestone, `student/status.jsonl`,
`meta_status.jsonl`), `operators/_<op>ref/` (recon tree), `ws/` (student workspace), `best/`,
`run.log`, `report.md` (`docs/design/v1-launch.md:303-325`; `src/forgekernel/runs.py:1-14`).
Resume = run `forge run` again; done steps are skipped and the loop resumes from its own records.

This is the piece that makes a daemon unnecessary: every step is idempotent and its completion is
recorded on disk.

### 5.5 A pi-native equivalent

pi gives tools, skills, slash commands, extensions, subagents, and **no long-lived daemon**. The
port therefore has to replace "the driver process" with "a state machine + one step per turn".

| ForgeKernel mechanism | pi primitive | What has to change |
|---|---|---|
| `forge run` driver loop, resumes itself | a `kernel_step` tool + `/kernel-step` command; state in `run.json`/`status.jsonl` | one call = one stage transition; never loop inside a tool call for hours |
| teacher turn / student turn (separate sessions, separate policies) | `agent` subagents: teacher foreground + high effort; student `isolation: worktree`; auditor `readonly` | the role's write scope becomes the subagent's cwd/isolation, not a generated `.claude/settings.json` |
| deny list + agent policy + sandbox | (a) the reference is **not in the agent's workspace**, (b) a tool-level path allowlist, (c) the seal + in-job guard for the GPU box | no Seatbelt/PreToolUse equivalent is free; without an OS sandbox the barrier degrades to "the file is not there" + the job-side guard. Say so in the contract rather than claiming enforcement |
| generated `goal.sh`/`gpu_entry.sh` | a `kernel_job` tool that submits local/ssh synchronously and writes a job dir; tmux skill for long runs | the detached-runner/resubmit/GPU-lock logic is not free; start with one job at a time |
| judge writing + calibration | a teacher subagent + a `kernel_calibrate` tool | the tool must refuse after N disagreements and freeze the tolerance |
| milestone schema + gates (`milestone.py`) | a pure validation tool (`kernel_gate`) returning PASS/DEFERRED/INFEASIBLE/N/A and refusing to advance | **this is the piece that must be code, not skill text**; a skill is advisory, a tool that refuses is enforcement |
| meta loop (diagnose → patch → prefix reuse) | an extension command that injects the digest + a teacher subagent that writes a patch record | prefix invalidation can start as "structural patch invalidates all later decisions"; refine later |
| self-evolution script | `/kernel-promote` command reading the run's confirmation ratios | trivial, no daemon needed |
| KB with provenance separation | repo dirs + a lint tool + a review step | keep `docs/kb-provenance/` out of the agent read set; lint bans reference symbols |
| correctness monitor | a `kernel_monitor` job (stress profiles) with a report-only output | the only veto is the exit-code rule |

Minimum viable pi port (what I would actually build):

1. `kernel.task.toml` + `docs/kernel/` (methodology doc versioned with the task — not only a skill).
2. Tools: `kernel_state` (status/step), `kernel_job` (submit + parse), `kernel_gate` (validate + rule),
   `kernel_promote`. Four tools, one state file.
3. Subagents: `teacher` (recon/distill/diagnose; can read the reference in source mode), `student`
   (worktree-isolated; cannot), `auditor` (readonly; M0 audit).
4. One `kernel-flow` skill for the narrative, one `/kernel-*` command per verb.
5. Enforcement: the student's workspace simply does not contain the reference; the GPU job carries
   the guard; the gate tool refuses evidence-free closure.

Maintenance cost: the validator and the state schema are the only real code. Everything else can be
prompts, and should be, because prompts are what you will iterate on.

---

## 6. The 5 cheapest methodology claims to adopt, and the 3 most expensive

### 6.1 Five cheapest (days, no new infrastructure)

1. **A gate cannot close on the end-to-end number alone.** Require ≥1 mechanism line that separates
   "the mechanism landed" from "the number happened to land", plus the coupling rule: end-to-end
   PASS with the mechanism line red ⇒ do not close; re-attribute first
   (`docs/milestones-template.md:400-417`; `meta_milestone.md:467-490`).
   Cost: one field in the gate template + a reviewer check. This is the single highest-yield rule
   in the whole corpus.
2. **Every number carries its source.** `[MEASURED, job N]` or `[ESTIMATE]` + derivation; unsourced
   performance bands are forbidden (`meta_milestone.md:290-297`; `docs/milestones-template.md:524-526`).
   Cost: a lint on the gate block. Buys: you can audit any line later without the run.
3. **Paired, same-job, ratio-only measurement; noise floor 1.5%.** Burn in, mirror ref/kernel/kernel/ref,
   give each side the mean of two readings (`docs/blackbox-mode.md:114-138`); plateau = no new best
   beyond 1.5% of the prior best in the same gate window (`src/forgekernel/loop/parse.py:657-681`).
   Cost: one bench template + one rule. Buys: kills the largest class of false promotions.
4. **Freeze the architecture; enumerate the levers separately.** Write the frozen set and the
   tunable set in the contract; forbid structural change after the freeze; make "the freeze was
   wrong" the only route to a retile (`docs/milestones-template.md:128-131`, `:190-307`;
   `meta_milestone.md:310-318`). Cost: a paragraph + a review check.
5. **Dead ends are recorded as bundles with retry preconditions.** A failed bundle bans the
   combination, not its members; retry alone or in a smaller bundle counts as a changed precondition
   (`meta_milestone.md:372-390`; `docs/milestones-template.md:511-523`). Cost: a table. Buys: no
   re-betting the same combination, and no over-broad bans.

Bonus, still cheap: exit codes + named refusals; `--dry-run` printing the plan; `target_ms` as the
machine-read stop SSOT.

### 6.2 Three most expensive (months, hardware, research)

1. **The distillation policy + validator + audit/diagnose prompts.** `meta_milestone.md` is 700 lines
   encoding ~10 named failure modes with evidence, plus a schema with per-decision tag duties
   (`[VERIFY:]`, `[SOURCE:]`, `[SYNC:]`, `[GATHER:]`, `[PHASE:]`, `[PRICED:]`, `[EXPR:]`,
   `[PLACEHOLDER:]`) and a validator that checks them (`src/forgekernel/milestone.py:249-683`).
   It cannot be derived from first principles; it is a museum of paid-for mistakes. Portable only as
   a whole or as a deliberately reduced subset.
2. **Recon + measurement.** Per-architecture SASS transcription (wgmma / tcgen05 / mma_sync), schedule
   order, live-range bill, residency verdict, inter-kernel ledger, NCU degradation path
   (`docs/blackbox-mode.md:190-209`; `meta/recon_prompt.md`; `docs/design/v1-launch.md` §3.4).
   Requires GPUs, per-arch tooling, and calibrated parsing. This is where "architecture-first" gets
   its facts, and where a port without hardware simply cannot follow.
3. **Isolation + pairing + job machinery.** Sealing and key handling, deny derivation, sandbox policy,
   the guard, local/ssh executors, GPU lock, same-job mirrored timing, resume
   (`docs/blackbox-mode.md:140-180`; `docs/design/v1-launch.md:326-352`, §14 item 14). Every piece has a
   failure mode that silently invalidates the measurement, and each was found the hard way.

Self-evolution itself is **cheap** (125 lines, public commands only); the cost is the GPU hours of
re-running judge + recon + distill per generation.

---

## 7. Closing: the 5 things pi-kernel-expert most lacks, methodologically

Basis: pi-kernel-expert 0.4.0 (`README.md`, `CONTEXT.md`) — contract with hash, generated
`goal.sh`/`goal.checks.sh`, profile evidence bound to a diff hash, candidate ledger with
parent/rejection reasons, one `kernel-flow` skill, `kernel_wiki` + vendored `ncu-report-skill`.

1. **A decision graph as the unit of work — and architecture-first.** pi-kernel-expert's contract
   fixes *acceptance* (shape matrix, tolerance, metric, guard, noise floor) but not the *path*. There
   is no M0, no five-tuple (`Action/Purpose/Trigger/Cost/Depends on`), no DAG, no `⊗` companion
   group, no trigger condition, no dead-end table with bundle semantics. Consequence: the agent
   searches, and a plateau cannot be diagnosed as "a missing decision" vs "a badly tuned one" —
   both look like "more candidates". Its `Limiter` vocabulary is the right raw material, but it
   names *what is slow*, not *which decision is missing*.
2. **An information barrier.** Nothing in the contract, the tools or the skill hides the reference
   implementation's source; the agent can read the repo it is optimizing and (via the wiki/tools)
   the web. So "reproduced performance from a description" is untestable, and a copied kernel can be
   recorded as a promotion with valid evidence. ForgeKernel's whole experimental claim depends on the
   derived deny list + seal + guard (`launch.py:330-351`; `blackbox-guard.sh:61`). Cheapest partial
   port: the reference lives outside the workspace, a tool-level path check, and a contract field for
   `deny`/`deny_urls`/`deny_modules`.
3. **Typed gates and mechanism evidence.** It has metrics, a noise floor, and profile evidence bound
   to a diff hash — better than most. It lacks the *typing*: architecture-conformance vs mechanism vs
   performance lines, `[VERIFY: ncu-direct|ncu-derived|sass-derived|correctness|none]`, the rule that
   `none` may not enter a gate, `[PRICED:]` for SASS shapes, the four-state ruling with DEFERRED's
   three-condition admission, the final-ruling duty, and the band-width rule (ref × 1.25). Without
   these, a kernel can pass with the right number and the wrong mechanism — the failure mode
   ForgeKernel documents four separate times (`meta_milestone.md:467-683`).
4. **A second loop that edits the plan, not the kernel.** pi-kernel-expert is single-level:
   candidate → gate → keep/reject. There is no teacher role that reads the trajectory and diagnoses
   *why* the loop is stuck (G1/G2/G3/G4/G5/R1/R2), no patch types (additive vs structural), no prefix
   invalidation/resume, no mandatory M0 audit ("is the milestone itself drawn correctly",
   `meta/m0_audit_prompt.md:5-13`), no verdict experiments with `PROBE_REQUEST` and pre-registered
   `PROBE PASS/FAIL` lines (`meta/verdict_probe_brief.md:1-40`), no lever pricing. Consequence: at a
   plateau the only move left is more candidates.
5. **The bar is independent, and it moves.** Its correctness oracle is whatever check command the user
   supplies, and its baseline is per task; promotion resets at the next task. ForgeKernel's exam is
   written from the description by someone who cannot see the answer, calibrated against the reference,
   tolerance = 2× observed error floored by dtype, and the accepted kernel becomes the next task's
   reference with a measured promotion rule (`docs/design/v1-launch.md:223-247`;
   `scripts/self_evolve.py:50-76`). Consequence: pi-kernel-expert can say "this candidate beats the
   baseline", not "this system keeps beating its own last answer, and here is where it stopped".

Close sixth, mostly a product property: **loud, attributed refusals + exit codes**. pi-kernel-expert's
gate is good at "no"; the ForgeKernel lesson is that the "no" must name the rule, the side it is
charged to, and the fix — otherwise the agent retries a silent failure (`blackbox-guard.sh:126-136`,
`agent_policy_hook.py:126-147`).
