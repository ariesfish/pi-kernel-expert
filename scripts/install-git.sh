#!/usr/bin/env bash
# Install both Git packages globally, then verify pi's registered tools.
set -euo pipefail

if [[ $# -ne 0 ]]; then
  echo "Usage: bash scripts/install-git.sh" >&2
  exit 2
fi

if ! pi_bin=$(command -v pi); then
  echo "pi is not on PATH. Install pi before running this script." >&2
  exit 1
fi

"$pi_bin" install git:github.com/ariesfish/pi-goal
"$pi_bin" install git:github.com/ariesfish/pi-kernel-expert

install_tmp=$(mktemp -d "${TMPDIR:-/tmp}/pi-kernel-install.XXXXXX")
trap 'rm -rf -- "$install_tmp"' EXIT

cat > "$install_tmp/verify.mjs" <<'JS'
export default function (pi) {
  pi.registerCommand("kernel-stack-install-check", {
    description: "Verify the installed kernel tools and loop engine",
    handler() {
      const required = [
        "validate_goal", "init_goal", "start_goal", "frame_goal", "probe_goal",
        "freeze_criteria", "check_goal", "review_goal", "run_goal", "log_goal",
        "kernel_bootstrap", "kernel_wiki", "kernel_wiki_candidate", "kernel_init",
        "kernel_contract", "kernel_profile", "kernel_candidate", "kernel_milestone",
        "kernel_sass", "kernel_kb",
      ];
      const registered = new Set(pi.getAllTools().map((tool) => tool.name));
      const missing = required.filter((name) => !registered.has(name));
      if (missing.length > 0) {
        throw new Error(`Required tools did not load: ${missing.join(", ")}`);
      }
      console.log("PI_KERNEL_STACK_READY");
    },
  });
}
JS

# A slash command inspects the actual tool registry without calling a model.
# A temporary cwd keeps project filters and active research out of this global check.
if ! (cd "$install_tmp" && "$pi_bin" --no-session -e "$install_tmp/verify.mjs" -p /kernel-stack-install-check) > "$install_tmp/output" 2>&1; then
  cat "$install_tmp/output" >&2
  echo "Installation verification failed. Check pi's extension configuration and retry." >&2
  exit 1
fi
if ! grep -qx 'PI_KERNEL_STACK_READY' "$install_tmp/output"; then
  cat "$install_tmp/output" >&2
  echo "Installation verification failed: the required tools were not confirmed." >&2
  exit 1
fi

cat "$install_tmp/output"
echo "Git installation verified. Run /reload in an existing pi session."
echo "If kernel-wiki is not cached, run kernel_bootstrap, then /reload again."
