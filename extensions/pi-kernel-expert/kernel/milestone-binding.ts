import * as fs from "node:fs";
import * as path from "node:path";

import { MILESTONE_RELATIVE_PATH, parseMilestone } from "./milestone.ts";
import { bindingRefusal, type Refusal } from "./refusals.ts";
import { milestoneSha } from "./milestone-lock.ts";

/**
 * A candidate is a claim that this change implements a decision the plan already
 * made. The binding is what turns that claim into a record: the decision id has
 * to exist in `docs/milestone.md`, the sha has to be the file that was read, and
 * a combination the plan already killed has to say what is different this time.
 *
 * Three facts and one absence:
 *
 * - **A decision that is not in the milestone is a name for nothing.** A bundle
 *   is checked one id at a time, because a bundle with one phantom member is a
 *   bundle nobody can attribute.
 * - **A sha that moved means the file may have changed under the id.** The
 *   caller passes the sha it read; the record keeps the sha it checked.
 * - **A dead end bans a combination, not its members.** `D0.1` alone is fine;
 *   `D0.1+D0.2` was killed for a reason, and re-proposing the pair needs a
 *   `precondition` saying what is different — retrying alone is not one.
 * - **No milestone is a declared degradation.** A workspace that never wrote a
 *   plan can still record a candidate; the record says `null` and the note says
 *   why. Refusing there would make the milestone mandatory for every workspace,
 *   which is T-015's warning to give, not this rule's refusal.
 */

export interface DeadEnd {
  /** The decision ids the dead end bans, in the order the row lists them. */
  ids: string[];
  reason: string;
  raw: string;
}

export interface MilestoneSnapshot {
  /** sha256 of the file as read. */
  sha: string;
  decisions: string[];
  deadEnds: DeadEnd[];
}

export interface MilestoneBindingRecord {
  milestoneDecision: string | null;
  milestoneSha: string | null;
  precondition: string | null;
}

export interface MilestoneBindingResult {
  record: MilestoneBindingRecord;
  refusals: Refusal[];
  /** What to tell the caller when the binding could not be checked at all. */
  note: string | null;
}

/** `null` when the workspace has no milestone: a fact, not a failure. */
export function readMilestoneSnapshot(workspace: string): MilestoneSnapshot | null {
  const file = path.join(workspace, MILESTONE_RELATIVE_PATH);
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  const { model } = parseMilestone(text);
  return {
    sha: milestoneSha(text),
    decisions: model.decisions.map((decision) => decision.id),
    deadEnds: model.deadEnds.map((row) => ({
      raw: row,
      ids: idsOf(row),
      reason: row.split("|")[1]?.trim() ?? row,
    })),
  };
}

function idsOf(row: string): string[] {
  const head = row.split("|")[0] ?? "";
  return (head.match(/D\d+\.\d+/g) ?? []).map((id) => id.toUpperCase());
}

/** `D0.1+D1.2` or `D0.1, D1.2`; one id is a bundle of one. */
export function parseBundle(requested: string): string[] {
  return requested
    .split(/[+,]/)
    .map((token) => token.trim().toUpperCase())
    .filter((token) => token !== "");
}

export function checkMilestoneBinding(options: {
  snapshot: MilestoneSnapshot | null;
  /** What the caller said this candidate implements; `null` when it said nothing. */
  requested: string | null;
  /** The sha the caller read, when it wants the read itself checked. */
  declaredSha: string | null;
  precondition: string | null;
}): MilestoneBindingResult {
  const requested = options.requested?.trim() ?? "";
  const declared = options.declaredSha?.trim() ?? "";
  const precondition = options.precondition?.trim() ?? "";
  const snapshot = options.snapshot;

  if (snapshot === null) {
    return {
      record: { milestoneDecision: requested === "" ? null : requested, milestoneSha: null, precondition: precondition || null },
      refusals: [],
      note: `no ${MILESTONE_RELATIVE_PATH} in this workspace, so this candidate names no decision: the plan is the attribution, and a workspace without one records lineage only.`,
    };
  }

  const refusals: Refusal[] = [];
  const listed = snapshot.decisions.length === 0 ? "it has no decisions" : `it has ${snapshot.decisions.join(", ")}`;

  if (declared !== "" && declared !== snapshot.sha) {
    refusals.push(
      bindingRefusal(
        "milestone-stale",
        `the milestone you read is ${declared.slice(0, 12)} and ${MILESTONE_RELATIVE_PATH} is now ${snapshot.sha.slice(0, 12)}: the decision you are attributing may have changed under it.`,
        `read ${MILESTONE_RELATIVE_PATH} again and pass the current sha, or record the candidate against the decision as it now stands.`,
      ),
    );
  }

  if (requested === "") {
    refusals.push(
      bindingRefusal(
        "decision-missing",
        `this keep names no decision, and ${MILESTONE_RELATIVE_PATH} is here: ${listed}. A keep nothing points at cannot be reviewed against the plan, and the plan cannot learn that the decision paid off.`,
        `pass milestone_decision with the id this change implements (one id, or a + joined bundle the plan also records).`,
      ),
    );
    return { record: { milestoneDecision: null, milestoneSha: snapshot.sha, precondition: precondition || null }, refusals, note: null };
  }

  const bundle = parseBundle(requested);
  const present = bundle.filter((id) => snapshot.decisions.includes(id));
  const absent = bundle.filter((id) => !snapshot.decisions.includes(id));
  if (absent.length > 0) {
    const context =
      present.length > 0 ? `${present.join(", ")} ${present.length === 1 ? "is" : "are"} in the milestone` : `nothing in ${requested} is in the milestone`;
    refusals.push(
      bindingRefusal(
        "decision-unknown",
        `${absent.join(", ")} ${absent.length === 1 ? "is" : "are"} not in ${MILESTONE_RELATIVE_PATH} (${listed}); ${context}. A decision id the plan does not have is a name for nothing.`,
        `add the decision to the milestone first (kernel_milestone to validate it), or name the decision this change actually implements.`,
      ),
    );
  } else if (bundle.length > 1) {
    // Only a bundle can collide with a banned combination, and only a bundle of
    // ids the plan has: matching an unknown id's row would be guessing.
    const target = [...new Set(bundle)].sort().join("+");
    const deadEnd = snapshot.deadEnds.find((entry) => [...new Set(entry.ids)].sort().join("+") === target);
    if (deadEnd && precondition === "") {
      refusals.push(
        bindingRefusal(
          "dead-end-bundle",
          `${target} is recorded as a dead end — ${deadEnd.reason} — and this candidate retries the combination with no precondition. A dead end bans the pair, not its members: one of them alone is a different candidate.`,
          `pass precondition naming what is different this time (a new precondition, not a smaller bundle), or implement one decision instead of the pair.`,
        ),
      );
    }
  }

  return {
    record: {
      // One spelling per bundle: sorted and deduped, so a later query for the
      // pair finds every record of it however the caller wrote it.
      milestoneDecision: refusals.length === 0 ? [...new Set(bundle)].sort().join("+") : requested,
      milestoneSha: snapshot.sha,
      precondition: precondition || null,
    },
    refusals,
    note: null,
  };
}
