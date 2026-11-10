# SAXPY fixture — real device time, a real host-bound control, and a group that fails

One kernel, three data sets, two measurement paths. It exists so T-003, T-005 and T-007 have
something real to point at: a bench that clocks the device, a wrapper that does not and admits it,
and a check that fails on a degenerate input the kernel actually gets wrong.

Built and run on **h200-7** (`ssh builder`), 2026-11-09, one card (`CUDA_VISIBLE_DEVICES=3`),
unlocked clocks. Archived evidence: `../../runs/T-003/` and `../../runs/T-005/`.

```
kernel.cu    SAXPY y[i] = a*x[i] + y[i] (fp32) + a CPU reference in double.
             `--group typical|zero_block|tail` builds the data set; `max_diff=%.10g`;
             exit 0 iff max_diff <= --tol (default 1e-6).
             `--impl fast` (default) is the candidate: an all-zero input fast path
             that stores 0 instead of leaving y untouched. `--impl plain` is the
             reference kernel; on the same zero_block data it is exact.
             Compiles twice: the `verify` CLI, and `libsaxpy.so` with
             `-DSAXPY_LIB` for the Python path.
bench.cu     Device time = cudaEventRecord around 50 back-to-back launches / 50.
             Host enqueue = steady_clock around 50 launches, no sync inside the
             window. Prints METRIC latency_us / device_ms / host_enqueue_ms.
             `--sleep-ms N` sleeps N ms before every launch in both windows: the
             negative control. `--metric-name` renames the first METRIC line.
bench_bad.py The same defect in Python: ctypes launch of libsaxpy.so, 2 ms sleep
             per call, wall clock around the whole loop reported as device_ms.
check.sh     Runs `verify` for $KERNEL_GROUP (default typical) and prints max_diff.
             Builds `verify` on first use (nvcc from PATH, else
             /usr/local/cuda-13.0/bin/nvcc). Exit non-zero on mismatch:
             zero_block is the group that fails, by construction.
make-workspace.mts  Writes a kernel_init-shaped workspace and a 1-cell / 3-group v2
             contract with the extension's own normalizeContract + writeContractFiles.
run-reading.sh      Runs goal.sh on one card with nvidia-smi sampled alongside it.
```

## Versions seen on the node

| Thing | Version |
|---|---|
| nvcc | `release 13.0, V13.0.88` (`/usr/local/cuda-13.0/bin/nvcc`) |
| CUDA runtime | 13.0 (`libcudart.so.13.0.96`) |
| Driver | 580.178.04 |
| GPU | 8x NVIDIA H200, 139.8 GiB, sm_90; card 3 idle (0 MiB, 0 %) at 345 MHz SM / 3201 MHz HBM |
| torch (venv) | 2.14.1+cu130 at `/root/pkex/venv/bin/python` — installed, **not used** by this fixture |
| python (system) | 3.10.12 — what `bench_bad.py` runs on; stdlib only (ctypes, subprocess) |

## Exact commands

On the node, from this directory (or a workspace root that has these files):

```bash
export PATH=/usr/local/cuda-13.0/bin:$PATH

nvcc -O3 -arch=sm_90 -o verify kernel.cu
nvcc -O3 -arch=sm_90 -o bench  bench.cu

./verify --n 1048576 --group typical                 # max_diff=1.192092896e-07, exit 0
./verify --n 1048576 --group tail                    # n=1048613, max_diff=1.192092896e-07, exit 0
./verify --n 1048576 --group zero_block              # max_diff=0.9999853373, exit 1  (the candidate's bug)
./verify --n 1048576 --group zero_block --impl plain  # max_diff=1.192092896e-07, exit 0  (same data, reference kernel)

./bench --n 1048576
# METRIC latency_us=4.563 / device_ms=0.004563 / host_enqueue_ms=0.002071  (~4.4-4.6 us device, ratio ~0.46)

./bench --n 1048576 --sleep-ms 2
# device_ms ~2.09, host_enqueue_ms ~2.09, ratio ~1.00 -> host_bound

NVCC=/usr/local/cuda-13.0/bin/nvcc ./bench_bad.py --n 1048576 --sleep-ms 2
# same three lines, ratio ~1.00 -> host_bound
```

Workspace + contract (locally, because it needs the extension's TypeScript):

```bash
node make-workspace.mts --root <dir> --bench "/root/pkex/ws-t003/bench --n 1048576"
node make-workspace.mts --root <dir> --bench "/root/pkex/ws-t005/bench --n 1048576 --sleep-ms 2"
```

Run, on the node, one card claimed explicitly:

```bash
CUDA_VISIBLE_DEVICES=3 bash goal.sh                 # first run records the baseline
CUDA_VISIBLE_DEVICES=3 bash goal.sh                 # second run compares; reading block on stdout
CUDA_VISIBLE_DEVICES=3 bash goal.checks.sh          # exits 1: FAIL cell saxpy group zero_block pass 1
```

## Which negative control the archive uses

The archived T-005 reading is the **C++ `--sleep-ms 2`** path. It differs from the honest run by one
argument, so the only variable is the sleep — that isolates the defect. `bench_bad.py` was run too
(`runs/T-005/reading-host-bound-python.txt`, ratio 1.0012) to show the same failure through a real
ctypes launch rather than a C++ `printf`, so it is kept as corroboration, not as the primary.

## Things this fixture deliberately does not do

- No clock lock: the honest reading's start sample (345 MHz) and end sample (1980 MHz) are whatever
  the driver reported. A locked comparison is a separate T-003 criterion and needs the operator.
- No torch: `device_ms` comes from CUDA events in C++, not from `torch.cuda.Event`. The venv is
  there for the tickets that need it.
- `max_diff` is measured in double from the original `y`, so it is the kernel's error and not the
  CPU reference's.
