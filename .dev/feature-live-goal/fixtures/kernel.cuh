#pragma once

// Deliberately strided baseline. Candidate edits stay in this file.
__global__ void saxpy_candidate(int n, float a, const float *x, float *y) {
  for (int i = threadIdx.x * gridDim.x + blockIdx.x; i < n;
       i += blockDim.x * gridDim.x) {
    y[i] = a * x[i] + y[i];
  }
}
