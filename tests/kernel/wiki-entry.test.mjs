import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import kernelExpertExtension from "../../extensions/pi-kernel-expert/index.ts";
import { TRIGGER_CATEGORIES } from "../../extensions/pi-kernel-expert/kernel/milestone.ts";
import {
  ENTRY_SECTIONS,
  architectureForGpu,
  formatEntryProblems,
  parseEntry,
  prefillFromWorkspace,
  renderEntry,
  validateEntry,
  wikiCandidatesDir,
} from "../../extensions/pi-kernel-expert/kernel/wiki-entry.ts";
import {
  formatWikiCandidateOutcome,
  writeWikiCandidate,
} from "../../extensions/pi-kernel-expert/tools/wiki-candidate.ts";
import { fakePi } from "../helpers/fake-host.mjs";

/** A v2 contract, minimal but readable by `readContract`. */
const CONTRACT = {
  schemaVersion: 2,
  objective: "cut the epilogue cost of the fused attention kernel",
  checkCommand: "bash goal.checks.sh",
  benchmarkCommand: "bash goal.sh --repeats 3",
  cells: [
    {
      id: "m1024",
      dtype: "bf16",
      vars: { M: "1024" },
      boundary: false,
      groups: [{ name: "typical", intent: "the ordinary case" }],
    },
  ],
  tolerance: { rtol: 1e-2, atol: 1e-3 },
  metricName: "latency_us",
  direction: "lower",
  repeats: 3,
  warmup: 1,
  guardPct: 5,
  noiseFloorPct: 2,
  checksTimeoutSeconds: 900,
  scopeGlobs: ["src/**"],
  testGlobs: ["tests/**"],
  basis: "device",
  harnessGlobs: ["goal.sh", "goal.checks.sh"],
  referenceCommand: null,
  calibrateCommand: null,
  burnInMs: 0,
  clockLock: null,
  generator: "pi-kernel-expert",
};

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pi-kernel-expert-wiki-"));
}

/**
 * A task workspace: root-level files and a `src/` file exist because the
 * reference-leak rule refuses a body that names them.
 */
function workspace({ profile = null, contract = true, candidate = null, entry = null } = {}) {
  const root = tempDir();
  fs.writeFileSync(path.join(root, "goal.sh"), "#!/usr/bin/env bash\n");
  fs.writeFileSync(path.join(root, "goal.checks.sh"), "#!/usr/bin/env bash\n");
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "epilogue.cu"), "// the kernel\n");
  if (contract) fs.writeFileSync(path.join(root, "kernel.contract.json"), JSON.stringify(CONTRACT, null, 2));
  if (candidate !== null) {
    fs.writeFileSync(path.join(root, "candidates.jsonl"), `${JSON.stringify({ id: candidate, decision: "keep" })}\n`);
  }
  if (profile !== null) {
    const dir = path.join(root, "profile", profile.runId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "summary.json"),
      JSON.stringify({
        version: 1,
        runId: profile.runId,
        createdAt: profile.createdAt ?? "2026-01-01T00:00:00.000Z",
        gpu: { name: profile.gpuName, clockSm: null, clockMem: null },
      }),
    );
  }
  if (entry !== null) {
    fs.mkdirSync(wikiCandidatesDir(root), { recursive: true });
    fs.writeFileSync(path.join(wikiCandidatesDir(root), `${entry}.md`), "---\nid: other\n---\n");
  }
  return root;
}

/** A corpus that already carries the page id `id`. */
function corpus(id) {
  const root = tempDir();
  const dir = path.join(root, "wiki", "techniques");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "existing.md"), `---\nid: ${id}\ntitle: "already here"\n---\n\n# already here\n`);
  return root;
}

function model(overrides = {}) {
  return {
    id: "double-buffer-smem-tile",
    title: "Prefetching the next smem tile hides the load behind the mma issue",
    type: "technique",
    architectures: ["sm90"],
    tags: ["smem", "pipelining"],
    confidence: "source-reported",
    sources: ["c1", "run1"],
    mechanism:
      "The inner loop loads tile k+1 into the second smem buffer while the mma consumes tile k, so the smem latency is covered by arithmetic instead of stalling the warp.",
    trigger: "waves/SM < 1 on the reference with the smem load already vectorised",
    cost: "one extra 32 KiB tile of smem per block, which caps occupancy at three blocks per SM",
    conditions: "holds while the tile fits the smem budget and the reduction stays in registers",
    gotchas: "double buffering without a second barrier raced, and only the tail group caught it",
    negative: "a 256-row tile spilled 190 registers and lost 8% instead",
    ...overrides,
  };
}

