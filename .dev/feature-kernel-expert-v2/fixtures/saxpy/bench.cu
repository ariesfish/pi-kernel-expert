// bench.cu — the honest benchmark for the SAXPY fixture.
//
// Two clocks, never mixed:
//   device_ms        — cudaEventRecord around 50 back-to-back launches,
//                      divided by 50. The GPU is busy for the whole window, so
//                      the number is the kernel's device time.
//   host_enqueue_ms  — steady_clock around the same 50 launches with no
//                      synchronize inside the clock; the synchronize happens
//                      after the clock stops. This is dispatch cost.
//
// `--sleep-ms N` puts a host sleep before each launch in BOTH windows. It is the
// negative control (T-005): a wrapper that sleeps between launches and times the
// whole loop with a wall clock calls the result "device time". With N=2 the
// reading's hostBoundRatio must clear 0.5. Nothing else about the measurement
// changes, which is the point — the defect is one sleep, not a second harness.
//
// Output (exactly, one line each, metric first because the generated script
// takes the first METRIC line as the cell's value):
//   METRIC latency_us=<device_ms * 1000>
//   METRIC device_ms=<v>
//   METRIC host_enqueue_ms=<v>
//
// Build: nvcc -O3 -arch=sm_90 -o bench bench.cu
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <thread>

#include <cuda_runtime.h>

// The default layout is a compile-time choice, so "optimize the kernel" can mean
// "rebuild it" without touching the frozen benchmark command (T-019).
#ifndef SAXPY_DEFAULT_MODE
#define SAXPY_DEFAULT_MODE "coalesced"
#endif

#define CUDA_CHECK(call)                                                      \
  do {                                                                        \
    cudaError_t err__ = (call);                                               \
    if (err__ != cudaSuccess) {                                               \
      std::fprintf(stderr, "%s:%d: %s -> %s\n", __FILE__, __LINE__, #call,    \
                   cudaGetErrorString(err__));                                \
      std::exit(2);                                                           \
    }                                                                         \
  } while (0)

static constexpr int kBlock = 256;
static constexpr int kLaunches = 50;
static constexpr int kWarmup = 20;

// Two layouts of the same arithmetic. `coalesced` is the ordinary mapping:
// consecutive threads read consecutive words, so one warp's 32 loads land in
// four 32-byte sectors. `strided` keeps every thread on a fixed stride across
// the grid, which is correct and destroys coalescing — it is the naive baseline
// a real first version often has, and the pair is what T-019 promotes from.
__global__ void saxpy_coalesced(int n, float a, const float *x, float *y) {
  const int i = blockIdx.x * blockDim.x + threadIdx.x;
  if (i < n) y[i] = a * x[i] + y[i];
}

__global__ void saxpy_strided(int n, float a, const float *x, float *y) {
  for (int i = threadIdx.x * gridDim.x + blockIdx.x; i < n;
       i += blockDim.x * gridDim.x) {
    y[i] = a * x[i] + y[i];
  }
}

__global__ void init(float *x, float *y, int n) {
  const int i = blockIdx.x * blockDim.x + threadIdx.x;
  if (i < n) {
    x[i] = 1.0f;
    y[i] = 1.0f;
  }
}

static void sleep_ms(double ms) {
  if (ms <= 0.0) return;
  const auto us = static_cast<long long>(ms * 1000.0);
  std::this_thread::sleep_for(std::chrono::microseconds(us));
}

