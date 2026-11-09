# ADR 0006: Contract v2 records reading provenance and breaks v1

## Status

Accepted (2026-11-10).

## Context

A latency number is only evidence if three facts travel with it: how it was
taken, which harness produced it, and what it was compared against. v1 of
`kernel.contract.json` carried none of them. The record could not say whether
`benchmark_command` timed device time or the whole host call, so two runs on
different bases were compared as if they were the same measurement. It did not
name the files that make the measurement, so `scope_globs` — optional, and
defaulting to the whole repo — left the comparator writable inside a candidate
diff. And it had no way to state that a reference implementation was measured in
the same job, so a cross-run baseline was indistinguishable from a paired one.

The plugin is at 0.x. A v1 workspace is produced by a single tool call
(`kernel_contract`) from facts the user still has in front of them; migrating it
would mean code that reads two shapes, forever, in every consumer — the reader,
the generated scripts, the candidate recorder, and the freeze payload. That is
more machinery than the break costs.

## Decision

`schemaVersion: 2` is written by `kernel_contract` and is the only schema read.
A file whose `schemaVersion` is missing or 1 is refused at read time, in one
line, naming the file:

```
kernel.contract.json is schema v1 (or unversioned); regenerate with kernel_contract
```

There is no migration path and no best-effort upgrade: a contract that cannot
say what its numbers mean is not evidence, and a silent upgrade would make the
old contract look like it had always said the new thing. The sha256 is still
computed over the file exactly as written, and `schemaVersion` is part of that
text, so a v1 and a v2 contract can never collide on a sha.

The three fields:

- **`basis` (`device` | `e2e`)** — what the timed region covers. `device` is the
  kernel's own device time; `e2e` is the host-to-device call. Without this, a
  host-bound measurement and a device measurement compare cleanly and mean
  nothing. Downstream, the basis decides whether `hostBoundRatio` is a
  precondition (plain device timing) or irrelevant (a host-free basis), and a
  baseline is keyed on it.
- **`harnessGlobs[]`** — the files that make the number. The gate already
  protects `goal.sh` and `goal.checks.sh`; the comparator is what turns "the
  kernel is correct" into a boolean and is task-authored, so it needs naming.
  A diff that touches a harness glob is a changed measurement, not a changed
  kernel, and `kernel_candidate` refuses it.
- **`referenceCommand`** — a shell command, same shape as
  `benchmarkCommand`, for the reference implementation measured in the same
  job. It buys a paired ratio (`ref, kernel, kernel, ref`) that does not depend
  on the machine being in the same state as the day the baseline was taken.
  It is optional: absent means `pairing: "absent"` and a labelled cross-run
  baseline, which is the normal state of an existing task. A reference equal to
  the benchmark command is refused — a self-reference is not a reference.

The default `harnessGlobs` is `["goal.sh", "goal.checks.sh"]` and is
**incomplete by design**: the generator cannot know what the comparator is
called, and a wrong guess would freeze a file the task does not have. So the
task must add its own comparator. The cheap catch is a warning, not an error:
when the caller omits `harnessGlobs`, `kernel_contract` scans `benchmarkCommand`
and `checkCommand` for relative paths that exist on disk and reports every file
no glob covers. A warning keeps a vendored read-only helper from blocking the
contract; it still tells the writer that the file is inside the writable set.

Two supporting changes ride along, both about the file being trustworthy:

- one reader. `readContract` is the only place that parses the contract, and it
  refuses a bad `schemaVersion` and a v2 file that lost `basis` or
  `harnessGlobs` before any caller sees it.
- crash-safe writes. The artifacts are written to sibling temp files and renamed
  into place, contract last, so an interrupted regeneration leaves the old set
  or the new one — never a new contract beside scripts whose embedded sha
  disagrees with it.

## Consequences

- Every existing workspace must be regenerated once. The refusal says so and
  names the tool; there is no half-state, because the contract's sha changes and
  the generated scripts check it.
- `kernel-freeze.json` carries `basis`, `harness_globs`, and
  `reference_command`, so the criteria the gate is frozen against state the
  reading's provenance in the same artifact as the thresholds.
- A comparison across bases, or a candidate that edits a harness file, becomes
  refusable without reading the diff by hand. The rules live in
  `kernel_candidate` (ADR 0005), not in a generated script.
- The default harness set covers only the generated scripts. A task that does
  not add its comparator gets a writable comparator and, at most, a warning at
  contract time. That gap is deliberate: the alternative is a glob list that
  looks complete and is not.
- `referenceCommand` is a shell string, so quoting is the task's problem, the
  same tradeoff already accepted for `benchmarkCommand` and `checkCommand`
  (ADR 0004).
- Breaking the schema at 0.x costs one regeneration per workspace. If the
  contract ever ships to workspaces the plugin cannot regenerate, this ADR is
  the precedent that must not be reused: from 1.0 on, a schema break needs a
  migration, not a refusal.
