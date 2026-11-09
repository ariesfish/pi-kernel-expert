#!/bin/bash
# job-env-check — prove on h200-7 that nvcc, ncu and a CUDA-enabled torch are all
# visible from a NON-interactive shell with no inherited PATH magic.
#
# Read-only by construction: exports PATH, reads versions, runs one tiny CUDA op.
# It installs nothing, touches no GPU clock, and signals no process.
#
# Run it ON the GPU node (copy to ~/pkex/bin/ and execute there); it is not run
# from the repo. PKEX_* overrides exist so the missing-item path can be exercised
# without touching /usr/local.
#
# Exit 0  : nvcc + ncu + torch (CUDA-enabled) + >=1 CUDA device all present.
# Exit 1  : one or more missing; each is named as `MISSING: <item> (<why>)`.

set -uo pipefail

# Defaults are the fixed locations on h200-7; the PKEX_* overrides exist so the
# missing-item path can be exercised without touching /usr/local.
CUDA_HOME="${PKEX_CUDA_HOME:-/usr/local/cuda-13.0}"
NCU_HOME="${PKEX_NCU_HOME:-/opt/nvidia/nsight-compute/2025.3.1}"
VENV_PY="${PKEX_VENV_PY:-${HOME}/pkex/venv/bin/python}"

export PATH="${CUDA_HOME}/bin:${NCU_HOME}:${PATH}"

MISSING=()
missing() { MISSING+=("$1"); printf 'MISSING: %s (%s)\n' "$1" "$2"; }

echo "== shell =="
echo "host:     $(hostname)"
echo "user:     $(id -un)  HOME=${HOME}"
echo "interactive: $([ -t 0 ] && echo tty || echo no-tty)"
echo "PATH:     ${PATH}"
echo "CUDA_VISIBLE_DEVICES: ${CUDA_VISIBLE_DEVICES:-<unset>}"

echo "== toolchain =="
if command -v nvcc >/dev/null 2>&1; then
  line=$(nvcc --version 2>&1 | grep -m1 -E 'release|V[0-9]+\.[0-9]+')
  echo "nvcc:     ${line:-<no version line>}"
  echo "nvcc at:  $(command -v nvcc)"
else
  missing nvcc "not found under ${CUDA_HOME}/bin"
fi

# `ncu` on PATH and the pinned Nsight Compute install are reported separately:
# the CUDA-bundled ncu is a launcher that exec's the same CLI, but this evidence
# must not depend on that being true.
if command -v ncu >/dev/null 2>&1; then
  line=$(ncu --version 2>&1 | grep -m1 -E '^Version|Version [0-9]')
  echo "ncu:      ${line:-<no version line>}"
  echo "ncu at:   $(command -v ncu)"
  if [ -x "${NCU_HOME}/ncu" ]; then
    opt_line=$("${NCU_HOME}/ncu" --version 2>&1 | grep -m1 -E '^Version|Version [0-9]')
    echo "ncu@opt:  ${opt_line:-<no version line>}  [${NCU_HOME}/ncu]"
    [ "$line" = "$opt_line" ] || echo "WARN:     PATH ncu and ${NCU_HOME}/ncu report different versions"
  else
    missing ncu_pinned "no binary at ${NCU_HOME}/ncu"
  fi
else
  missing ncu "not found under ${NCU_HOME}"
fi

echo "== torch (pkex venv) =="
if [ -x "$VENV_PY" ]; then
  echo "python:   $("$VENV_PY" -VV 2>&1) [${VENV_PY}]"
  if ! "$VENV_PY" - <<'PY'
import sys

import torch

avail = torch.cuda.is_available()
count = torch.cuda.device_count()
print(f"torch:    {torch.__version__}")
print(f"torch.version.cuda: {torch.version.cuda}")
print(f"torch.cuda.is_available(): {avail}")
print(f"device_count: {count}")

if not avail:
    sys.exit(10)
if count < 1:
    sys.exit(11)

for i in range(count):
    p = torch.cuda.get_device_properties(i)
    print(f"device[{i}]: {torch.cuda.get_device_name(i)} "
          f"{p.total_memory / 1024**3:.1f} GiB sm_{p.major}{p.minor}")

# Real kernel launch, not just an import: catches a broken runtime/driver ABI.
a = torch.randn(64, 64, device="cuda")
b = torch.randn(64, 64, device="cuda")
c = a @ b
torch.cuda.synchronize()
ok = tuple(c.shape) == (64, 64) and bool(torch.isfinite(c).all())
print(f"smoke:    matmul 64x64 -> {tuple(c.shape)} {c.dtype} finite={ok}")
if not ok:
    sys.exit(12)
PY
  then
    rc=$?
    case $rc in
      10) missing torch "torch.cuda.is_available() is False" ;;
      11) missing cuda_device "torch.cuda.device_count() == 0" ;;
      12) missing torch_runtime "CUDA matmul smoke test failed" ;;
      *)  missing torch "venv python failed (rc=$rc)" ;;
    esac
  fi
else
  missing torch "no interpreter at ${VENV_PY} (run: uv venv --python 3.12 ~/pkex/venv)"
fi

echo "== gpus (nvidia-smi) =="
if command -v nvidia-smi >/dev/null 2>&1; then
  gpu_csv=$(nvidia-smi --query-gpu=index,name,memory.used,memory.free,utilization.gpu,clocks.sm \
              --format=csv,noheader 2>/dev/null)
  if [ -n "$gpu_csv" ]; then
    printf '%s\n' "$gpu_csv" \
      | awk -F', ' '{printf "gpu%-2d %-12s used %-11s free %-11s util %-7s clocks.sm %s\n", $1, $2, $3, $4, $5, $6}'
    echo "gpus seen by nvidia-smi: $(printf '%s\n' "$gpu_csv" | wc -l)"
  else
    missing nvidia_smi "query returned nothing"
  fi
else
  missing nvidia_smi "not on PATH"
fi

echo "== verdict =="
if [ ${#MISSING[@]} -eq 0 ]; then
  echo "RESULT: ok — nvcc, ncu, torch(${VENV_PY}) and CUDA devices all present"
  exit 0
fi
echo "RESULT: incomplete — ${#MISSING[@]} missing item(s): ${MISSING[*]}"
exit 1
