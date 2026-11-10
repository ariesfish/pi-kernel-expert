#!/usr/bin/env python3
"""bench_bad.py — a deliberately broken enqueue path, in Python.

The defect is one line of measurement, not of arithmetic: every call sleeps
`sleep_ms` (default 2 ms) on the host, and `device_ms` is the wall clock around
the whole loop. With no device clock in Python, `host_enqueue_ms` is measured the
same way, so the two numbers are the same measurement and their ratio is ~1. A
reading built from this output must be refused as host_bound; if it is not, the
precondition is broken.

This is the Python twin of `bench --sleep-ms 2`. The archived T-005 evidence uses
the C++ path, because it differs from the honest run by exactly one argument and
therefore isolates the defect; this file exists so the same story can be told
with a real ctypes launch, and so a reviewer can see that the failure is not a
C++ printf trick.

It calls the same compiled kernel through libsaxpy.so (built from kernel.cu on
first use) and allocates through libcudart, so it needs nothing but nvcc and a
CUDA runtime.

    ./bench_bad.py --n 1048576 --sleep-ms 2
"""
import argparse
import ctypes
import ctypes.util
import glob
import os
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
NVCC = os.environ.get("NVCC", "nvcc")


def load_runtime():
    names = [ctypes.util.find_library("cudart")]
    names.extend(sorted(glob.glob("/usr/local/cuda*/lib64/libcudart.so*"), reverse=True))
    for name in names:
        if not name:
            continue
        try:
            return ctypes.CDLL(name)
        except OSError:
            continue
    sys.exit("bench_bad.py: no libcudart found (tried find_library and /usr/local/cuda*/lib64)")


def build_shim():
    lib = os.path.join(HERE, "libsaxpy.so")
    if os.path.exists(lib):
        return lib
    print(f"bench_bad.py: building {lib} from kernel.cu", file=sys.stderr)
    subprocess.run(
        [NVCC, "-O3", "-arch=sm_90", "-shared", "-Xcompiler", "-fPIC", "-DSAXPY_LIB",
         "-o", lib, os.path.join(HERE, "kernel.cu")],
        check=True,
    )
    return lib


def main():
    parser = argparse.ArgumentParser(description="the T-005 negative control in Python")
    parser.add_argument("--n", type=int, default=1 << 20)
    parser.add_argument("--launches", type=int, default=50)
    parser.add_argument("--warmup", type=int, default=20)
    parser.add_argument("--sleep-ms", type=float, default=2.0)
    parser.add_argument("--a", type=float, default=2.5)
    parser.add_argument("--metric-name", default="latency_us")
    args = parser.parse_args()

    rt = load_runtime()
    lib = ctypes.CDLL(build_shim())
    lib.saxpy_launch.argtypes = [ctypes.c_int, ctypes.c_float, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_int]
    lib.saxpy_launch.restype = ctypes.c_int
    lib.saxpy_sync.restype = ctypes.c_int

    bytes_n = ctypes.sizeof(ctypes.c_float) * args.n
    x = ctypes.c_void_p()
    y = ctypes.c_void_p()
    rt.cudaMalloc(ctypes.byref(x), bytes_n)
    rt.cudaMalloc(ctypes.byref(y), bytes_n)
    rt.cudaMemset(x, 0, bytes_n)
    rt.cudaMemset(y, 0, bytes_n)

    def launch():
        if args.sleep_ms > 0:
            time.sleep(args.sleep_ms / 1000.0)
        rc = lib.saxpy_launch(args.n, args.a, x, y, 0)
        if rc != 0:
            sys.exit(f"bench_bad.py: saxpy_launch failed with {rc}")

    for _ in range(args.warmup):
        launch()
    lib.saxpy_sync()

    # "device time": a wall clock around 50 launches, sleeps included. There is
    # no device clock here, and nothing below pretends otherwise.
    t0 = time.perf_counter()
    for _ in range(args.launches):
        launch()
    t1 = time.perf_counter()
    lib.saxpy_sync()
    device_ms = (t1 - t0) / args.launches * 1000.0

    # "enqueue time": the same measurement again, because a Python wrapper has
    # only one clock. That equality is the defect the reading must catch.
    t0 = time.perf_counter()
    for _ in range(args.launches):
        launch()
    t1 = time.perf_counter()
    lib.saxpy_sync()
    host_enqueue_ms = (t1 - t0) / args.launches * 1000.0

    rt.cudaFree(x)
    rt.cudaFree(y)

    print(f"METRIC {args.metric_name}={device_ms * 1000.0:.3f}")
    print(f"METRIC device_ms={device_ms:.6f}")
    print(f"METRIC host_enqueue_ms={host_enqueue_ms:.6f}")


if __name__ == "__main__":
    main()
