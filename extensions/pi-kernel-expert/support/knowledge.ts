import * as fs from "node:fs";
import * as path from "node:path";

import {
  KERNEL_WIKI_PIN,
  KERNEL_WIKI_SKILL,
  NCU_SKILL,
  type AgentLayout,
  skillDir,
} from "./paths.ts";

export interface VendoredSkillStatus {
  name: string;
  path: string;
  present: boolean;
  /** Full commit SHA from VENDORED.yaml, or null when absent/unreadable. */
  revision: string | null;
}

export interface KernelWikiStatus {
  path: string;
  pin: string;
  present: boolean;
}

export type LoopEngineState = "installed" | "missing" | "unknown";

export interface LoopEngineStatus {
  settingsPath: string;
  state: LoopEngineState;
}

export interface KnowledgeReport {
  version: string;
  packageRoot: string;
  ncu: VendoredSkillStatus;
  kernelWiki: KernelWikiStatus;
  loopEngine: LoopEngineStatus;
}

export function readVendoredRevision(dir: string): string | null {
  const file = path.join(dir, "VENDORED.yaml");
  if (!fs.existsSync(file)) return null;
  const match = /^revision:\s*([0-9a-f]{7,40})\s*$/m.exec(fs.readFileSync(file, "utf8"));
  return match ? match[1] : null;
}

export function readPackageVersion(packageRoot: string): string {
  const file = path.join(packageRoot, "package.json");
  if (!fs.existsSync(file)) return "unknown";
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Pi settings list packages either as strings or as `{ source }` objects in
 * project overrides. The loop engine is present when any entry names pi-goal.
 */
export function inspectLoopEngine(settingsPath: string): LoopEngineStatus {
  if (!fs.existsSync(settingsPath)) return { settingsPath, state: "unknown" };
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as { packages?: unknown };
    if (!Array.isArray(parsed.packages)) return { settingsPath, state: "unknown" };
    const installed = parsed.packages.some((entry) => {
      const source = typeof entry === "string" ? entry : (entry as { source?: unknown })?.source;
      return typeof source === "string" && source.includes("pi-goal");
    });
    return { settingsPath, state: installed ? "installed" : "missing" };
  } catch {
    return { settingsPath, state: "unknown" };
  }
}

export function inspectKnowledge(options: {
  packageRoot: string;
  layout: AgentLayout;
}): KnowledgeReport {
  const ncuPath = skillDir(options.packageRoot, NCU_SKILL);
  return {
    version: readPackageVersion(options.packageRoot),
    packageRoot: options.packageRoot,
    ncu: {
      name: NCU_SKILL,
      path: ncuPath,
      present: fs.existsSync(path.join(ncuPath, "SKILL.md")),
      revision: readVendoredRevision(ncuPath),
    },
    kernelWiki: {
      path: options.layout.kernelWikiDir,
      pin: KERNEL_WIKI_PIN,
      present: fs.existsSync(path.join(options.layout.kernelWikiDir, "SKILL.md")),
    },
    loopEngine: inspectLoopEngine(options.layout.settingsPath),
  };
}

export function formatKnowledgeReport(report: KnowledgeReport): string {
  const loopEngine =
    report.loopEngine.state === "installed"
      ? "installed"
      : report.loopEngine.state === "missing"
        ? "not installed — run: pi install npm:@ariesfish/pi-goal"
        : `unknown — no readable settings.json at ${report.loopEngine.settingsPath}`;

  const ncu = report.ncu.present
    ? `vendored @${shorten(report.ncu.revision)} at ${report.ncu.path}`
    : `missing at ${report.ncu.path}`;

  const wiki = report.kernelWiki.present
    ? `cached at ${report.kernelWiki.path}`
    : `not cached — pin ${report.kernelWiki.pin.slice(0, 12)}, run kernel_bootstrap`;

  return [
    `pi-kernel-expert ${report.version}`,
    `  loop engine   pi-goal ${loopEngine}`,
    `  ncu skill     ${ncu}`,
    `  KernelWiki    ${wiki}`,
  ].join("\n");
}

function shorten(revision: string | null): string {
  return revision ? revision.slice(0, 12) : "unknown";
}

export function knowledgeSummary(report: KnowledgeReport): string {
  const wiki = report.kernelWiki.present ? "cached" : "missing";
  return `ncu=${report.ncu.present ? "vendored" : "missing"} KernelWiki=${wiki} pi-goal=${report.loopEngine.state}`;
}

export { KERNEL_WIKI_SKILL, NCU_SKILL };