int main(int argc, char **argv) {
  int n = 1 << 20;
  int launches = kLaunches;
  int warmup = kWarmup;
  double sleep_for_ms = 0.0;
  float a = 2.5f;
  std::string metric_name = "latency_us";
  std::string mode = SAXPY_DEFAULT_MODE;

  for (int i = 1; i < argc; ++i) {
    const std::string arg = argv[i];
    auto value = [&](const char *flag) -> const char * {
      if (i + 1 >= argc) {
        std::fprintf(stderr, "%s needs a value\n", flag);
        std::exit(2);
      }
      return argv[++i];
    };
    if (arg == "--n") n = std::atoi(value("--n"));
    else if (arg == "--launches") launches = std::atoi(value("--launches"));
    else if (arg == "--warmup") warmup = std::atoi(value("--warmup"));
    else if (arg == "--sleep-ms") sleep_for_ms = std::strtod(value("--sleep-ms"), nullptr);
    else if (arg == "--a") a = std::strtof(value("--a"), nullptr);
    else if (arg == "--metric-name") metric_name = value("--metric-name");
    else if (arg == "--mode") mode = value("--mode");
    else {
      std::fprintf(stderr,
                   "usage: %s [--n <N>] [--launches <n>] [--warmup <n>] "
                   "[--sleep-ms <f>] [--a <f>] [--metric-name <name>] "
                   "[--mode coalesced|strided]\n",
                   argv[0]);
      return 2;
    }
  }
  if (n <= 0 || launches <= 0 || warmup < 0 || sleep_for_ms < 0.0) {
    std::fprintf(stderr, "n and launches must be positive, warmup and sleep-ms non-negative\n");
    return 2;
  }

  if (mode != "coalesced" && mode != "strided") {
    std::fprintf(stderr, "--mode must be coalesced or strided, got %s\n", mode.c_str());
    return 2;
  }
  std::fprintf(stderr, "bench n=%d launches=%d warmup=%d sleep_ms=%g a=%g mode=%s\n", n, launches, warmup,
               sleep_for_ms, a, mode.c_str());

  const size_t bytes = sizeof(float) * static_cast<size_t>(n);
  float *x = nullptr;
  float *y = nullptr;
  CUDA_CHECK(cudaMalloc(&x, bytes));
  CUDA_CHECK(cudaMalloc(&y, bytes));
  const int grid = (n + kBlock - 1) / kBlock;
  const bool strided = mode == "strided";
  auto launch = [&]() {
    if (strided) saxpy_strided<<<grid, kBlock>>>(n, a, x, y);
    else saxpy_coalesced<<<grid, kBlock>>>(n, a, x, y);
  };
  init<<<grid, kBlock>>>(x, y, n);
  CUDA_CHECK(cudaGetLastError());

  // Warm the device (and, incidentally, the clock): 20 untimed launches.
  for (int i = 0; i < warmup; ++i) launch();
  CUDA_CHECK(cudaGetLastError());
  CUDA_CHECK(cudaDeviceSynchronize());

  // --- device time: events around the whole set of launches ---------------
  cudaEvent_t start;
  cudaEvent_t stop;
  CUDA_CHECK(cudaEventCreate(&start));
  CUDA_CHECK(cudaEventCreate(&stop));
  CUDA_CHECK(cudaEventRecord(start));
  for (int i = 0; i < launches; ++i) {
    sleep_ms(sleep_for_ms);
    launch();
  }
  CUDA_CHECK(cudaEventRecord(stop));
  CUDA_CHECK(cudaEventSynchronize(stop));
  CUDA_CHECK(cudaGetLastError());
  float device_ms_total = 0.0f;
  CUDA_CHECK(cudaEventElapsedTime(&device_ms_total, start, stop));
  const double device_ms = static_cast<double>(device_ms_total) / launches;
  CUDA_CHECK(cudaEventDestroy(start));
  CUDA_CHECK(cudaEventDestroy(stop));

  // --- host enqueue: wall clock, no synchronize inside the window ---------
  // Drain the device first so the clock does not include the previous window.
  CUDA_CHECK(cudaDeviceSynchronize());
  const auto t0 = std::chrono::steady_clock::now();
  for (int i = 0; i < launches; ++i) {
    sleep_ms(sleep_for_ms);
    launch();
  }
  const auto t1 = std::chrono::steady_clock::now();
  CUDA_CHECK(cudaDeviceSynchronize());
  CUDA_CHECK(cudaGetLastError());
  const double host_enqueue_ms =
      std::chrono::duration<double, std::milli>(t1 - t0).count() / launches;

  CUDA_CHECK(cudaFree(x));
  CUDA_CHECK(cudaFree(y));

  std::printf("METRIC %s=%.3f\n", metric_name.c_str(), device_ms * 1000.0);
  std::printf("METRIC device_ms=%.6f\n", device_ms);
  std::printf("METRIC host_enqueue_ms=%.6f\n", host_enqueue_ms);
  return 0;
}
