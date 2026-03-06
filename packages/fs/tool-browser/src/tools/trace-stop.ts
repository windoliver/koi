/**
 * Tool factory for `browser_trace_stop` — stops the active trace and saves it.
 *
 * Debug-only — opt-in only (not in default OPERATIONS).
 * Returns the absolute path to the .zip trace file.
 */

import type { BrowserDriver, JsonObject, Tool, ToolPolicy } from "@koi/core";

export function createBrowserTraceStopTool(
  driver: BrowserDriver,
  prefix: string,
  policy: ToolPolicy,
): Tool {
  return {
    descriptor: {
      name: `${prefix}_trace_stop`,
      description:
        "Stop the active Playwright trace recording and save it to a .zip file. " +
        "Returns the path to the saved trace. " +
        "Open with: npx playwright show-trace <path>",
      inputSchema: {
        type: "object",
        properties: {},
        required: [],
      } as JsonObject,
    },
    origin: "primordial",
    policy,
    execute: async (_args: JsonObject): Promise<unknown> => {
      const traceStop = driver.traceStop;
      if (!traceStop) {
        return { error: "driver does not support trace recording", code: "INTERNAL" };
      }
      const result = await traceStop();
      if (!result.ok) {
        return { error: result.error.message, code: result.error.code };
      }
      return result.value;
    },
  };
}
