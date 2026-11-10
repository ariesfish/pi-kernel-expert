// kernel.cu — SAXPY y[i] = a*x[i] + y[i] over fp32, N from argv.
//
// The fixture exists to give T-003 / T-005 / T-007 a real measurement over real
// device time. It is deliberately small: one kernel, one CPU reference, one
// max_diff, and an input-group switch so the checks can iterate data sets.
//
// Two implementations, because a group is only worth iterating if a group can
// fail:
//   plain  — every index bounds-checked, one multiply-add. Correct.
//   fast   — a plausible "nothing to add" fast path: when x[i] is exactly zero
//            it stores zero instead of leaving y[i] untouched. Wrong whenever
//            y[i] != 0. It stands in for the class of bug the zero_block group
//            is there to catch. It is the DEFAULT, because it is the candidate
//            under test: correct on typical and tail, wrong on zero_block.
//   `--impl plain` is the reference kernel; T-008 uses it to measure the
//   reference's own error against the same data.
//
// Build CLI:     nvcc -O3 -arch=sm_90 -o verify kernel.cu
// Build shared:  nvcc -O3 -arch=sm_90 -shared -Xcompiler -fPIC -DSAXPY_LIB \
//                     -o libsaxpy.so kernel.cu      (used by bench_bad.py)
//
// Modes:
//   verify --n <N> [--group typical|zero_block|tail] [--impl plain|fast]
//          [--seed <n>] [--a <float>] [--tol <float>]
// Prints one line `max_diff=<v>` (%.10g) and exits 0 when max_diff <= tol.
//
// Group shapes (the data sets the checks iterate):
//   typical    — N random fp32 in [-1, 1) for x and y, a = 2.5.
//   zero_block — the same data, but [N/4, N/2) of x is exactly 0. With the
//                fast impl this is the failing group.
//   tail       — N + 37 (not a multiple of the 256-thread block) so the last
//                partial block is exercised.
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <cmath>
#include <string>
#include <vector>

#include <cuda_runtime.h>

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

// The reference implementation: one multiply-add, bounds-checked.
__global__ void saxpy_plain(int n, float a, const float *x, float *y) {
  const int i = blockIdx.x * blockDim.x + threadIdx.x;
  if (i < n) y[i] = a * x[i] + y[i];
}

// The injected fault: an "all-zero input means nothing to add" fast path that
// stores zero instead of leaving y alone. Only the zero_block group reaches it.
__global__ void saxpy_fast(int n, float a, const float *x, float *y) {
  const int i = blockIdx.x * blockDim.x + threadIdx.x;
  if (i >= n) return;
  if (x[i] == 0.0f) {
    y[i] = 0.0f;
    return;
  }
  y[i] = a * x[i] + y[i];
}

// splitmix32: deterministic data, so a run is reproducible from its seed alone.
static inline float next_uniform(unsigned int &state) {
  state += 0x9e3779b9u;
  unsigned int z = state;
  z = (z ^ (z >> 16)) * 0x21f0aaadu;
  z = (z ^ (z >> 15)) * 0x735a2d97u;
  z = z ^ (z >> 15);
  return (static_cast<float>(z) / 2147483648.0f) - 1.0f;  // [-1, 1)
}

static void fill(std::vector<float> &v, unsigned int &state) {
  for (float &value : v) value = next_uniform(state);
}

#ifndef SAXPY_LIB
static int usage(const char *argv0) {
  std::fprintf(stderr,
               "usage: %s --n <N> [--group typical|zero_block|tail] "
               "[--impl plain|fast] [--seed <n>] [--a <float>] [--tol <float>]\n",
               argv0);
  std::fprintf(stderr, "prints max_diff=<v> and exits non-zero on mismatch\n");
  return 2;
}

