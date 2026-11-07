import type { ExecResult } from "@earendil-works/pi-coding-agent";

/** The host's process runner, narrowed to what these modules need. */
export interface HostExec {
  exec(
    command: string,
    args: string[],
    options?: { cwd?: string; timeout?: number; signal?: AbortSignal },
  ): Promise<ExecResult>;
}

/** Last lines of a failed command's output, for an actionable refusal message. */
export function errorTail(result: ExecResult, maxChars = 600): string {
  const text = [result.stderr, result.stdout].map((part) => part.trim()).filter(Boolean).join("\n");
  if (!text) return `exit code ${result.code}`;
  return text.length > maxChars ? `…${text.slice(-maxChars)}` : text;
}

/** Parse `name:` from a SKILL.md frontmatter block; null when absent. */
export function readSkillName(file: string, read: (path: string) => string): string | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(read(file));
  if (!match) return null;
  const name = /^name:\s*(.+?)\s*$/m.exec(match[1]);
  return name ? name[1].replace(/^["']|["']$/g, "") : null;
}
