/**
 * Tool factory for `browser_console` — reads buffered console messages from the current page.
 */

import type { BrowserDriver, JsonObject, Tool, TrustTier } from "@koi/core";
import {
  parseOptionalBoolean,
  parseOptionalConsoleLevels,
  parseOptionalNumber,
} from "../parse-args.js";

const MIN_LIMIT = 1;
const MAX_LIMIT = 200;

export function createBrowserConsoleTool(
  driver: BrowserDriver,
  prefix: string,
  trustTier: TrustTier,
): Tool {
  return {
    descriptor: {
      name: `${prefix}_console`,
      description:
        "Read buffered console messages from the current browser page. " +
        "Captures log, warning, error, debug, and info level messages from the " +
        "page's JavaScript console. Useful for diagnosing JavaScript errors and " +
        "page-side issues without needing browser_evaluate.",
      inputSchema: {
        type: "object",
        properties: {
          levels: {
            type: "array",
            items: { type: "string", enum: ["log", "warning", "error", "debug", "info"] },
            description: "Filter by level(s). Default: all levels.",
          },
          limit: {
            type: "number",
            description: `Max entries to return from most recent (default: 50, min: ${MIN_LIMIT}, max: ${MAX_LIMIT}).`,
          },
          clear: {
            type: "boolean",
            description: "Clear the console buffer after reading (default: false).",
          },
        },
      } as JsonObject,
    },
    trustTier,
    execute: async (args: JsonObject): Promise<unknown> => {
      const levelsResult = parseOptionalConsoleLevels(args, "levels");
      if (!levelsResult.ok) return levelsResult.err;

      const limitResult = parseOptionalNumber(args, "limit");
      if (!limitResult.ok) return limitResult.err;

      if (limitResult.value !== undefined) {
        if (limitResult.value < MIN_LIMIT || limitResult.value > MAX_LIMIT) {
          return {
            error: `limit must be between ${MIN_LIMIT} and ${MAX_LIMIT}`,
            code: "VALIDATION",
          };
        }
      }

      const clearResult = parseOptionalBoolean(args, "clear");
      if (!clearResult.ok) return clearResult.err;

      const result = await driver.console({
        ...(levelsResult.value !== undefined && { levels: levelsResult.value }),
        ...(limitResult.value !== undefined && { limit: limitResult.value }),
        ...(clearResult.value !== undefined && { clear: clearResult.value }),
      });

      if (!result.ok) {
        return { error: result.error.message, code: result.error.code };
      }

      return { success: true, entries: result.value.entries, total: result.value.total };
    },
  };
}
