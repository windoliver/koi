/**
 * Tool factory for `browser_tab_focus` — switches focus to a tab.
 */

import type { BrowserDriver, JsonObject, Tool, TrustTier } from "@koi/core";
import { parseOptionalTimeout, parseString } from "../parse-args.js";

const MIN_TIMEOUT_MS = 100;
const MAX_TIMEOUT_MS = 10_000;

export function createBrowserTabFocusTool(
  driver: BrowserDriver,
  prefix: string,
  trustTier: TrustTier,
): Tool {
  return {
    descriptor: {
      name: `${prefix}_tab_focus`,
      description:
        "Switch focus to a specific browser tab, making it the active page. " +
        "After switching, call browser_snapshot to get refs for the new tab's content.",
      inputSchema: {
        type: "object",
        properties: {
          tabId: {
            type: "string",
            description: "ID of the tab to focus (from browser_tab_new result)",
          },
          timeout: {
            type: "number",
            description: `Timeout in ms (default: 3000, max: ${MAX_TIMEOUT_MS})`,
          },
        },
        required: ["tabId"],
      } as JsonObject,
    },
    trustTier,
    execute: async (args: JsonObject): Promise<unknown> => {
      const tabIdResult = parseString(args, "tabId");
      if (!tabIdResult.ok) return tabIdResult.err;
      const timeoutResult = parseOptionalTimeout(args, "timeout", MIN_TIMEOUT_MS, MAX_TIMEOUT_MS);
      if (!timeoutResult.ok) return timeoutResult.err;

      const result = await driver.tabFocus(tabIdResult.value, {
        ...(timeoutResult.value !== undefined && { timeout: timeoutResult.value }),
      });
      if (!result.ok) {
        return { error: result.error.message, code: result.error.code };
      }
      return result.value;
    },
  };
}
