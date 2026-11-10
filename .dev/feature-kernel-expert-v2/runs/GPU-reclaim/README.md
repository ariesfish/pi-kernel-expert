# GPU reclaim, 2026-11-09

What was running on `h200-7` before the acceptance runs, and what was stopped.

## 1. Cryptominer (removed)

```
pid 1284431  /root/.a/sglang --algo pearlhash --url stratum+ssl://hk.pearlhash.net:9443 --user prl1p7te...
             root, 11 days 17 h, 1872 MiB on every card, parent = an interactive `-bash` (1284162)
/root/.a/    sglang (40 MB, disguised) · help.txt · readme.txt
             start-BitCore-zergpool.com.sh · start-BitCore-zpool.ca.sh · start-Evrmore.sh · start-Meowcoin.sh
```

Files owned by uid 1000, process run as root, hidden directory, multiple pool scripts. No
systemd/cron/bashrc persistence was found (grep over `/etc/systemd`, `/etc/cron*`, `/root/.bashrc`,
`/root/.profile`). Hashes recorded in `miner-sha256.txt`; the directory was deleted after the kill.

This is a security finding, not a scheduling one: it did not dominate the GPUs (1.8 GB/card), the
sglang deployment did.

## 2. The sglang deployment (stopped, restartable)

```
/tmp/lockgen/.venv/bin/python -m zlinfer.launch_server
  --model-path /data/cache/hub/models--deepseek-ai--DeepSeek-V4.1-Flash-1017/snapshots/1bae0e10...
  --served-model-name dsv41-flash --trust-remote-code --host 0.0.0.0 --port 30090
  --tp 8 --ep-size 8 --mem-fraction-static 0.85 --max-running-requests 64
  --chunked-prefill-size 8192 --max-prefill-tokens 8192 --fp8-gemm-backend deep_gemm
  --moe-runner-backend deep_gemm --disable-flashinfer-autotune
  --no-enable-decoder-swa-bounded-replay --cuda-graph-backend-decode disabled
  --cuda-graph-backend-prefill disabled --watchdog-timeout 3600 --moe-a2a-backend deepep
  --deepep-mode normal --enable-two-batch-overlap
cwd /root · PYTHONPATH=/root/zlinfer/engine/py · 8 schedulers TP0..TP7, 122 GB/card, 5 days 2 h
```

The user confirmed this was their own inference-engine test deployment. Stopped with SIGTERM on the
launcher (pid 491573); the children exited with it. The command line above is the restart recipe —
nothing in this repo depends on it being down.

Left alone: kubelet / rke2-agent / rancher-system-agent / node_exporter / telegraf / mooncake
master+http. Removing the node from its cluster was out of scope for getting a quiet card.

## 3. My own footprint

`uv cache clean` removed 154,834 files / 23.2 GiB. `~/pkex` (5.3 GiB: venv + fixtures) kept — every
later acceptance run needs it.

## State after

All 8 cards: 0 MiB used, 0 % util, SM 345 MHz parked (boosts to 1980 under load), 78–82 W.
