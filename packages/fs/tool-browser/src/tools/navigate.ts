/**
 * Tool factory for `browser_navigate` — navigates to a URL.
 */

import type { BrowserDriver, JsonObject, Tool, ToolPolicy } from "@koi/core";
import { parseOptionalTimeout, parseOptionalWaitUntil } from "../parse-args.js";
import type { CompiledNavigationSecurity } from "../url-security.js";
import { parseSecureUrl } from "../url-security.js";

const MIN_TIMEOUT_MS = 1000;
const MAX_TIMEOUT_MS = 60_000;

export function createBrowserNavigateTool(
  driver: BrowserDriver,
  prefix: string,
  policy: ToolPolicy,
  security?: CompiledNavigationSecurity,
): Tool {
  return {
    descriptor: {
      name: `${prefix}_navigate`,
      description:
        "Navigate the current tab to a URL. Invalidates all refs from previous snapshots — " +
        "call browser_snapshot after navigating to get fresh refs.",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string", description: "URL to navigate to (must include scheme)" },
          waitUntil: {
            type: "string",
            enum: ["load", "networkidle", "commit", "domcontentloaded"],
            description: "When to consider navigation complete (default: load)",
          },
          timeout: {
            type: "number",
            description: `Navigation timeout in ms (default: 15000, max: ${MAX_TIMEOUT_MS})`,
          },
        },
        required: ["url"],
      } as JsonObject,
    },
    origin: "primordial",
    policy,
    execute: async (args: JsonObject): Promise<unknown> => {
      const urlResult = parseSecureUrl(args, "url", security);
      if (!urlResult.ok) return urlResult.err;
      const waitUntilResult = parseOptionalWaitUntil(args, "waitUntil");
      if (!waitUntilResult.ok) return waitUntilResult.err;
      const timeoutResult = parseOptionalTimeout(args, "timeout", MIN_TIMEOUT_MS, MAX_TIMEOUT_MS);
      if (!timeoutResult.ok) return timeoutResult.err;

      const result = await driver.navigate(urlResult.value, {
        ...(waitUntilResult.value !== undefined && { waitUntil: waitUntilResult.value }),
        ...(timeoutResult.value !== undefined && { timeout: timeoutResult.value }),
      });
      if (!result.ok) {
        return { error: result.error.message, code: result.error.code };
      }
      return result.value;
    },
  };
}
