/**
 * Tool factory for `browser_tab_new` — opens a new browser tab.
 *
 * Supports an optional isUrlAllowed callback for URL policy enforcement.
 * This replaces the v1 @koi/scope dependency, eliminating the L2→L2 layer violation.
 */

import type { BrowserDriver, JsonObject, Tool, ToolPolicy } from "@koi/core";
import { parseOptionalString, parseOptionalTimeout, validateUrlScheme } from "../parse-args.js";

const MIN_TIMEOUT_MS = 1000;
const MAX_TIMEOUT_MS = 60_000;

export function createBrowserTabNewTool(
  driver: BrowserDriver,
  prefix: string,
  policy: ToolPolicy,
  isUrlAllowed?: (url: string) => boolean | Promise<boolean>,
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
    origin: "primordial",
    policy,
    execute: async (args: JsonObject): Promise<unknown> => {
      const urlResult = parseOptionalString(args, "url");
      if (!urlResult.ok) return urlResult.err;

      if (urlResult.value !== undefined) {
        // Block dangerous schemes before policy check
        const schemeResult = validateUrlScheme(urlResult.value);
        if (!schemeResult.ok) return schemeResult.err;
      }

      if (urlResult.value !== undefined && isUrlAllowed !== undefined) {
        const allowed = await isUrlAllowed(urlResult.value);
        if (!allowed) {
          return {
            error: `Navigation to ${urlResult.value} is not allowed by URL policy`,
            code: "PERMISSION",
          };
        }
      }

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
