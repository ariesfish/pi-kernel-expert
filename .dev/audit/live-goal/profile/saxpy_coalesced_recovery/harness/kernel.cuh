#pragma once

__global__ void saxpy_candidate(int n, float a, const float *x, float *y) {
  const int i = blockIdx.x * blockDim.x + threadIdx.x;
  if (i < n) y[i] = a * x[i] + y[i];
}
