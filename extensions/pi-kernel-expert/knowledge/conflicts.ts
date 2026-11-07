import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { readSkillName } from "../support/exec.ts";

export interface SkillRoot {
  path: string;
  label: string;
}

export interface SkillConflict {
  path: string;
  root: string;
  label: string;
}

/**
 * Best-effort scan of the locations where a user might already have KernelWiki
 * installed. Package-provided skills are not visible here; Pi's own
 * first-discovered-wins rule is the backstop for those.
 */
export function skillRoots(options: { cwd: string; agentDir: string; home?: string }): SkillRoot[] {
  const home = options.home ?? os.homedir();
  const roots: SkillRoot[] = [
    { path: path.join(options.agentDir, "skills"), label: "user pi skills" },
    { path: path.join(options.cwd, ".pi", "skills"), label: "project pi skills" },
    { path: path.join(home, ".agents", "skills"), label: "user agents skills" },
  ];
  for (const dir of projectAgentSkillDirs(options.cwd)) {
    roots.push({ path: dir, label: "project agents skills" });
  }
  return roots;
}

/** `.agents/skills` from cwd upward, stopping at the repository root. */
function projectAgentSkillDirs(cwd: string): string[] {
  const dirs: string[] = [];
  let current = path.resolve(cwd);
  for (let depth = 0; depth < 12; depth += 1) {
    dirs.push(path.join(current, ".agents", "skills"));
    if (fs.existsSync(path.join(current, ".git"))) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return [...new Set(dirs)];
}

export function findSkillConflict(roots: SkillRoot[], name: string): SkillConflict | null {
  const wanted = name.toLowerCase();
  for (const root of roots) {
    if (!fs.existsSync(root.path)) continue;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(root.path, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillDir = path.join(root.path, entry.name);
      const file = path.join(skillDir, "SKILL.md");
      if (!fs.existsSync(file)) continue;
      const declared = readSkillName(file, (p) => fs.readFileSync(p, "utf8")) ?? entry.name;
      if (declared.toLowerCase() === wanted) {
        return { path: skillDir, root: root.path, label: root.label };
      }
    }
  }
  return null;
}
