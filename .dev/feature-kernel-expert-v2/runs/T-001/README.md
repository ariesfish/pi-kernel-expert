# T-001 — toolchain bootstrap on h200-7 (`ssh builder`)

Environment lives entirely under `~/pkex/` (= `/root/pkex/`). Nothing in `/usr/local`,
no sudo, no system package installs, no GPU clock/power changes, no signals to any process.

## Files

| Path | What |
|---|---|
| `h200-7:~/pkex/venv` | uv venv, CPython 3.12.14 |
| `h200-7:~/pkex/bin/job-env-check` | the check; read-only, exits 0 only with nvcc + ncu + torch + ≥1 GPU |
| `h200-7:~/pkex/runs/` | empty, reserved for later tickets' run artifacts |
| local `job-env-check.sh` | byte-identical copy of the remote script (the source of truth) |
| local `output.txt` | exact stdout of the acceptance run |
| local `output.err` | exact stderr (empty) |
| local `exit_code.txt` | `EXIT=0` |
| local `output.negative.txt`, `exit_code.negative.txt` | proof the failure path names its missing item and exits 1 |

## Commands run

```bash
# 1. create the env (nothing outside ~/pkex)
ssh builder 'mkdir -p ~/pkex/bin ~/pkex/runs'

# 2. venv + torch (cu130 index; uv fetches CPython 3.12 into ~/.local/share/uv)
ssh builder 'uv venv --python 3.12 ~/pkex/venv'
ssh builder 'uv pip install --python ~/pkex/venv/bin/python \
             --index-url https://download.pytorch.org/whl/cu130 torch'
ssh builder 'uv pip install --python ~/pkex/venv/bin/python numpy'   # torch works without it, but silences a warning and later tickets use it

# 3. install the check
scp job-env-check.sh builder:~/pkex/bin/job-env-check && ssh builder 'chmod +x ~/pkex/bin/job-env-check'

# 4. acceptance run, from a non-interactive shell with no inherited PATH
ssh -o BatchMode=yes builder '~/pkex/bin/job-env-check'   # exit 0

# 5. failure path (overrides exist only to make this testable)
ssh builder 'PKEX_CUDA_HOME=/nonexistent/cuda PKEX_NCU_HOME=/nonexistent/nsight \
             PKEX_VENV_PY=/nonexistent/python ~/pkex/bin/job-env-check'   # exit 1
```

## Versions installed

| Component | Version | Source |
|---|---|---|
| python | 3.12.14 | uv-managed CPython (`~/.local/share/uv/python/cpython-3.12-linux-x86_64-gnu`) |
| torch | 2.14.1+cu130 | `download.pytorch.org/whl/cu130` |
| torch.version.cuda | 13.0 | — |
| triton | 3.8.0 | same index |
| numpy | 2.5.4 | PyPI |
| nvcc | V13.0.88, release 13.0 | `/usr/local/cuda-13.0/bin` (pre-existing) |
| ncu | 2025.3.1.0 (build 36398880) | `/opt/nvidia/nsight-compute/2025.3.1` (pre-existing) |
| driver | 580.178.04 | pre-existing |

**Fallback: none taken.** The cu130 index carries a cp312 `manylinux_2_28_x86_64` wheel
(torch 2.14.1+cu130), so no cu12x downgrade was needed. The nvidia-* runtime deps it pulled are
all cu13 (`nvidia-cublas 13.1.1.3`, `nvidia-cudnn-cu13 9.24.0.43`, `nvidia-nccl-cu13 2.30.7`, …).

## Notes / caveats

- **Both `ncu` binaries are the same product.** `/usr/local/cuda-13.0/bin/ncu` (2699 B) is a
  launcher that `exec`s the NSight CLI; `/opt/nvidia/nsight-compute/2025.3.1/ncu` (310 B) is the
  same thing unpacked. They report an identical version string, and the script prints both so the
  evidence does not rest on that.
- **The board was busy during this ticket.** At run time all 8 cards showed ~124 GB used,
  `utilization.gpu 100 %`, `clocks.sm` 1515–1665 MHz (max 1980). This check only *reads* the board
  and does not need exclusivity, but T-003+ require an exclusive card.
- **Disk**: venv 5.3 GiB, plus ~23 GiB added to uv's global cache (`~/.cache/uv`) by the wheel
  downloads. Reclaimable with `uv cache clean`, deliberately **not** run (it is outside `~/pkex/`).
  `/` had 170 G free before the install.
- The check prints `interactive: no-tty`, which is the point: `nvcc`/`ncu` are invisible on the
  inherited non-interactive PATH, and the script's `export PATH=…` is what makes them visible.