const CONTEXT = { candidateIds: ["c1"], profileRunIds: ["run1"], contract: CONTRACT };

function problems(overrides = {}, ctx = CONTEXT) {
  return validateEntry(model(overrides), ctx);
}

/** Exactly one refusal — of `rule` when given, of the whole entry otherwise — so a test asserts on its section and message. */
function only(overrides, rule = null, ctx = CONTEXT) {
  const all = problems(overrides, ctx);
  const hits = rule === null ? all : all.filter((problem) => problem.rule === rule);
  assert.equal(
    hits.length,
    1,
    `expected exactly one ${rule ?? "refusal"}, got ${hits.length}: ${JSON.stringify(all.map((hit) => hit.message))}`,
  );
  return hits[0];
}

function request(overrides = {}) {
  return {
    id: "double-buffer-smem-tile",
    title: "Prefetching the next smem tile hides the load behind the mma issue",
    type: "technique",
    mechanism:
      "The inner loop loads tile k+1 into the second smem buffer while the mma consumes tile k, so the smem latency is covered by arithmetic.",
    trigger: "waves/SM < 1 on the reference with the smem load already vectorised",
    cost: "one extra 32 KiB tile of smem per block",
    conditions: "holds while the tile fits the smem budget and the reduction stays in registers",
    gotchas: "double buffering without a second barrier raced on the tail group",
    negative: "a 256-row tile spilled registers and lost 8%",
    tags: ["smem"],
    ...overrides,
  };
}

// ---- a valid entry -------------------------------------------------------

