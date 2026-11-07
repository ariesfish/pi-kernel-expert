import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export const KERNEL_WIKI_SKILL = "KernelWiki";
export const NCU_SKILL = "ncu-report-skill";

/**
 * KernelWiki revision this package fetches.
 *
 * Chosen for the bundled pure-Python YAML fallback (upstream commit 7073fac),
 * so the query tools run without host PyYAML. The revision still carries 19
 * files marked LicenseRef-NvidiaProprietary — the same count as kda's older
 * pin — so the fetch prunes them and records the removal in SANITIZED.yaml.
 * Updating this pin means updating THIRD_PARTY_NOTICES.md and the changelog.
 */
export const KERNEL_WIKI_PIN = "b6b4301f15e8ce6955a56776690643ce5db369e6";

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
