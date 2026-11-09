import * as fs from "node:fs";
import * as path from "node:path";

import type { HostExec } from "../support/exec.ts";

export const KERNEL_WIKI_REMOTE = "https://github.com/ariesfish/kernel-wiki.git";

const FULL_SHA = /^[0-9a-f]{40}$/;
const SKILL_NAME_RULE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * kda's notice says its distributed KernelWiki omits these. The upstream commit
 * it pins still contains them, so the fetch prunes them and records what it
 * removed. The scan is limited to `artifacts/`, where every file is verbatim
 * upstream material; a wiki page that merely discusses the marker is untouched.
 */
export const RESTRICTED_MARKER = "LicenseRef-NvidiaProprietary";
const RESTRICTED_SCOPE = "artifacts";

export type FetchState = "already" | "installed" | "refused";

export interface FetchResult {
  state: FetchState;
  path: string;
  revision: string | null;
  reason?: string;
  warnings: string[];
}

export interface FetchOptions {
  pin: string;
  targetDir: string;
  exec: HostExec;
  remote?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * Fetch a corpus at an exact revision into `targetDir`.
 *
 * The fetched tree is the license boundary (KernelWiki's sanitized revision
 * omits proprietary files), so the revision is verified before the directory
 * is moved into place. A refusal never deletes or overwrites an existing tree.
 */
export async function fetchPinnedCorpus(options: FetchOptions): Promise<FetchResult> {
  const { pin, targetDir, exec } = options;
  const remote = options.remote ?? KERNEL_WIKI_REMOTE;
  const timeout = (options.timeoutMs ?? 600_000) || undefined;
  const signal = options.signal;
  const base: FetchResult = { state: "refused", path: targetDir, revision: null, warnings: [] };

  if (!FULL_SHA.test(pin)) {
    return { ...base, reason: `pin must be a full 40-character commit SHA, got "${pin}"` };
  }

  if (fs.existsSync(targetDir)) {
    if (!fs.existsSync(path.join(targetDir, "SKILL.md"))) {
      return {
        ...base,
        reason: `${targetDir} exists but holds no SKILL.md; refusing to touch it`,
      };
    }
    const revision = await readRevision(exec, targetDir, timeout, signal);
    if (revision === pin) {
      const pruned = pruneRestrictedMaterial(targetDir);
      if (pruned.length > 0) {
        const recorded = [...new Set([...readSanitizedFiles(targetDir), ...pruned])].sort();
        writeSanitizedRecord(targetDir, { revision: pin, removed: recorded });
      }
      const warnings = nameWarnings(targetDir);
      if (pruned.length > 0) {
        warnings.push(`removed ${pruned.length} restricted file(s) from the cached tree; see SANITIZED.yaml`);
      }
      return { ...base, state: "already", revision, warnings };
    }
    return {
      ...base,
      revision,
      reason: `${targetDir} is at ${revision ?? "an unreadable revision"}, expected ${pin}; refusing to overwrite`,
    };
  }

  fs.mkdirSync(path.dirname(targetDir), { recursive: true });
  const tmp = path.join(
    path.dirname(targetDir),
    `.${path.basename(targetDir)}.tmp-${process.pid}-${Date.now()}`,
  );

  const cleanup = () => {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      // best effort; a leftover temp dir is reported by the next fetch's refusal
    }
  };