test("a valid entry round-trips through render and parse", () => {
  const entry = model();
  const text = renderEntry(entry);
  assert.deepEqual(parseEntry(text), entry);
  assert.equal(renderEntry(parseEntry(text)), text);

  assert.match(text, /^---\nid: double-buffer-smem-tile\n/);
  assert.match(text, /^title: "Prefetching the next smem tile hides the load behind the mma issue"$/m);
  assert.match(text, /^type: technique$/m);
  assert.match(text, /^architectures: \[sm90\]$/m);
  assert.match(text, /^confidence: source-reported$/m);
  assert.match(text, /^sources: \[c1, run1\]$/m);
  assert.deepEqual(
    [...text.matchAll(/^## (.+)$/gm)].map((match) => match[1]),
    ENTRY_SECTIONS.map((section) => section.heading),
  );
  assert.match(text, /## Measured footprint and cost/);
  assert.match(text, /## Load-bearing conditions/);
  assert.match(text, /## Negative readings/);
});

test("an empty optional section renders as a heading and parses back as empty", () => {
  const entry = model({ cost: "", negative: "" });
  assert.deepEqual(parseEntry(renderEntry(entry)), entry);
  assert.deepEqual(validateEntry(entry, CONTEXT), []);
});

test("a valid entry validates clean", () => {
  assert.deepEqual(problems(), []);
  assert.equal(formatEntryProblems([]), "");
});

// ---- pre-fill ------------------------------------------------------------

test("prefill reads the newest profile's GPU into architectures and cites its run", () => {
  const root = workspace({ profile: { runId: "run1", gpuName: "NVIDIA H200" }, candidate: "c1" });
  const prefill = prefillFromWorkspace({ workspace: root, sources: ["c1"] });
  assert.deepEqual(prefill.architectures, ["sm90"]);
  assert.deepEqual(prefill.sources, ["c1", "run1"]);
  assert.equal(prefill.confidence, "source-reported");
  assert.equal(prefill.profileRunId, "run1");
  assert.equal(prefill.gpuName, "NVIDIA H200");
  assert.equal(prefill.newestCandidateId, "c1");
  assert.deepEqual(prefill.unresolvedSources, []);
  assert.equal(prefill.profileCited, true);
});

test("prefill maps a Blackwell reading to sm100 and a bare run id to itself", () => {
  const root = workspace({ profile: { runId: "run7", gpuName: "NVIDIA GB200" } });
  const prefill = prefillFromWorkspace({ workspace: root, sources: ["profile/run7"] });
  assert.deepEqual(prefill.architectures, ["sm100"]);
  assert.deepEqual(prefill.sources, ["run7"]);
  assert.equal(architectureForGpu("NVIDIA B200"), "sm100");
  assert.equal(architectureForGpu("NVIDIA H100 PCIe"), "sm90");
  assert.equal(architectureForGpu("NVIDIA A100"), null);
});

test("the newest profile wins, and with no profile confidence falls back to inferred", () => {
  const root = workspace({ profile: { runId: "run1", gpuName: "NVIDIA H100" } });
  const newer = path.join(root, "profile", "run2");
  fs.mkdirSync(newer, { recursive: true });
  fs.writeFileSync(
    path.join(newer, "summary.json"),
    JSON.stringify({ version: 1, runId: "run2", createdAt: "2026-02-01T00:00:00.000Z", gpu: { name: "NVIDIA B200" } }),
  );
  const prefill = prefillFromWorkspace({ workspace: root });
  assert.deepEqual(prefill.architectures, ["sm100"]);
  assert.deepEqual(prefill.sources, ["run2"]);

  const empty = prefillFromWorkspace({ workspace: workspace({ candidate: "c1" }) });
  assert.deepEqual(empty.architectures, []);
  assert.match(empty.architectureReason, /no profile\/<run>\/summary\.json/);
  assert.equal(empty.confidence, "inferred");
  assert.deepEqual(empty.sources, ["c1"]);

  const unresolved = prefillFromWorkspace({ workspace: root, sources: ["c9"] });
  assert.deepEqual(unresolved.unresolvedSources, ["c9"]);
});

// ---- one test per refusal ------------------------------------------------

test("entry-missing-section names the empty required section", () => {
  const refusal = only({ mechanism: "   " });
  assert.equal(refusal.rule, "entry-missing-section");
  assert.equal(refusal.section, "Mechanism");
  assert.match(refusal.message, /^entry-missing-section Mechanism: /);
  assert.match(refusal.message, /Fix: /);

  const trigger = only({ trigger: "" });
  assert.equal(trigger.section, "Trigger");
  const conditions = only({ conditions: "" });
  assert.equal(conditions.section, "Load-bearing conditions");
  const gotchas = only({ gotchas: "" });
  assert.equal(gotchas.section, "Gotchas");
});

test("entry-missing-section owns a required section that is only a placeholder", () => {
  const refusal = only({ mechanism: "<the mechanism>" });
  assert.equal(refusal.rule, "entry-missing-section");
  assert.equal(refusal.section, "Mechanism");
  assert.deepEqual(problems({ mechanism: "<the mechanism>" }).map((problem) => problem.rule), ["entry-missing-section"]);
});

test("entry-trigger-category refuses every phrase of the milestone's own list", () => {
  for (const phrase of TRIGGER_CATEGORIES) {
    const refusal = only({ trigger: `apply it ${phrase}` });
    assert.equal(refusal.rule, "entry-trigger-category");
    assert.equal(refusal.section, "Trigger");
    assert.match(refusal.message, /^entry-trigger-category Trigger: /);
    assert.match(refusal.message, new RegExp(phrase));
  }
  // An observable passes.
  assert.deepEqual(problems({ trigger: "ncu reports DRAM throughput above 80% on the reference" }), []);
});

test("entry-unverified-source refuses verified with nothing that resolves", () => {
  const refusal = only({ confidence: "verified", sources: ["c9", "profile/run9"] });
  assert.equal(refusal.rule, "entry-unverified-source");
  assert.equal(refusal.section, "sources");
  assert.match(refusal.message, /^entry-unverified-source sources: /);
  assert.match(refusal.message, /"verified"/);
  assert.match(refusal.message, /c9/);

  const noSources = only({ confidence: "verified", sources: [] });
  assert.match(noSources.message, /no sources at all/);

  // Raised to verified with a citation that resolves: accepted.
  assert.deepEqual(problems({ confidence: "verified", sources: ["run1"] }), []);
  assert.deepEqual(problems({ confidence: "verified", sources: ["c1"] }), []);
});

test("entry-placeholder names the section and the leftover placeholder or template sentence", () => {
  const refusal = only({ mechanism: "The tile is <which tile> kept in registers." });
  assert.equal(refusal.rule, "entry-placeholder");
  assert.equal(refusal.section, "Mechanism");
  assert.match(refusal.message, /^entry-placeholder Mechanism: /);
  assert.match(refusal.message, /<which tile>/);

  const template = only({ gotchas: "What bites the next operator who applies it." });
  assert.equal(template.rule, "entry-placeholder");
  assert.equal(template.section, "Gotchas");
  assert.match(template.message, /template sentence/);

  // An optional section that is only a placeholder is this rule's, not rule 1's.
  const optional = only({ negative: "<what was rejected>" });
  assert.equal(optional.section, "Negative readings");
});

test("entry-id-taken refuses an id the cached corpus already uses", () => {
  const refusal = only({ id: "double-buffer-smem-tile" }, "entry-id-taken", {
    ...CONTEXT,
    corpusPageIds: ["double-buffer-smem-tile", "tma"],
  });
  assert.equal(refusal.rule, "entry-id-taken");
  assert.equal(refusal.section, "double-buffer-smem-tile");
  assert.match(refusal.message, /^entry-id-taken double-buffer-smem-tile: /);
  assert.match(refusal.message, /cached corpus/);

  // An absent corpus is a declared degradation: shape only, no refusal.
  assert.deepEqual(problems({}, { ...CONTEXT, corpusPageIds: null }), []);
});

test("entry-reference-leak names the token, but allows it inside a fenced block", () => {
  const cell = only({ mechanism: "the m1024 tile is the one that stalls on the smem load" });
  assert.equal(cell.rule, "entry-reference-leak");
  assert.equal(cell.section, "Mechanism");
  assert.match(cell.message, /^entry-reference-leak Mechanism: /);
  assert.match(cell.message, /"m1024"/);
  assert.match(cell.message, /a cell of this task's contract/);

  const command = only({ cost: "measured by running goal.sh three times" });
  assert.match(command.message, /goal\.sh/);
  assert.match(command.message, /benchmarkCommand/);

  const file = only({ gotchas: "the epilogue in src/epilogue.cu needed a second barrier" }, "entry-reference-leak", {
    ...CONTEXT,
    workspaceFiles: ["goal.sh", "src/epilogue.cu"],
  });
  assert.match(file.message, /src\/epilogue\.cu/);
  assert.match(file.message, /a path in this task's workspace/);

  // The allow-list: the same tokens inside a fenced code block.
  const fenced = problems({
    mechanism: [
      "Run the same shape through the harness:",
      "",
      "```bash",
      "bash goal.sh --repeats 3  # the m1024 cell",
      "nvcc -o epilogue src/epilogue.cu",
      "```",
      "",
      "The second smem buffer covers the load latency.",
    ].join("\n"),
  });
  assert.deepEqual(fenced, []);
});

test("entry-id-shape refuses a malformed id and an id already used in this workspace", () => {
  const malformed = only({ id: "Double_Buffer" });
  assert.equal(malformed.rule, "entry-id-shape");
  assert.equal(malformed.section, "Double_Buffer");
  assert.match(malformed.message, /^entry-id-shape Double_Buffer: /);
  assert.match(malformed.message, /kebab-case/);

  const empty = only({ id: "" });
  assert.match(empty.message, /^entry-id-shape \(empty\): /);

  const taken = only({ id: "double-buffer-smem-tile" }, "entry-id-shape", {
    ...CONTEXT,
    wikiCandidateIds: ["double-buffer-smem-tile"],
  });
  assert.equal(taken.section, "double-buffer-smem-tile");
  assert.match(taken.message, /already used by \.kernel\/wiki-candidates\/double-buffer-smem-tile\.md/);
});

test("entry-architectures-missing refuses an entry no reader could find by hardware", () => {
  const refusal = only({ architectures: [] });
  assert.equal(refusal.rule, "entry-architectures-missing");
  assert.equal(refusal.section, "architectures");
  assert.match(refusal.message, /^entry-architectures-missing architectures: /);
});

test("every refusal is collected in one pass", () => {
  const all = problems({ mechanism: "", trigger: "when needed", confidence: "verified", sources: [], architectures: [] });
  assert.deepEqual(
    all.map((problem) => problem.rule),
    [
      "entry-missing-section",
      "entry-trigger-category",
      "entry-architectures-missing",
      "entry-unverified-source",
    ],
  );
});

// ---- the tool ------------------------------------------------------------

test("the tool writes a validated candidate and pre-fills from the workspace", () => {
  const root = workspace({ profile: { runId: "run1", gpuName: "NVIDIA H200" }, candidate: "c1" });
  const outcome = writeWikiCandidate({
    workspace: root,
    ...request({ sources: ["c1"] }),
    corpusDir: path.join(root, "no-corpus-here"),
  });
  assert.equal(outcome.ok, true, JSON.stringify(outcome.ok ? [] : outcome.errors));
  const file = path.join(wikiCandidatesDir(root), "double-buffer-smem-tile.md");
  assert.equal(outcome.path, file);
  assert.ok(fs.existsSync(file));

  const parsed = parseEntry(fs.readFileSync(file, "utf8"));
  assert.deepEqual(parsed.architectures, ["sm90"]);
  assert.deepEqual(parsed.sources, ["c1", "run1"]);
  assert.equal(parsed.confidence, "source-reported");

  const text = formatWikiCandidateOutcome(outcome);
  assert.match(text, /^wrote .*\.kernel\/wiki-candidates\/double-buffer-smem-tile\.md$/m);
  assert.match(text, /pre-filled:/);
  assert.match(text, /architectures sm90 from profile\/run1 \(gpu "NVIDIA H200"\)/);
  assert.match(text, /confidence source-reported/);
  assert.match(text, /corpus-absent/);
});

test("a corpus that already has the id is refused and nothing is written", () => {
  const root = workspace({ profile: { runId: "run1", gpuName: "NVIDIA H200" } });
  const outcome = writeWikiCandidate({
    workspace: root,
    ...request(),
    corpusDir: corpus("double-buffer-smem-tile"),
  });
  assert.equal(outcome.ok, false);
  assert.match(outcome.errors.join("\n"), /entry-id-taken double-buffer-smem-tile/);
  assert.equal(fs.existsSync(path.join(wikiCandidatesDir(root), "double-buffer-smem-tile.md")), false);
  assert.doesNotMatch(formatWikiCandidateOutcome(outcome), /^wrote /m);
});

test("no profile: the tool refuses for architectures until the caller supplies one", () => {
  const root = workspace({ candidate: "c1" });
  const refused = writeWikiCandidate({ workspace: root, ...request(), corpusDir: path.join(root, "nope") });
  assert.equal(refused.ok, false);
  const text = formatWikiCandidateOutcome(refused);
  assert.match(text, /entry-architectures-missing architectures/);
  assert.match(text, /pass architectures/);
  assert.equal(fs.existsSync(path.join(wikiCandidatesDir(root), "double-buffer-smem-tile.md")), false);

  const supplied = writeWikiCandidate({
    workspace: root,
    ...request({ architectures: ["sm90"], sources: ["c1"], confidence: "inferred" }),
    corpusDir: path.join(root, "nope"),
  });
  assert.equal(supplied.ok, true, JSON.stringify(supplied.ok ? [] : supplied.errors));
  const report = formatWikiCandidateOutcome(supplied);
  assert.match(report, /architectures came from the caller, not from a reading/);
  assert.match(report, /confidence inferred: no profile cited/);
});

test("a second candidate with the same id is refused by shape", () => {
  const root = workspace({ profile: { runId: "run1", gpuName: "NVIDIA H200" }, entry: "double-buffer-smem-tile" });
  const outcome = writeWikiCandidate({ workspace: root, ...request(), corpusDir: path.join(root, "nope") });
  assert.equal(outcome.ok, false);
  assert.match(outcome.errors.join("\n"), /entry-id-shape double-buffer-smem-tile/);
});

test("the extension registers kernel_wiki_candidate, and it writes under ctx.cwd", async () => {
  const pi = fakePi();
  kernelExpertExtension(pi);
  const tool = pi.tools.get("kernel_wiki_candidate");
  assert.ok(tool, "kernel_wiki_candidate must be registered");

  const root = workspace({ profile: { runId: "run1", gpuName: "NVIDIA GB200" }, candidate: "c2" });
  const ctx = { cwd: root, ui: { notify() {} }, hasUI: false };
  const result = await tool.execute("call", request({ sources: ["c2"] }), undefined, undefined, ctx);
  const text = result.content[0].text;
  assert.match(text, /wrote .*double-buffer-smem-tile\.md/);
  assert.match(text, /architectures sm100/);
  assert.equal(result.details.entry.confidence, "source-reported");
  assert.ok(fs.existsSync(path.join(wikiCandidatesDir(root), "double-buffer-smem-tile.md")));

  const refused = await tool.execute(
    "call",
    request({ id: "double-buffer-smem-tile", trigger: "optimize it", sources: ["c2"] }),
    undefined,
    undefined,
    ctx,
  );
  assert.match(refused.content[0].text, /entry-id-shape double-buffer-smem-tile/);
  assert.match(refused.content[0].text, /entry-trigger-category Trigger/);
});
