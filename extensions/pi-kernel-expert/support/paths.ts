import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export const KERNEL_WIKI_SKILL = "KernelWiki";
export const NCU_SKILL = "ncu-report-skill";

/**
 * kda's sanitized KernelWiki revision. Upstream HEAD and this revision differ:
 * the distributed tree omits 19 NVIDIA-proprietary CuTe DSL files. Fetching
 * anything else would both break the pin and change the license boundary.
 */
export const KERNEL_WIKI_PIN = "76d27b56f804e7e7295d4c570e1e5d7eef4b0a75";

export interface AgentLayout {
  /** Pi's agent directory; `PI_CODING_AGENT_DIR` overrides the default. */
  agentDir: string;
  /** Where fetched corpora live. Never inside the npm package. */
  cacheDir: string;
  kernelWikiDir: string;
  settingsPath: string;
}

export function agentLayout(
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
): AgentLayout {
  const configured = env.PI_CODING_AGENT_DIR?.trim();
  const agentDir = configured ? path.resolve(configured) : path.join(home, ".pi", "agent");
  const cacheDir = path.join(agentDir, "kernel-expert", "cache");
  return {
    agentDir,
    cacheDir,
    kernelWikiDir: path.join(cacheDir, `${KERNEL_WIKI_SKILL}@${KERNEL_WIKI_PIN}`),
    settingsPath: path.join(agentDir, "settings.json"),
  };
}

/** Package root from a module URL inside `extensions/<package-name>/...`. */
export function packageRootFrom(moduleUrl: string): string {
  return path.resolve(path.dirname(fileURLToPath(moduleUrl)), "..", "..", "..");
}

export function skillDir(packageRoot: string, name: string): string {
  return path.join(packageRoot, "skills", name);
}
