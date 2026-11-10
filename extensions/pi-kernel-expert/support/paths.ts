import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export const KERNEL_WIKI_SKILL = "kernel-wiki";
export const NCU_SKILL = "ncu-report-skill";

/**
 * The corpus this package fetches: our own maintained copy of
 * mit-han-lab/KernelWiki (MIT), pinned by commit.
 *
 * Three differences from upstream, recorded in ADR 0007: the skill is named
 * `kernel-wiki` so Agent Skills runtimes load it without a warning; the 19 files
 * marked LicenseRef-NvidiaProprietary are removed at the source and listed in
 * SANITIZED.yaml; and page ids are frozen because ids are the citation contract.
 * The fetch still scans for the restricted marker — an absence it did not
 * verify is an absence it cannot claim.
 *
 * Updating this pin means updating THIRD_PARTY_NOTICES.md and the changelog.
 */
export const KERNEL_WIKI_PIN = "70530df1cd089103e5bb8d688815bac9dceb8033";

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
