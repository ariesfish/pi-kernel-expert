import { createHash } from "node:crypto";

/**
 * The M0 contract is the part of a milestone a candidate cannot negotiate with:
 * tile shape, smem inventory, warp roles, register budget, issue order,
 * accumulator precision. Those choices are made once, before there is any
 * number to argue with, and a milestone that lets them drift turns every later
 * speedup into a comparison against a different baseline.
 *
 * So the block is frozen by hash. The lock file keeps the block's own text, not
 * only its hash, because a hash tells you *that* something moved and the author
 * needs to know *which item* moved before they can decide whether the change was
 * worth a diagnosis row.
 */

export const MILESTONE_LOCK_RELATIVE_PATH = ".kernel/milestone.lock.json";

export const MILESTONE_LOCK_VERSION = 1;

/** The block as the parser sees it: the heading, its `- item: value` lines, and nothing else. */
export interface M0Block {
  heading: string;
  /** Every line of the block, heading first, trailing blanks trimmed. */
  lines: string[];
  items: M0Item[];
}

export interface M0Item {
  key: string;
  value: string;
}

/** One difference between the locked block and the block on disk now. */
export interface M0Change {
  kind: "changed" | "added" | "removed" | "reordered";
  /** The item's name (`register budget`), or the raw line when it names no item. */
  key: string;
  /** The locked line; `""` for an addition. */
  before: string;
  /** The line on disk now; `""` for a removal. */
  after: string;
}

export interface MilestoneLock {
  version: number;
  /** sha256 of the whole milestone file at lock time: what a candidate's `milestoneSha` compares to. */
  milestoneSha: string;
  /** sha256 of the block text: the freeze. */
  m0ContractSha: string;
  /** ISO timestamp. */
  lockedAt: string;
  /** The block text, verbatim, so a thaw can name what moved. */
  m0Contract: string;
}

/** What this module needs from a parsed milestone: the file's lines and its `###` phases. */
interface MilestoneLike {
  lines: readonly string[];
  phases: readonly { id: string; name: string; start: number; end: number }[];
}

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** The milestone's own hash: the whole file, byte for byte. */
export function milestoneSha(text: string): string {
  return sha256(text);
}

/**
 * The `### M0 Contract` block, or null when the milestone has none. Matching is
 * on the phase id and the block's name, so `### M0 Architecture` — decisions —
 * is not mistaken for the frozen contract.
 */
export function m0ContractBlock(model: MilestoneLike): M0Block | null {
  const phase = model.phases.find((entry) => entry.id === "M0" && /^contract$/i.test(entry.name.trim()));
  if (!phase) return null;
  let end = phase.end;
  while (end > phase.start + 1 && model.lines[end - 1].trim() === "") end -= 1;
  const lines = model.lines.slice(phase.start, end);
  const items: M0Item[] = [];
  for (const line of lines.slice(1)) {
    const item = /^-\s*([^:]+):\s*(.*)$/.exec(line.trim());
    if (item) items.push({ key: item[1].trim(), value: item[2].trim() });
  }
  return { heading: lines[0], lines, items };
}

/** The item name a line belongs to, for a refusal that has to name something. */
function keyOf(line: string): string {
  const item = /^-\s*([^:]+):\s*(.*)$/.exec(line.trim());
  return item ? item[1].trim() : line.trim();
}

/**
 * Line-level diff over the block, matched by multiset so an edit pairs with the
 * item it changed instead of reporting every line after the insertion point.
 * A pure reorder reports the first position that differs: order is part of
 * "byte-identical", and M0's order is the issue order.
 */
export function diffM0Block(locked: readonly string[], current: readonly string[]): M0Change[] {
  if (locked.length === current.length && locked.every((line, index) => line === current[index])) return [];

  const unmatched = (left: readonly string[], right: readonly string[]): string[] => {
    const pool = new Map<string, number>();
    for (const line of right) pool.set(line, (pool.get(line) ?? 0) + 1);
    const rest: string[] = [];
    for (const line of left) {
      const count = pool.get(line) ?? 0;
      if (count > 0) pool.set(line, count - 1);
      else rest.push(line);
    }
    return rest;
  };

  const removed = unmatched(locked, current);
  const added = unmatched(current, locked);

  if (removed.length === 0 && added.length === 0) {
    const index = locked.findIndex((line, position) => line !== current[position]);
    return [{ kind: "reordered", key: keyOf(locked[index]), before: locked[index], after: current[index] }];
  }

  const changes: M0Change[] = [];
  const addedByKey = new Map<string, string[]>();
  for (const line of added) {
    const key = keyOf(line);
    addedByKey.set(key, [...(addedByKey.get(key) ?? []), line]);
  }
  for (const line of removed) {
    const key = keyOf(line);
    const partner = addedByKey.get(key)?.shift();
    if (partner === undefined) changes.push({ kind: "removed", key, before: line, after: "" });
    else changes.push({ kind: "changed", key, before: line, after: partner });
  }
  for (const [key, lines] of addedByKey) {
    for (const line of lines) changes.push({ kind: "added", key, before: "", after: line });
  }
  return changes;
}

/** A lock file the caller can trust, or null. A malformed lock is not a pass. */
export function parseMilestoneLock(text: string): MilestoneLock | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const value = raw as Record<string, unknown>;
  if (value.version !== MILESTONE_LOCK_VERSION) return null;
  for (const key of ["milestoneSha", "m0ContractSha", "lockedAt", "m0Contract"] as const) {
    if (typeof value[key] !== "string" || value[key] === "") return null;
  }
  if (!/^[0-9a-f]{64}$/.test(value.milestoneSha as string)) return null;
  if (!/^[0-9a-f]{64}$/.test(value.m0ContractSha as string)) return null;
  return {
    version: MILESTONE_LOCK_VERSION,
    milestoneSha: value.milestoneSha as string,
    m0ContractSha: value.m0ContractSha as string,
    lockedAt: value.lockedAt as string,
    m0Contract: value.m0Contract as string,
  };
}

export function formatMilestoneLock(lock: MilestoneLock): string {
  return `${JSON.stringify(
    {
      version: lock.version,
      milestoneSha: lock.milestoneSha,
      m0ContractSha: lock.m0ContractSha,
      lockedAt: lock.lockedAt,
      m0Contract: lock.m0Contract,
    },
    null,
    2,
  )}\n`;
}

/** The row an unlock appends to `## 4. Dead Ends`: the reason, and what was thawed. */
export function deadEndRow(reason: string, m0ContractSha: string): string {
  return `- M0 | ${reason.trim()} | m0-contract@${m0ContractSha.slice(0, 12)}`;
}
