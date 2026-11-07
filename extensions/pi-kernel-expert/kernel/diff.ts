import { createHash } from "node:crypto";
import * as fs from "node:fs";

import type { HostExec } from "../support/exec.ts";

/** Evidence paths never count as the candidate's change. */
const EVIDENCE_EXCLUDES = [
  ":(exclude)profile/**",
  ":(exclude)runs/**",
  ":(exclude).kernel/**",
  ":(exclude).goal/**",
  ":(exclude)candidates.jsonl",
  ":(exclude)goal.jsonl",
  ":(exclude)goal.ideas.md",
  ":(exclude)benchmark.csv",
];

const UNTRACKED_MAX_BYTES = 2 * 1024 * 1024;

export interface DiffFingerprint {
  hash: string;
  head: string;
  changedFiles: string[];
}

export type FingerprintOutcome =
  | { ok: true; value: DiffFingerprint }
  | { ok: false; reason: string };

export function sha256File(file: string): string {
  const hash = createHash("sha256");
  const fd = fs.openSync(file, "r");
  const buffer = Buffer.alloc(1024 * 1024);
  try {
    let bytes = 0;
    while ((bytes = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, bytes));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

/**
 * Fingerprint the candidate change: the tracked diff against HEAD plus the
 * content of untracked files, with evidence directories excluded.
 *
 * The head is part of the hash on purpose: a fingerprint only means "this code
 * on this base". Comparing a profile taken before a commit with a tree after it
 * is exactly the staleness this catches.
 */
export async function diffFingerprint(options: {
  exec: HostExec;
  root: string;
  scopeGlobs?: string[];
  signal?: AbortSignal;
}): Promise<FingerprintOutcome> {
  const exec = options.exec;
  const signal = options.signal;
  const pathspec = [
    ...(options.scopeGlobs && options.scopeGlobs.length > 0 ? options.scopeGlobs : ["."]),
    ...EVIDENCE_EXCLUDES,
  ];
  const run = (args: string[]) => exec.exec("git", args, { cwd: options.root, timeout: 120_000, signal, maxBuffer: 64 * 1024 * 1024 });

  const headResult = await run(["rev-parse", "HEAD"]);
  if (headResult.code !== 0) {
    return { ok: false, reason: `not a git repository with a commit: ${headResult.stderr.trim() || "git rev-parse failed"}` };
  }
  const head = headResult.stdout.trim();

  const diffResult = await run(["diff", "HEAD", "--", ...pathspec]);
  if (diffResult.code !== 0) {
    return { ok: false, reason: `git diff failed: ${diffResult.stderr.trim()}` };
  }

  const namesResult = await run(["diff", "--name-only", "HEAD", "--", ...pathspec]);
  if (namesResult.code !== 0) {
    return { ok: false, reason: `git diff --name-only failed: ${namesResult.stderr.trim()}` };
  }

  const untrackedResult = await run(["ls-files", "--others", "--exclude-standard", "--", ...pathspec]);
  if (untrackedResult.code !== 0) {
    return { ok: false, reason: `git ls-files failed: ${untrackedResult.stderr.trim()}` };
  }

  const untracked = untrackedResult.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .sort()
    .map((relative) => {
      const file = `${options.root}/${relative}`;
      try {
        const size = fs.statSync(file).size;
        const contentHash = size > UNTRACKED_MAX_BYTES ? null : sha256File(file);
        return { path: relative, size, sha256: contentHash };
      } catch {
        return { path: relative, size: null, sha256: null };
      }
    });

  const changedFiles = [
    ...namesResult.stdout.split("\n").map((line) => line.trim()).filter(Boolean),
    ...untracked.map((entry) => entry.path),
  ].sort();

  const hash = createHash("sha256")
    .update(
      JSON.stringify({
        head,
        patch: createHash("sha256").update(diffResult.stdout).digest("hex"),
        untracked,
        changedFiles,
      }),
    )
    .digest("hex");

  return { ok: true, value: { hash, head, changedFiles } };
}