int main(int argc, char **argv) {
  int n = 1 << 20;
  std::string group = "typical";
  // The candidate under test. `--impl plain` is the reference implementation.
  std::string impl = "fast";
  unsigned int seed = 12345u;
  float a = 2.5f;
  double tol = 1e-6;

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
    else if (arg == "--group") group = value("--group");
    else if (arg == "--impl") impl = value("--impl");
    else if (arg == "--seed") seed = static_cast<unsigned int>(std::strtoul(value("--seed"), nullptr, 10));
    else if (arg == "--a") a = std::strtof(value("--a"), nullptr);
    else if (arg == "--tol") tol = std::strtod(value("--tol"), nullptr);
    else return usage(argv[0]);
  }

  // The group decides the data, never the arithmetic: same a, same formula.
  if (group == "tail") {
    n += 37;  // partial last block
  } else if (group != "typical" && group != "zero_block") {
    std::fprintf(stderr, "unknown group \"%s\"\n", group.c_str());
    return usage(argv[0]);
  }
  if (n <= 0) {
    std::fprintf(stderr, "--n must be positive, got %d\n", n);
    return 2;
  }
  if (impl != "plain" && impl != "fast") {
    std::fprintf(stderr, "unknown impl \"%s\" (plain|fast)\n", impl.c_str());
    return 2;
  }

  std::vector<float> hx(static_cast<size_t>(n));
  std::vector<float> hy(static_cast<size_t>(n));
  unsigned int state = seed;
  fill(hx, state);
  fill(hy, state);
  if (group == "zero_block") {
    // A degenerate quarter of the input: exactly zero, with y left non-zero.
    for (int i = n / 4; i < n / 2; ++i) hx[static_cast<size_t>(i)] = 0.0f;
  }

  float *dx = nullptr;
  float *dy = nullptr;
  CUDA_CHECK(cudaMalloc(&dx, sizeof(float) * static_cast<size_t>(n)));
  CUDA_CHECK(cudaMalloc(&dy, sizeof(float) * static_cast<size_t>(n)));
  CUDA_CHECK(cudaMemcpy(dx, hx.data(), sizeof(float) * static_cast<size_t>(n), cudaMemcpyHostToDevice));
  CUDA_CHECK(cudaMemcpy(dy, hy.data(), sizeof(float) * static_cast<size_t>(n), cudaMemcpyHostToDevice));

  const int grid = (n + kBlock - 1) / kBlock;
  if (impl == "fast") {
    saxpy_fast<<<grid, kBlock>>>(n, a, dx, dy);
  } else {
    saxpy_plain<<<grid, kBlock>>>(n, a, dx, dy);
  }
  CUDA_CHECK(cudaGetLastError());
  CUDA_CHECK(cudaDeviceSynchronize());

  std::vector<float> got(static_cast<size_t>(n));
  CUDA_CHECK(cudaMemcpy(got.data(), dy, sizeof(float) * static_cast<size_t>(n), cudaMemcpyDeviceToHost));
  CUDA_CHECK(cudaFree(dx));
  CUDA_CHECK(cudaFree(dy));

  // The reference is computed in double from the ORIGINAL y, so the only error
  // measured is the kernel's.
  double max_diff = 0.0;
  for (int i = 0; i < n; ++i) {
    const double want = static_cast<double>(a) * static_cast<double>(hx[static_cast<size_t>(i)]) +
                        static_cast<double>(hy[static_cast<size_t>(i)]);
    const double diff = std::fabs(want - static_cast<double>(got[static_cast<size_t>(i)]));
    if (!(diff <= max_diff)) max_diff = diff;  // NaN stays NaN
  }

  std::printf("verify n=%d group=%s impl=%s a=%g seed=%u tol=%g\n", n, group.c_str(), impl.c_str(), a, seed, tol);
  std::printf("max_diff=%.10g\n", max_diff);
  return (max_diff <= tol) ? 0 : 1;
}
#endif  // SAXPY_LIB

#ifdef SAXPY_LIB
// The launch entry bench_bad.py calls through ctypes. One kernel launch, no
// synchronization: the caller owns the stream's fate, which is exactly how the
// Python wrapper ends up timing its own sleeps.
extern "C" int saxpy_launch(int n, float a, const float *x, float *y, int impl_fast) {
  if (n <= 0) return -1;
  const int grid = (n + kBlock - 1) / kBlock;
  if (impl_fast) {
    saxpy_fast<<<grid, kBlock>>>(n, a, x, y);
  } else {
    saxpy_plain<<<grid, kBlock>>>(n, a, x, y);
  }
  return static_cast<int>(cudaGetLastError());
}

extern "C" int saxpy_sync(void) { return static_cast<int>(cudaDeviceSynchronize()); }
#endif  // SAXPY_LIB
