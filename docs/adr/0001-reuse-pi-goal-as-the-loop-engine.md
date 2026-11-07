# ADR 0001: pi-goal is the loop engine, used unmodified

## Status

Accepted (2026-11-07).

## Context

Kernel optimization needs a phased loop (frame, probe, freeze, run, gate, keep or revert, record) and a deterministic verdict. `@ariesfish/pi-goal` 0.5.3 already implements exactly that, with a hashed contract, an append-only journal, reverted attempts, and a gate that is code, not prose.

Three shapes were available:

1. Reuse pi-goal unmodified; express kernel rules as generated shell scripts and `asi` payloads.
2. Fork pi-goal's core (~4–5k lines) into this package and specialize it.
3. Extract a shared `pi-loop-core` package and slim both plugins.

## Decision

Option 1. This package owns no phase machine, journal, gate, or dashboard. Kernel evidence enters through what pi-goal already accepts:

- per-shape numbers as `METRIC name=value` lines (pi-goal's parser accepts them, `execution/experiment-runner.ts`);
- matrix correctness and evidence freshness as `command` criteria running generated scripts;
- profile pointers, limiter, run counts, and clock state as free-form `asi`.

The one structural constraint is recorded: pi-goal allows exactly one blocking `metric` criterion, so the primary metric is an aggregate (default geomean speedup) and per-shape guards are executable `command` criteria.

## Consequences

- No duplicated protocol to maintain, and a kernel task benefits from every pi-goal fix.
- The plugin is coupled to pi-goal's contract/journal schema and tool names. A compatibility test pins what this package relies on; a schema change is a breaking change surfaced early.
- If kernel work ever needs a phase pi-goal cannot express, the order is: ADR, then a pi-goal change upstream, not a fork.
- Option 3 stays open: if a third consumer appears, extract the core from pi-goal as a pure move with tests.
