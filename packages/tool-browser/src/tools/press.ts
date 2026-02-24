/**
 * Tool factory for `browser_press` — presses a keyboard key globally.
 */

import type { BrowserDriver, JsonObject, Tool, TrustTier } from "@koi/core";
import { parseOptionalTimeout, parseString } from "../parse-args.js";

const MIN_TIMEOUT_MS = 100;
const MAX_TIMEOUT_MS = 10_000;

export function createBrowserPressTool(
  driver: BrowserDriver,
  prefix: string,
  trustTier: TrustTier,
): Tool {
  return {
    descriptor: {
      name: `${prefix}_press`,
      description:
        "Press a keyboard key or key combination globally on the current page. Use for: " +
        "Enter (submit forms), Tab (move focus), Escape (close modals/dialogs), " +
        "ArrowDown/ArrowUp (navigate dropdowns and lists), " +
        "Control+a (select all), Control+c/v (copy/paste), Shift+Tab (reverse focus). " +
        "Key names follow Playwright conventions — single keys or combinations with " +
        'Control, Shift, Alt, Meta separated by "+". ' +
        "Key presses may trigger DOM changes: re-snapshot if the page content changes.",
      inputSchema: {
        type: "object",
        properties: {
          key: {
            type: "string",
            description:
              'Key or combo to press. Single key: "Enter", "Tab", "Escape", "ArrowDown", "Space". ' +
              'Combination: "Control+a", "Control+c", "Shift+Tab", "Alt+F4".',
          },
          timeout: {
            type: "number",
            description: `Action timeout in ms (default: 3000, max: ${MAX_TIMEOUT_MS})`,
          },
        },
        required: ["key"],
      } as JsonObject,
    },
    trustTier,
    execute: async (args: JsonObject): Promise<unknown> => {
      const keyResult = parseString(args, "key");
      if (!keyResult.ok) return keyResult.err;
      const timeoutResult = parseOptionalTimeout(args, "timeout", MIN_TIMEOUT_MS, MAX_TIMEOUT_MS);
      if (!timeoutResult.ok) return timeoutResult.err;

      const result = await driver.press(keyResult.value, {
        ...(timeoutResult.value !== undefined && { timeout: timeoutResult.value }),
      });
      if (!result.ok) {
        return { error: result.error.message, code: result.error.code };
      }
      return { success: true };
    },
  };
}
