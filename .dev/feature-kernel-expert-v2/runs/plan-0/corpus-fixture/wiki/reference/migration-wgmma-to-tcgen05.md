---
id: migration-wgmma-to-tcgen05
title: "Migrating a wgmma pipeline to tcgen05"
type: technique
confidence: source-reported
sources: [doc-nvidia-tuning-guide]
---

## Mechanism

tcgen05 moves the MMFMA onto a dedicated tensor core pipeline with its own
instruction stream; the wgmma warpgroup split disappears.
