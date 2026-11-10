// replay-refusal.mts — replays an archived reading block through the parser and
// the refusal set, exactly as kernel_candidate would after a keep.
//
//   node replay-refusal.mts <reading.txt> <kernel.contract.json>
//
// Read-only: it prints what the rules say about evidence that was already taken.
// T-005 uses it to show that the 2 ms-sleep reading is refused by name, and that
// the honest reading is not (nothing else in the context is a candidate defect:
// no diff, no profile, no precision row).
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import type { KernelContract } from "../../../../extensions/pi-kernel-expert/kernel/contract.ts";
import { parseReadingBlock } from "../../../../extensions/pi-kernel-expert/kernel/reading.ts";
import { collectRefusals, formatRefusal } from "../../../../extensions/pi-kernel-expert/kernel/refusals.ts";

const [readingPath, contractPath] = process.argv.slice(2);
if (!readingPath || !contractPath) {
  console.error("usage: replay-refusal.mts <reading.txt> <kernel.contract.json>");
  process.exit(2);
}

const text = readFileSync(readingPath, "utf8");
const parsed = parseReadingBlock(text);
if (!parsed.ok) {
  console.log(`parser: REFUSED — ${parsed.reason}`);
  process.exit(1);
}
const contractText = readFileSync(contractPath, "utf8");
const contract = JSON.parse(contractText) as KernelContract;
const contractSha = createHash("sha256").update(contractText).digest("hex");
const reading = parsed.reading;

const metrics: Record<string, number> = {};
for (const match of text.matchAll(/METRIC\s+([A-Za-z0-9_.]+)=([0-9.eE+-]+)/g)) {
  metrics[match[1]] = Number(match[2]);
}

const refusals = collectRefusals({
  contract,
  contractSha,
  reading,
  readingReason: null,
  changedFiles: [],
  metrics,
  precision: null,
  profile: null,
});

console.log(`parser: ok — basis=${reading.basis} ratio=${reading.hostBoundRatio} verdict=${reading.hostBoundVerdict}`);
console.log(
  `contract: reading ${reading.contractSha.slice(0, 12)} / file ${contractSha.slice(0, 12)} — ${reading.contractSha === contractSha ? "same contract" : "MISMATCH"}`,
);
console.log(`refusals: ${refusals.length}`);
for (const entry of refusals) console.log(formatRefusal(entry));
