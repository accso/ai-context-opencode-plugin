import { tool } from "./tool-def.js";
import { computeAdoption } from "../telemetry/adoption.js";
import type { TelemetryRecorder } from "../telemetry/telemetry.js";

/**
 * Native tool exposing the plugin's in-process telemetry recorder (see
 * plan.md, "overlap-benchmark-spike" -- telemetry endpoints). This is
 * the "endpoint" the benchmark harness (and any curious agent/user) can
 * call to retrieve real latency data for every tool call OpenCode made
 * this session -- native `grep`/`glob` included, not just this
 * plugin's own tools -- since `tool.execute.before`/`tool.execute.after`
 * fire for all of them.
 *
 * As a plugin (not a standalone HTTP server), a native tool call is the
 * closest equivalent to a monitoring "endpoint": no separate transport,
 * no extra process, and the same in-process recorder instance the
 * plugin's own hooks feed.
 */
export function createTelemetryReportTool(recorder: TelemetryRecorder) {
  return tool({
    description: [
      "Use when the user asks how often the context tools are used, about",
      "token usage, or which tools are slow. Reports telemetry (call count,",
      "total/avg latency per tool) collected",
      "automatically this session by the ai-context plugin's tool.execute",
      "hooks -- covers every tool call, including native grep/glob, not",
      "just this plugin's own tools. Needs no manual instrumentation;",
      'view "adoption" compares context tools with grep/glob.',
    ].join(" "),
    args: {
      view: tool.schema
        .enum(["summary", "adoption"])
        .optional()
        .describe(
          'Default "summary" (latency per tool). "adoption" reports how often the context tools were used instead of grep/glob.',
        ),
    },
    async execute(args) {
      if (args.view === "adoption")
        return JSON.stringify(computeAdoption(recorder.getEntries()));
      return JSON.stringify(recorder.getSummary());
    },
  });
}
