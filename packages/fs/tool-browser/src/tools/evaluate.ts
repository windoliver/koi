/**
 * Tool factory for `browser_evaluate` — executes arbitrary JavaScript.
 *
 * PROMOTED trust tier. NOT in default OPERATIONS. Must be explicitly enabled.
 * This tool has access to the full page context including cookies and storage.
 */

import type { BrowserDriver, JsonObject, Tool, ToolPolicy } from "@koi/core";
import { parseOptionalTimeout, parseString } from "../parse-args.js";

const MIN_TIMEOUT_MS = 100;
const MAX_TIMEOUT_MS = 10_000;

export function createBrowserEvaluateTool(
  driver: BrowserDriver,
  prefix: string,
  policy: ToolPolicy,
): Tool {
  return {
    descriptor: {
      name: `${prefix}_evaluate`,
      description:
        "Execute arbitrary JavaScript in the current page context. " +
        "WARNING: This tool has access to cookies, localStorage, and all page APIs. " +
        "Use only when browser_snapshot cannot provide the needed information.",
      inputSchema: {
        type: "object",
        properties: {
          script: {
            type: "string",
            description:
              "JavaScript expression to evaluate. The return value must be JSON-serializable.",
          },
          timeout: {
            type: "number",
            description: `Execution timeout in ms (default: 5000, max: ${MAX_TIMEOUT_MS})`,
          },
        },
        required: ["script"],
      } as JsonObject,
    },
    origin: "primordial",
    policy,
    execute: async (args: JsonObject): Promise<unknown> => {
      const scriptResult = parseString(args, "script");
      if (!scriptResult.ok) return scriptResult.err;
      const timeoutResult = parseOptionalTimeout(args, "timeout", MIN_TIMEOUT_MS, MAX_TIMEOUT_MS);
      if (!timeoutResult.ok) return timeoutResult.err;

      const result = await driver.evaluate(scriptResult.value, {
        ...(timeoutResult.value !== undefined && { timeout: timeoutResult.value }),
      });
      if (!result.ok) {
        return { error: result.error.message, code: result.error.code };
      }
      return result.value;
    },
  };
}
