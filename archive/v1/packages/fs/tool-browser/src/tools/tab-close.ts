/**
 * Tool factory for `browser_tab_close` — closes a browser tab.
 */

import type { BrowserDriver, JsonObject, Tool, ToolPolicy } from "@koi/core";
import { parseOptionalString, parseOptionalTimeout } from "../parse-args.js";

const MIN_TIMEOUT_MS = 100;
const MAX_TIMEOUT_MS = 10_000;

export function createBrowserTabCloseTool(
  driver: BrowserDriver,
  prefix: string,
  policy: ToolPolicy,
): Tool {
  return {
    descriptor: {
      name: `${prefix}_tab_close`,
      description: "Close a browser tab. Closes the current tab if tabId is not specified.",
      inputSchema: {
        type: "object",
        properties: {
          tabId: {
            type: "string",
            description:
              "ID of the tab to close (from browser_tab_new or browser_tab_focus). Omit to close current tab.",
          },
          timeout: {
            type: "number",
            description: `Timeout in ms (default: 3000, max: ${MAX_TIMEOUT_MS})`,
          },
        },
        required: [],
      } as JsonObject,
    },
    origin: "primordial",
    policy,
    execute: async (args: JsonObject): Promise<unknown> => {
      const tabIdResult = parseOptionalString(args, "tabId");
      if (!tabIdResult.ok) return tabIdResult.err;
      const timeoutResult = parseOptionalTimeout(args, "timeout", MIN_TIMEOUT_MS, MAX_TIMEOUT_MS);
      if (!timeoutResult.ok) return timeoutResult.err;

      const result = await driver.tabClose(tabIdResult.value, {
        ...(timeoutResult.value !== undefined && { timeout: timeoutResult.value }),
      });
      if (!result.ok) {
        return { error: result.error.message, code: result.error.code };
      }
      return { success: true };
    },
  };
}
