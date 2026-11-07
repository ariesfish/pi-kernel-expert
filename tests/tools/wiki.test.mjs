import assert from "node:assert/strict";
import test from "node:test";

import { buildWikiInvocation, formatWikiResult } from "../../extensions/pi-kernel-expert/tools/wiki.ts";

test("query defaults to compact output", () => {
  const invocation = buildWikiInvocation({ query: "fuse gate-up dual GEMM on Blackwell" });
  assert.equal(invocation.script, "query.py");
  assert.deepEqual(invocation.args, ["fuse gate-up dual GEMM on Blackwell", "--compact"]);
});

test("query carries filters and an explicit limit", () => {
  const invocation = buildWikiInvocation({
    query: "nvfp4",
    tag: "tcgen05",
    architecture: "sm100",
    limit: 10,
    compact: false,
  });
  assert.equal(invocation.script, "query.py");
  assert.deepEqual(invocation.args, [
    "nvfp4",
    "--tag",
    "tcgen05",
    "--architecture",
    "sm100",
    "--limit",
    "10",
  ]);
});

test("page fetch uses get_page.py and can follow sources", () => {
  const invocation = buildWikiInvocation({ page: "kernel-flash-attention-4", follow_sources: true });
  assert.equal(invocation.script, "get_page.py");
  assert.deepEqual(invocation.args, ["kernel-flash-attention-4", "--follow-sources"]);
});

test("exactly one of query or page is required", () => {
  assert.match(buildWikiInvocation({}).error, /pass a query .* or a page/);
  assert.match(buildWikiInvocation({ query: "a", page: "b" }).error, /not both/);
  assert.match(buildWikiInvocation({ query: "   " }).error, /pass a query/);
});

test("limit outside 1..50 is rejected before running python", () => {
  assert.match(buildWikiInvocation({ query: "x", limit: 0 }).error, /1 and 50/);
  assert.match(buildWikiInvocation({ query: "x", limit: 51 }).error, /1 and 50/);
  assert.match(buildWikiInvocation({ query: "x", limit: 2.5 }).error, /1 and 50/);
});

test("a successful result keeps the command line and the body", () => {
  const text = formatWikiResult({
    invocation: { script: "query.py", args: ["nvfp4", "--compact"] },
    result: { code: 0, stdout: "kernel-x  wiki/kernels/x.md\n", stderr: "", killed: false, truncated: false },
  });
  assert.match(text, /^\$ python3 scripts\/query\.py nvfp4 --compact/);
  assert.match(text, /kernel-x/);
});

test("a failed result carries the error and no fabricated matches", () => {
  const text = formatWikiResult({
    invocation: { script: "get_page.py", args: ["missing"] },
    result: { code: 1, stdout: "", stderr: "page not found", killed: false, truncated: false },
  });
  assert.match(text, /exit code 1/);
  assert.match(text, /page not found/);
  assert.doesNotMatch(text, /no matches/);
});
