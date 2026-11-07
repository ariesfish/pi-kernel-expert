# Third-Party Notices

First-party code in this package is MIT licensed (see `LICENSE`). The package
builds on third-party work; the boundaries below decide what is distributed
verbatim, what is fetched at runtime, and what is only cited.

## Distributed here

### ncu-report-skill

- Path: `skills/ncu-report-skill/` (verbatim upstream tree, plus `VENDORED.yaml`)
- Source: <https://github.com/mit-han-lab/ncu-report-skill>
- Revision: `c7980a43cb88a8734d113b22b57ff66746cf5719` (upstream HEAD at vendor time)
- License: MIT — Copyright (c) 2026 hanlab
- License text: vendored copy at `skills/ncu-report-skill/LICENSE`

Re-vendor with `scripts/sync-vendored-skill.sh <clone-path>`. The vendored tree
is upstream-owned: fix bugs upstream, then re-sync, rather than editing it here.

## Fetched at runtime, not distributed

### KernelWiki

- Source: <https://github.com/mit-han-lab/KernelWiki>
- Pinned revision: `76d27b56f804e7e7295d4c570e1e5d7eef4b0a75` — the sanitized tree
  recorded by kda's gitlink; 19 NVIDIA-proprietary CuTe DSL files are omitted
  upstream of this revision.
- License: MIT for original KernelWiki material (Copyright (c) 2026 hanlab);
  verbatim artifact bundles under `artifacts/` retain their upstream terms.
- License text: `third_party_licenses/MIT-hanlab.txt`

This package does not ship KernelWiki content. The bootstrap fetch clones the
pinned revision into the user's pi agent directory; the terms that apply to the
fetched tree are the upstream ones, including per-bundle `PROVENANCE.yaml`
records under `artifacts/`.

## Cited, not distributed

### Kernel Design Agents (kda)

- Source: <https://github.com/NVlabs/kda>
- Informed the workflow this package implements: task contract, plan draft,
  candidate loop, evidence records, promotion rule (`docs/agent-flow.md`,
  `prompts/basic-flow.md`, `CLAUDE.md`).
- License: documentation and skills-style content CC-BY-4.0; source code
  Apache-2.0 — Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES.
- License texts: `third_party_licenses/CC-BY-4.0-Apache-2.0-KDA.txt`

kda's Hugging Face export script is not copied into this package. If the
export feature is built (T-010, not in v1), its script and tests would be
vendored with this notice updated.

### Nsight Compute and CUDA

The profiling workflow invokes NVIDIA's `ncu` binary and its `ncu_report`
Python API from the user's CUDA / Nsight Compute installation. No NVIDIA
binary or SDK content is distributed here. KernelWiki's artifact inventory
records the CUTLASS, FlashInfer, PyTorch, SGLang, vLLM, and DeepGEMM terms that
apply to artifacts fetched with that corpus; this package distributes none of
them.
