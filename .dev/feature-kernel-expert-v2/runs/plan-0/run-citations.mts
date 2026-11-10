/**
 * T-012 evidence: both citation namespaces against the *fetched* corpus.
 * Run from this directory: node --experimental-strip-types run-citations.mts
 */
import { readCorpusIndex } from "../../../../extensions/pi-kernel-expert/kernel/corpus-index.ts";
import { parseMilestone, validateMilestone } from "../../../../extensions/pi-kernel-expert/kernel/milestone.ts";
import { agentLayout } from "../../../../extensions/pi-kernel-expert/support/paths.ts";

const dir = agentLayout().kernelWikiDir;
const corpus = readCorpusIndex(dir, "3c41f99bde5d029690c15cc68cb47e56841b36ee");
if (corpus === null) throw new Error(`no corpus cached at ${dir}`);
console.log(`corpus: ${corpus.dir}\n        ${corpus.pages.length} pages, ${corpus.pages.filter((page) => page.confidence !== null).length} labelled, ${corpus.pages.filter((page) => page.confidence === null).length} unlabelled\n`);

const BASE = `# Milestone: probe

## 1. Problem and Target
A probe.

## 2. Contract
- basis: device

## 3. DAG and Phase Order
M0.

### M0 Contract
- tile: 1
- smem: none
- warp roles: none
- register budget: 32
- issue order: load, store
- accumulator precision: fp32

### M0 Architecture
#### D0.1 Probe
- Action: probe
- Purpose: CITE
- Trigger: CITE
- Cost: one hour
- Depends on: none

### M0 Gate
- the probe lands [VERIFY: mechanism]

## 4. Dead Ends

## 5. Global Gate
The probe holds.

## 6. Rules
One rule.

### Appendix
`;

const tool = (purpose: string, trigger = "ncu reports it", gate = "the probe lands [VERIFY: mechanism]") =>
  BASE.replace("- Purpose: CITE", `- Purpose: ${purpose}`)
    .replace("- Trigger: CITE", `- Trigger: ${trigger}`)
    .replace("- the probe lands [VERIFY: mechanism]", `- ${gate}`);

const contract = {
  schemaVersion: 2,
  cells: [{ id: "m1024", dtype: "fp16", vars: {}, boundary: false, groups: [{ name: "typical", intent: "the shape" }] }],
} as never;
const ctx = { corpus, contract, profileRunIds: ["run1"] };

const show = (label: string, text: string, context = ctx): void => {
  const problems = validateMilestone(parseMilestone(text).model, context);
  console.log(`\n${label}`);
  if (problems.length === 0) {
    console.log("  clean");
    return;
  }
  for (const problem of problems) console.log(`  [${problem.severity}] ${problem.rule} ${problem.row}\n      ${problem.what}`);
};

show("1. a real page id from the fetched corpus, labelled source-reported", tool("the mapping, see wiki:migration-wgmma-to-tcgen05#source-reported"));
show("2. a real page the corpus never labelled, cited without a label", tool("the mapping, see wiki:pattern-memory-bound"));
show("3. the same unlabelled page with a label the citer supplies", tool("the mapping, see wiki:pattern-memory-bound#inferred"));
show("4. an id no page has", tool("the mapping, see wiki:no-such-page#verified"));
show("5. a fifth confidence word", tool("the mapping, see wiki:pattern-memory-bound#probably"));
show("6. an id that is not kebab-case", tool("the mapping, see wiki:Pattern_Memory_Bound#verified"));
show("7. knowledge on a gate line", tool("the mapping", "ncu reports it", "the mapping is the pattern [VERIFY: mechanism wiki:pattern-memory-bound#verified]"));
show("8. a citation on Cost instead of Action/Purpose/Trigger", tool("the mapping, see wiki:pattern-memory-bound#verified").replace("- Cost: one hour", "- Cost: one hour, see wiki:pattern-memory-bound#verified"));
show("9. the corpus was never fetched", tool("the mapping, see wiki:pattern-memory-bound#verified"), { ...ctx, corpus: null });
show("10. measurement: a profile run that exists", tool("the reference mapping").replace("[VERIFY: mechanism]", "[VERIFY: ncu-direct profile:run1]"));
show("11. measurement: a profile run that does not", tool("the reference mapping").replace("[VERIFY: mechanism]", "[VERIFY: ncu-direct profile:run2]"));
show("12. measurement: a cell-group the contract does not have", tool("the reference mapping").replace("[VERIFY: mechanism]", "[VERIFY: correctness cell-group: m1024/nope]"));
show("13. measurement: a PRICED source that names no run", tool("the reference mapping").replace("[VERIFY: mechanism]", "[VERIFY: sass-derived][PRICED: -8% issue slots, profile:run7]"));
show("14. measurement: a pointer in no namespace", tool("the reference mapping").replace("[VERIFY: mechanism]", "[VERIFY: ncu-direct run1]"));
console.log("");