  try {
    const clone = await exec.exec("git", ["clone", "--quiet", remote, tmp], { timeout, signal });
    if (clone.code !== 0) {
      cleanup();
      return { ...base, reason: `git clone failed: ${tail(clone.stderr || clone.stdout)}` };
    }

    const checkout = await exec.exec("git", ["-C", tmp, "checkout", "--quiet", "--detach", pin], {
      timeout,
      signal,
    });
    if (checkout.code !== 0) {
      cleanup();
      return {
        ...base,
        reason: `revision ${pin} is not in ${remote}: ${tail(checkout.stderr || checkout.stdout)}`,
      };
    }

    const revision = await readRevision(exec, tmp, timeout, signal);
    if (revision !== pin) {
      cleanup();
      return { ...base, revision, reason: `checkout produced ${revision ?? "no revision"}, expected ${pin}` };
    }
    if (!fs.existsSync(path.join(tmp, "SKILL.md"))) {
      cleanup();
      return { ...base, revision, reason: `${pin} holds no SKILL.md; refusing to install it as a skill` };
    }
    if (fs.existsSync(targetDir)) {
      cleanup();
      return { ...base, revision, reason: `${targetDir} appeared during the fetch; refusing to replace it` };
    }

    const pruned = pruneRestrictedMaterial(tmp);
    writeSanitizedRecord(tmp, { revision: pin, removed: pruned });

    fs.renameSync(tmp, targetDir);
    const warnings = nameWarnings(targetDir);
    if (pruned.length > 0) {
      warnings.push(`removed ${pruned.length} file(s) marked ${RESTRICTED_MARKER}; see SANITIZED.yaml`);
    }
    return { ...base, state: "installed", revision, warnings };
  } catch (error) {
    cleanup();
    return { ...base, reason: `fetch failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** Delete files whose header carries the restricted SPDX marker; return relative paths. */
export function pruneRestrictedMaterial(root: string, marker = RESTRICTED_MARKER): string[] {
  const scope = path.join(root, RESTRICTED_SCOPE);
  if (!fs.existsSync(scope)) return [];
  const removed: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      let body: string;
      try {
        body = fs.readFileSync(full, "utf8");
      } catch {
        continue;
      }
      if (!body.includes(marker)) continue;
      fs.rmSync(full, { force: true });
      removed.push(path.relative(root, full));
    }
  };
  walk(scope);
  removeEmptyDirs(root, scope, root);
  return removed.sort();
}

function removeEmptyDirs(root: string, dir: string, stop: string): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) removeEmptyDirs(root, path.join(dir, entry.name), stop);
  }
  if (dir === stop) return;
  if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
}

/** Paths already named by a previous sanitization of this cache. */
export function readSanitizedFiles(root: string): string[] {
  const file = path.join(root, "SANITIZED.yaml");
  if (!fs.existsSync(file)) return [];
  const files: string[] = [];
  let inFiles = false;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (/^files:\s*$/.test(line)) {
      inFiles = true;
      continue;
    }
    if (!inFiles) continue;
    const match = /^ {2}- (.+)$/.exec(line);
    if (match) files.push(match[1]);
    else if (line.trim() !== "") inFiles = false;
  }
  return files;
}

function writeSanitizedRecord(root: string, record: { revision: string; removed: string[] }): void {
  const lines = [
    "# Record of restricted material removed by pi-kernel-expert's fetch.",
    `upstream_revision: ${record.revision}`,
    `marker: ${RESTRICTED_MARKER}`,
    `scope: ${RESTRICTED_SCOPE}/`,
    `removed: ${record.removed.length}`,
  ];
  if (record.removed.length > 0) {
    lines.push("files:");
    for (const file of record.removed) lines.push(`  - ${file}`);
  }
  fs.writeFileSync(path.join(root, "SANITIZED.yaml"), `${lines.join("\n")}\n`);
}

async function readRevision(
  exec: HostExec,
  dir: string,
  timeout: number | undefined,
  signal: AbortSignal | undefined,
): Promise<string | null> {
  const result = await exec.exec("git", ["-C", dir, "rev-parse", "HEAD"], { timeout, signal });
  return result.code === 0 ? result.stdout.trim() : null;
}

/** The pinned corpus declares a compliant name; a non-compliant one is reported, not fixed. */
function nameWarnings(dir: string): string[] {
  try {
    const text = fs.readFileSync(path.join(dir, "SKILL.md"), "utf8");
    const name = /^name:\s*(.+?)\s*$/m.exec(/^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? "")?.[1];
    if (!name) return [`${dir}/SKILL.md declares no name; pi falls back to the directory name`];
    if (!SKILL_NAME_RULE.test(name)) {
      return [`corpus skill name "${name}" is not Agent Skills compliant; pi loads it with a warning`];
    }
  } catch {
    // unreadable SKILL.md is caught by the caller's existence check
  }
  return [];
}

function tail(text: string, maxChars = 600): string {
  const trimmed = text.trim();
  if (!trimmed) return "no output";
  return trimmed.length > maxChars ? `…${trimmed.slice(-maxChars)}` : trimmed;
}

export function formatFetchResult(result: FetchResult): string {
  const lines: string[] = [];
  if (result.state === "already") {
    lines.push(`kernel-wiki already cached at ${result.path}`);
    lines.push(`revision ${result.revision} matches the pin.`);
  } else if (result.state === "installed") {
    lines.push(`kernel-wiki fetched to ${result.path}`);
    lines.push(`revision ${result.revision} verified against the pin.`);
    lines.push("Run /reload so pi registers the fetched skill.");
  } else {
    lines.push(`KernelWiki fetch refused: ${result.reason}`);
    lines.push(`target: ${result.path}`);
    if (result.revision) lines.push(`current revision: ${result.revision}`);
    lines.push("Nothing was overwritten.");
  }
  for (const warning of result.warnings) lines.push(`warning: ${warning}`);
  return lines.join("\n");
}
