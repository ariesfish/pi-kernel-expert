import * as fs from "node:fs";
import * as path from "node:path";

import { KERNEL_WIKI_SKILL, type AgentLayout } from "../support/paths.ts";
import { findSkillConflict, skillRoots, type SkillConflict } from "./conflicts.ts";

export interface RegistrationPlan {
  wikiDir: string;
  present: boolean;
  conflict: SkillConflict | null;
  /** Empty when the corpus is absent or another installation owns the name. */
  skillPaths: string[];
}

export function planKernelWikiRegistration(options: {
  cwd: string;
  layout: AgentLayout;
  home?: string;
}): RegistrationPlan {
  const wikiDir = options.layout.kernelWikiDir;
  const present = fs.existsSync(path.join(wikiDir, "SKILL.md"));
  if (!present) return { wikiDir, present, conflict: null, skillPaths: [] };

  const conflict = findSkillConflict(
    skillRoots({ cwd: options.cwd, agentDir: options.layout.agentDir, home: options.home }),
    KERNEL_WIKI_SKILL,
  );
  return {
    wikiDir,
    present,
    conflict,
    skillPaths: conflict ? [] : [wikiDir],
  };
}
