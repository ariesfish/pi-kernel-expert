#!/usr/bin/env bash
# run-reading.sh — run one goal.sh with the GPU state sampled alongside it.
#
# Usage: run-reading.sh <workspace> <tag> <gpu-index>
# Writes into ~/pkex/runs/T-003:
#   <tag>.stdout   <tag>.stderr   <tag>.rc   <tag>.gpu.txt
#
# The sampler is this script's own child, bounded, and waited on: it signals
# nothing. The card is claimed with CUDA_VISIBLE_DEVICES and never touched
# otherwise — no clock lock, no reset, no -pm.
set -uo pipefail

ws="$1"
tag="$2"
gpu="$3"
out="$HOME/pkex/runs/T-003"
mkdir -p "$out"

export PATH="/usr/local/cuda-13.0/bin:${PATH}"

{
  echo "# sampler: nvidia-smi -i $gpu --query-gpu=index,memory.used,utilization.gpu,clocks.sm,clocks.mem"
  echo "# start $(date -u +%FT%TZ)"
  nvidia-smi --query-gpu=index,memory.used,utilization.gpu,clocks.sm,clocks.mem --format=csv,noheader
} > "$out/$tag.gpu.txt"

(
  for _ in $(seq 1 200); do
    nvidia-smi -i "$gpu" --query-gpu=index,memory.used,utilization.gpu,clocks.sm,clocks.mem --format=csv,noheader
    sleep 0.1
  done
) >> "$out/$tag.gpu.txt" 2>&1 &
sampler=$!

cd "$ws" || exit 2
start=$(date +%s)
CUDA_VISIBLE_DEVICES="$gpu" bash goal.sh > "$out/$tag.stdout" 2> "$out/$tag.stderr"
rc=$?
elapsed=$(( $(date +%s) - start ))

wait "$sampler"
{
  echo "# end $(date -u +%FT%TZ)"
  nvidia-smi --query-gpu=index,memory.used,utilization.gpu,clocks.sm,clocks.mem --format=csv,noheader
} >> "$out/$tag.gpu.txt"

echo "rc=$rc elapsed=${elapsed}s gpu=$gpu workspace=$ws" | tee "$out/$tag.rc"
exit 0
