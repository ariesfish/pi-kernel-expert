# Domain Docs

This is a single-context repo.

- Read `CONTEXT.md` first: it owns the vocabulary (Kernel Task, Task Contract, Shape Matrix, Reference Oracle, Candidate, Promotion, Profile Evidence, Noise Floor, Limiter, Pin).
- Read the ADRs under `docs/adr/` before changing an architectural boundary:
  - `0001` — pi-goal is the loop engine, used unmodified.
  - `0002` — vendor the ncu skill, fetch KernelWiki at a pin.
  - `0003` — v1 is verified on sm_90 while the knowledge skills cover Blackwell.
  - `0004` — the task owns comparison commands; the generator owns the matrix and evidence envelopes.
  - `0005` — evidence freshness is enforced by `kernel_candidate`, not a generated checker.
- Terms not in `CONTEXT.md` are not domain terms yet. Add them there (with an avoid-list and one example dialogue) before using them in code or tickets.
- When an implementation decision changes a documented boundary, write the ADR in the same change.
