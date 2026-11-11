import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { repo } from "./runtime.mjs";

export function attachProfile(state) {
  const runId = "saxpy_coalesced_recovery";
  const remoteRun = `${state.remote}/profile/${runId}`;
  const localRun = path.join(state.root, "profile", runId);
  const ssh = (command, timeout = 120000) => execFileSync("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", state.host, command], { encoding: "utf8", timeout, maxBuffer: 16 * 1024 * 1024 });
  assert.ok(!fs.existsSync(localRun), "One directory per profile run");
  const existingReport = ssh(`test -f '${remoteRun}/reports/full.ncu-rep' && printf yes || true`) === "yes";
  if (!existingReport) ssh(`test ! -e '${remoteRun}' && mkdir -p '${remoteRun}/reports' '${remoteRun}/analysis' '${remoteRun}/harness' '${state.remote}/helpers'`);
  for (const name of ["ncu_utils.py", "analyze_reports.py", "extract_stall_hotspots.py", "plot_timeline.py"]) {
    execFileSync("scp", ["-q", path.join(repo, "skills/ncu-report-skill/helpers", name), `${state.host}:${state.remote}/helpers/${name}`], { timeout: 20000 });
  }
  const command = `cd '${state.remote}' && cp harness.cu src/kernel.cuh task '${remoteRun}/harness/' && CUDA_VISIBLE_DEVICES=${state.gpu} KERNEL_GROUP=typical /opt/nvidia/nsight-compute/2025.3.1/ncu --set full --import-source yes --clock-control none -k regex:saxpy_candidate -c 1 -o '${remoteRun}/reports/full.ncu-rep' ./task check`;
  const collection = existingReport ? "Resumed analysis of the existing immutable report; no new collection.\n" : ssh(command);
  ssh(`printf '%s\\n' 'CUDA_VISIBLE_DEVICES=${state.gpu}; ncu 2025.3.1; --set full --import-source yes --clock-control none -k regex:saxpy_candidate -c 1; ./task check' > '${remoteRun}/collection-command.txt'`);
  const prefix = `cd '${state.remote}' && export PATH=/usr/local/cuda-13.0/bin:/opt/nvidia/nsight-compute/2025.3.1:$PATH; `;
  let analysis = "";
  for (const helper of ["analyze_reports.py", "extract_stall_hotspots.py", "plot_timeline.py"]) {
    const binary = helper === "extract_stall_hotspots.py" ? ` --binary '${state.remote}/task'` : "";
    try {
      analysis += ssh(`${prefix}python3 helpers/${helper} --run-dir '${remoteRun}' --report '${remoteRun}/reports/full.ncu-rep' --tag full${binary}`);
    } catch (error) {
      if (helper !== "plot_timeline.py") throw error;
      // Match kernel_profile: timelines are optional; retain the peer-version
      // failure instead of fabricating a timeline or modifying vendored code.
      analysis += `\nOPTIONAL TIMELINE UNAVAILABLE:\n${error.stderr ?? error.message}\n`;
    }
  }
  fs.mkdirSync(path.dirname(localRun), { recursive: true });
  execFileSync("scp", ["-q", "-r", `${state.host}:${remoteRun}`, localRun], { timeout: 60000 });
  fs.writeFileSync(path.join(localRun, "collection.stdout"), collection);
  fs.writeFileSync(path.join(localRun, "helpers.stdout"), analysis);
  const adapters = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kernel-profile-tools-"));
  fs.writeFileSync(path.join(adapters, "ncu"), `#!/usr/bin/env bash\nexec ssh -o BatchMode=yes ${state.host} /opt/nvidia/nsight-compute/2025.3.1/ncu \"$@\"\n`);
  fs.writeFileSync(path.join(adapters, "nvidia-smi"), `#!/usr/bin/env bash\nfor arg in \"$@\"; do\n  if [[ \"$arg\" == -i ]]; then exec ssh -o BatchMode=yes ${state.host} nvidia-smi \"$@\"; fi\ndone\nexec ssh -o BatchMode=yes ${state.host} nvidia-smi -i ${state.gpu} \"$@\"\n`);
  for (const name of ["ncu", "nvidia-smi"]) fs.chmodSync(path.join(adapters, name), 0o755);
  return { runId, localRun, adapters, report: `profile/${runId}/reports/full.ncu-rep` };
}
