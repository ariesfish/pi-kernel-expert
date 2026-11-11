#include <cuda_runtime.h>
#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <string>
#include <vector>
#include "kernel.cuh"

#define CUDA_OK(call) do { const auto e = (call); if (e != cudaSuccess) { std::fprintf(stderr, "%s: %s\n", #call, cudaGetErrorString(e)); std::exit(2); } } while (0)

__global__ void saxpy_reference(int n, float a, const float *x, float *y) {
  const int i = blockIdx.x * blockDim.x + threadIdx.x;
  if (i < n) y[i] = a * x[i] + y[i];
}

int main(int argc, char **argv) {
  const std::string mode = argc > 1 ? argv[1] : "check";
  const char *groupEnv = std::getenv("KERNEL_GROUP");
  const std::string group = groupEnv && *groupEnv ? groupEnv : "typical";
  const bool reference = mode == "reference" || mode == "calibrate";
  const bool check = mode == "check" || mode == "calibrate";
  const int n = (1 << 24) + (group == "tail" ? 37 : 0);
  const int block = argc > 2 ? std::atoi(argv[2]) : 256;
  if (block < 32 || block > 1024 || (group != "typical" && group != "zero_block" && group != "tail")) return 2;
  const int grid = (n + block - 1) / block;
  const float a = 2.5f;
  std::vector<float> x(n), y(n), got(n);
  for (int i = 0; i < n; ++i) {
    x[i] = (static_cast<float>((i * 17u + 13u) % 1024u) - 512.0f) / 512.0f;
    y[i] = (static_cast<float>((i * 29u + 19u) % 1024u) - 512.0f) / 512.0f;
    if (group == "zero_block" && i >= n / 4 && i < n / 2) x[i] = 0.0f;
  }
  float *dx, *dy;
  const size_t bytes = static_cast<size_t>(n) * sizeof(float);
  CUDA_OK(cudaMalloc(&dx, bytes)); CUDA_OK(cudaMalloc(&dy, bytes));
  CUDA_OK(cudaMemcpy(dx, x.data(), bytes, cudaMemcpyHostToDevice));
  CUDA_OK(cudaMemcpy(dy, y.data(), bytes, cudaMemcpyHostToDevice));
  auto launch = [&]() {
    if (reference) saxpy_reference<<<grid, block>>>(n, a, dx, dy);
    else saxpy_candidate<<<grid, block>>>(n, a, dx, dy);
  };
  if (check) {
    launch(); CUDA_OK(cudaGetLastError()); CUDA_OK(cudaDeviceSynchronize());
    CUDA_OK(cudaMemcpy(got.data(), dy, bytes, cudaMemcpyDeviceToHost));
    double error = 0;
    for (int i = 0; i < n; ++i) {
      const double want = static_cast<double>(a) * x[i] + y[i];
      const double diff = std::fabs(static_cast<double>(got[i]) - want);
      if (!std::isfinite(diff)) { error = INFINITY; break; }
      error = std::max(error, diff);
    }
    const char *atol = std::getenv("KERNEL_ATOL");
    const double tolerance = atol && *atol ? std::strtod(atol, nullptr) : 1e-6;
    std::printf("elements=%d group=%s implementation=%s max_diff=%.10g\n", n, group.c_str(), reference ? "reference" : "candidate", error);
    CUDA_OK(cudaFree(dx)); CUDA_OK(cudaFree(dy));
    return std::isfinite(error) && error <= tolerance ? 0 : 1;
  }
  constexpr int warmup = 50, launches = 100;
  for (int i = 0; i < warmup; ++i) launch();
  CUDA_OK(cudaGetLastError()); CUDA_OK(cudaDeviceSynchronize());
  cudaEvent_t start, stop;
  CUDA_OK(cudaEventCreate(&start)); CUDA_OK(cudaEventCreate(&stop));
  CUDA_OK(cudaEventRecord(start));
  for (int i = 0; i < launches; ++i) launch();
  CUDA_OK(cudaEventRecord(stop)); CUDA_OK(cudaEventSynchronize(stop)); CUDA_OK(cudaGetLastError());
  float elapsed; CUDA_OK(cudaEventElapsedTime(&elapsed, start, stop));
  const auto hostStart = std::chrono::steady_clock::now();
  for (int i = 0; i < launches; ++i) launch();
  const auto hostEnd = std::chrono::steady_clock::now();
  CUDA_OK(cudaDeviceSynchronize()); CUDA_OK(cudaGetLastError());
  CUDA_OK(cudaMemcpy(got.data(), dy, bytes, cudaMemcpyDeviceToHost));
  double checksum = 0;
  for (int i = 0; i < n; i += 4096) checksum += got[i];
  if (!std::isfinite(checksum)) return 1;
  std::printf("METRIC latency_us=%.6f\n", elapsed * 1000.0 / launches);
  std::printf("METRIC device_ms=%.9f\n", elapsed / launches);
  std::printf("METRIC host_enqueue_ms=%.9f\n", std::chrono::duration<double, std::milli>(hostEnd - hostStart).count() / launches);
  std::fprintf(stderr, "elements=%d launches=%d group=%s checksum=%.9g\n", n, launches, group.c_str(), checksum);
  CUDA_OK(cudaEventDestroy(start)); CUDA_OK(cudaEventDestroy(stop));
  CUDA_OK(cudaFree(dx)); CUDA_OK(cudaFree(dy));
  return 0;
}
