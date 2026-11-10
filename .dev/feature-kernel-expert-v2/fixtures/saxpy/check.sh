#!/usr/bin/env bash
# check.sh — correctness for the SAXPY fixture on one input group.
#
# The generated goal.checks.sh exports the cell's dtype/tolerance and the group's
# name/seed/intent, runs this command twice per (cell, group), and reads the last
# `max_diff=` it prints. It exits non-zero on a mismatch, which is the group
# failure T-007 wants to see named.
#
# The group is the whole input contract here:
#   typical    — random fp32 in [-1, 1); the candidate must be correct.
#   tail       — the same data at N+37, i.e. a partial last block.
#   zero_block — a quarter of x exactly zero with y non-zero. The candidate's
#                all-zero fast path writes zero there instead of leaving y, so
#                this group fails by construction: it is the negative control.
#
# Nothing here reads or writes GPU state; it compiles `verify` on first use and
# runs one kernel.
set -euo pipefail

here=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
group=${KERNEL_GROUP:-typical}
n=${KERNEL_N:-1048576}
tol=${KERNEL_ATOL:-1e-6}
seed=${KERNEL_GROUP_SEED:-12345}
# cell vars arrive as KERNEL_<KEY>; this fixture has none, so the block size,
# a and the seed stay at their defaults unless a caller overrides NVCC.

case "$group" in
  typical | tail | zero_block) ;;
  *)
    echo "check.sh: unknown KERNEL_GROUP \"$group\" (typical|tail|zero_block)" >&2
    exit 2
    ;;
esac

# nvcc is not on the non-interactive PATH on h200-7; check.sh runs under
# goal.checks.sh, which inherits whatever PATH the caller had. Resolve it here so
# a first run does not depend on the shell being prepared.
NVCC=${NVCC:-}
if [[ -z "$NVCC" ]]; then
  if command -v nvcc >/dev/null 2>&1; then
    NVCC=$(command -v nvcc)
  elif [[ -x /usr/local/cuda-13.0/bin/nvcc ]]; then
    NVCC=/usr/local/cuda-13.0/bin/nvcc
  else
    echo "check.sh: no nvcc on PATH and none at /usr/local/cuda-13.0/bin/nvcc; set NVCC=" >&2
    exit 2
  fi
fi
verify="$here/verify"
if [[ ! -x "$verify" ]]; then
  echo "check.sh: building verify with $NVCC" >&2
  "$NVCC" -O3 -arch=sm_90 -o "$verify" "$here/kernel.cu" >&2
fi

# One implementation under test (the default, `fast`), so a failure is a data
# failure and not a harness switch. `--impl plain` exists for the T-008 ruler.
set +e
out=$("$verify" --n "$n" --group "$group" --impl fast --seed "$seed" --tol "$tol" 2>&1)
rc=$?
set -e
printf '%s\n' "$out"
if [[ $rc -ne 0 ]]; then
  echo "check.sh: group $group mismatched the CPU reference (exit $rc)" >&2
fi
exit "$rc"
