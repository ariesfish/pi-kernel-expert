import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { num, obj, oneOf, opt, str, type Static } from "@earendil-works/pi-schema";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { readContract } from "../kernel/contract.ts";
import {
  type SassView,
  cannotSee,
  census,
  describeLaunch,
  describeView,
  launch,
  live,
  operands,
  parseSass,
  resolveKernel,
  schedule,
  serial,
  struct,
} from "../kernel/sass.ts";

/** The views, in the order a reader usually wants them. */
export const VIEWS = ["census", "operands", "serial", "schedule", "live", "struct", "launch"] as const;

const ParamsSchema = obj({
  view: oneOf(VIEWS, { description: "Which reading to produce." }),
  dump: opt(str({ description: "Dump file. Default: read stdin." })),
  workspace: opt(str({ description: "Task workspace. Default: current directory." })),
  kernel: opt(str({ description: "Kernel name, or a substring of it. Required when the dump holds several." })),
  metrics: opt(
    str({
      description:
        "For `launch`: a file with the launch__* metrics (ncu details page, or key = value lines). Default: the dump itself, which only works for CSV with those columns.",
    }),
  ),
  budget: opt(
    num({ description: "For `live`: override the register budget. Default: the contract's M0 budget, if any." }),
  ),
  text: opt(str({ description: "The dump inline, for a dump you already hold in context." })),
});
type Params = Static<typeof ParamsSchema>;

export function registerSassTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "kernel_sass",
    label: "Read a SASS dump",
    description:
      "Answer six structural questions from a SASS dump you already have — no GPU at analysis time. Views: census (which kernel, how many instructions of which family), operands (is the MMA A operand a register or a smem descriptor), serial (did ptxas serialize the wgmma pipeline, and by how much), schedule (MMA runs, barriers, LDSM, and whether a wait sits before each elementwise run — the overlap fact), live (peak registers against the contract's M0 budget), struct (basic blocks, barriers, precision and tile read from the opcodes), launch (grid, block, cluster, registers per thread from launch__* metrics). Reads cuobjdump -sass and the ncu source page (plain or CSV with Instructions Executed) with one parser. Never guesses the kernel: pass kernel, or the view takes the most-executed one, or it refuses naming the candidates.",
    promptSnippet: "Read a SASS dump: census, operands, serial, schedule, live, struct, launch",
    promptGuidelines: [
      "Produce the dump yourself: `cuobjdump -sass build/kernel.cubin > sass.txt`, or `ncu --import rep.ncu-rep --page source --print-source sass`. This tool reads; it never collects.",
      "Pass `kernel` whenever the dump holds more than one. Without it the tool takes the kernel with the most executed instructions (only when the dump counts them) and otherwise refuses with the candidates and their instruction counts — `kernels[0]` is how a histogram gets built from the RNG kernel.",
      "A read is not a gate. `[VERIFY: sass-derived]` on a gate line needs its price: cite the reading here and a `[PRICED: <delta>, <profile run or KB entry>]` on the same line.",
      "`operands` before blaming the register budget: `a_reg=0` with a nonzero `a_desc` means the operand path goes through smem and the budget was never the binding constraint.",
      "`serial` names ptxas, not the algorithm: a ratio near 1 means the compiler could not prove the accumulator untouched and put a wait between every pair. Do not ban a direction over it.",
      "`live` needs a contract for a verdict band; without one it reports the peak and says no band was applied. Never assume a budget.",
    ],
    parameters: ParamsSchema,
    async execute(
      _toolCallId,
      rawParams,
      _signal,
      _onUpdate,
      ctx,
    ): Promise<{ content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> }> {
      const params = rawParams as Params;
      const workspace = params.workspace ? path.resolve(ctx.cwd, params.workspace) : ctx.cwd;
      let text = params.text ?? "";
      let source = "<inline>";
      if (text === "") {
        if (!params.dump) {
          return {
            content: [
              {
                type: "text" as const,
                text: "kernel_sass needs a dump. Pass `dump: <path>` or `text:` with the dump inline; this tool never collects one (that is cuobjdump or ncu, on the machine with the GPU).",
              },
            ],
            details: { ok: false, refusals: [{ rule: "sass-no-input" }] },
          };
        }
        const file = path.resolve(workspace, params.dump);
        source = path.relative(workspace, file) || file;
        try {
          text = fs.readFileSync(file, "utf8");
        } catch {
          return {
            content: [{ type: "text" as const, text: `There is no dump at ${source}.` }],
            details: { ok: false, refusals: [{ rule: "sass-no-input" }] },
          };
        }
      }
      if (text.trim() === "") {
        return {
          content: [{ type: "text" as const, text: `${source} is empty: a dump with no instruction in it proves nothing.` }],
          details: { ok: false, refusals: [{ rule: "sass-empty" }] },
        };
      }

      const parsed = parseSass(text);
      const resolved = resolveKernel(parsed.dump, params.kernel ?? null);
      if (!resolved.ok) {
        return {
          content: [
            {
              type: "text" as const,
              text: [
                `kernel_sass refused: ${resolved.reason}.`,
                parsed.unparsed.length > 0 ? `(${parsed.unparsed.length} line(s) did not parse; the dump may not be SASS.)` : "",
              ]
                .filter((line) => line !== "")
                .join("\n"),
            },
          ],
          details: { ok: false, refusals: [{ rule: "sass-kernel-ambiguous", reason: resolved.reason }] },
        };
      }

      const kernel = resolved.kernel;
      const header = [
        `dump ${source} sha256 ${createHash("sha256").update(text).digest("hex").slice(0, 16)}`,
        `kernel ${kernel.name} (${resolved.how === "named" ? "named" : resolved.how === "only" ? "the only kernel" : "most executed"})`,
      ];

      let view: SassView;
      if (params.view === "census") view = census(kernel);
      else if (params.view === "operands") view = operands(kernel);
      else if (params.view === "serial") view = serial(kernel);
      else if (params.view === "schedule") view = schedule(kernel);
      else if (params.view === "live") {
        const budget = params.budget ?? readMilestoneBudget(workspace);
        view = live(kernel, budget);
      } else if (params.view === "struct") view = struct(kernel);
      else {
        let metricsText = params.text ?? "";
        if (params.metrics) {
          const file = path.resolve(workspace, params.metrics);
          try {
            metricsText = fs.readFileSync(file, "utf8");
          } catch {
            return {
              content: [{ type: "text" as const, text: `There is no metrics file at ${params.metrics}.` }],
              details: { ok: false, refusals: [{ rule: "sass-no-metrics" }] },
            };
          }
        }
        view = launch(kernel, metricsText === "" ? text : `${text}\n${metricsText}`);
      }

      const lines = [describeView(view), ...header, cannotSee(params.view), ...describeLaunch(view)];
      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
        details: { ok: true, view: params.view, kernel: kernel.name, dump: source, reading: view },
      };
    },
  });
}

/**
 * The contract's `M0 Contract` register budget, when the workspace has both. A
 * missing contract is not a refusal: `live` reports the peak and applies no band,
 * which is the honest reading of "nobody froze a budget".
 */
export function readMilestoneBudget(workspace: string): number | null {
  const loaded = readContract(workspace);
  if (!loaded.ok) return null;
  const file = path.join(workspace, "docs", "milestone.md");
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  const match = /^\s*-\s*register budget:\s*(\d+)/im.exec(text);
  return match ? Number.parseInt(match[1], 10) : null;
}
