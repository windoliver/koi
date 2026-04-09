/**
 * Tool factory for `browser_trace_start` — begins recording a Playwright trace.
 *
 * Debug-only — opt-in only (not in default OPERATIONS).
 * Stop recording with browser_trace_stop to save the .zip file.
 */

import type { BrowserDriver, JsonObject, Tool, ToolPolicy } from "@koi/core";
import { parseOptionalBoolean, parseOptionalString } from "../parse-args.js";

export function createBrowserTraceStartTool(
  driver: BrowserDriver,
  prefix: string,
  policy: ToolPolicy,
): Tool {
  return {
    descriptor: {
      name: `${prefix}_trace_start`,
      description:
        "Start recording a Playwright trace for debugging. " +
        "Stop with browser_trace_stop to save the trace as a .zip file. " +
        "Open saved traces with: npx playwright show-trace <path>",
      inputSchema: {
        type: "object",
        properties: {
          snapshots: {
            type: "boolean",
            description: "Include DOM snapshots in the trace (default: true).",
          },
          network: {
            type: "boolean",
            description: "Include network request/response metadata (default: true).",
          },
          title: {
            type: "string",
            description: "Name label written into the trace metadata.",
          },
        },
        required: [],
      } as JsonObject,
    },
    origin: "primordial",
    policy,
    execute: async (args: JsonObject): Promise<unknown> => {
      const snapshotsResult = parseOptionalBoolean(args, "snapshots");
      if (!snapshotsResult.ok) return snapshotsResult.err;

      const networkResult = parseOptionalBoolean(args, "network");
      if (!networkResult.ok) return networkResult.err;

      const titleResult = parseOptionalString(args, "title");
      if (!titleResult.ok) return titleResult.err;

      const traceStart = driver.traceStart;
      if (!traceStart) {
        return { error: "driver does not support trace recording", code: "INTERNAL" };
      }
      const result = await traceStart({
        ...(snapshotsResult.value !== undefined && { snapshots: snapshotsResult.value }),
        ...(networkResult.value !== undefined && { network: networkResult.value }),
        ...(titleResult.value !== undefined && { title: titleResult.value }),
      });
      if (!result.ok) {
        return { error: result.error.message, code: result.error.code };
      }
      return { success: true };
    },
  };
}
