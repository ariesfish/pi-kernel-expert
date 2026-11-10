# T-006 — same-job pairing, live on card 3

`h200-7`, card 3, driver 580.178.04, clocks unlocked (loaded sample: 1980 MHz of 1980).

```
benchmarkCommand  bench --n 1048576          --metric-name latency_us
referenceCommand  bench --n 1048576 --a 1.5  --metric-name latency_us
burnInMs 400
```

The reference is the **same kernel with a different `a`**: a null-pair control. It is deliberately
not a speedup demonstration — what it tests is the mirror itself.

| Field | Value |
|---|---|
| `pairing` | `mirrored` |
| `pairRatios` | `[0.9821422927, 1.014124794]` |
| `pairSpreadPct` | `3.204230688` (admissible: ≤ 5) |
| `METRIC paired_speedup` | `0.998005436` |
| `METRIC geomean_speedup` | `1` (baseline run; the cross-run path is unchanged) |

Two readings of the same code differ by 3.2% between the first and second pair; their mean reads
0.998, i.e. the mirror is unbiased to ~0.2% while the individual windows carry the 3% the protocol
exists to cancel. A biased mirror would put that 3% on one side permanently and it would show up as
`paired_speedup` ≠ 1.

`runs/T-006/paired.stdout` holds the full run, `paired.gpu.txt` the card state beside it.
