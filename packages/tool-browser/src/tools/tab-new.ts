/**
 * Tool factory for `browser_tab_new` — opens a new browser tab.
 */

import type { BrowserDriver, JsonObject, Tool, TrustTier } from "@koi/core";
import { parseOptionalString, parseOptionalTimeout } from "../parse-args.js";

const MIN_TIMEOUT_MS = 1000;
const MAX_TIMEOUT_MS = 60_000;

export function createBrowserTabNewTool(
  driver: BrowserDriver,
  prefix: string,
  trustTier: TrustTier,
): Tool {
  return {
    descriptor: {
      name: `${prefix}_tab_new`,
      description: "Open a new browser tab, optionally navigating to a URL immediately.",
      inputSchema: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "URL to navigate to in the new tab (optional)",
          },
          timeout: {
            type: "number",
            description: `Timeout in ms (default: 15000, max: ${MAX_TIMEOUT_MS})`,
          },
        },
        required: [],
      } as JsonObject,
    },
    trustTier,
    execute: async (args: JsonObject): Promise<unknown> => {
      const urlResult = parseOptionalString(args, "url");
      if (!urlResult.ok) return urlResult.err;
      const timeoutResult = parseOptionalTimeout(args, "timeout", MIN_TIMEOUT_MS, MAX_TIMEOUT_MS);
      if (!timeoutResult.ok) return timeoutResult.err;

      const result = await driver.tabNew({
        ...(urlResult.value !== undefined && { url: urlResult.value }),
        ...(timeoutResult.value !== undefined && { timeout: timeoutResult.value }),
      });
      if (!result.ok) {
        return { error: result.error.message, code: result.error.code };
      }
      return result.value;
    },
  };
}
