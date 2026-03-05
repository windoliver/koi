/**
 * Tool factory for `browser_wait` — waits for a timeout, selector, or navigation.
 */

import type { BrowserDriver, JsonObject, Tool, ToolPolicy } from "@koi/core";
import {
  parseOptionalSelectorState,
  parseOptionalTimeout,
  parseOptionalWaitUntil,
  parseString,
  parseTimeout,
  parseWaitKind,
} from "../parse-args.js";

const MIN_TIMEOUT_MS = 100;
const MAX_WAIT_TIMEOUT_MS = 30_000;

export function createBrowserWaitTool(
  driver: BrowserDriver,
  prefix: string,
  policy: ToolPolicy,
): Tool {
  return {
    descriptor: {
      name: `${prefix}_wait`,
      description:
        "Wait for a timeout duration, a selector to reach a state, or a navigation event.",
      inputSchema: {
        type: "object",
        properties: {
          kind: {
            type: "string",
            enum: ["timeout", "selector", "navigation"],
            description: "What to wait for",
          },
          timeout: {
            type: "number",
            description:
              "For kind=timeout: exact wait in ms (required). " +
              "For others: max wait before failing (optional, default: 5000)",
          },
          selector: {
            type: "string",
            description: "CSS selector (required for kind=selector)",
          },
          state: {
            type: "string",
            enum: ["visible", "hidden", "attached", "detached"],
            description: "Selector state to wait for (default: visible)",
          },
          event: {
            type: "string",
            enum: ["load", "networkidle", "commit", "domcontentloaded"],
            description: "Navigation event to wait for (default: load)",
          },
        },
        required: ["kind"],
      } as JsonObject,
    },
    origin: "primordial",
    policy,
    execute: async (args: JsonObject): Promise<unknown> => {
      const kindResult = parseWaitKind(args, "kind");
      if (!kindResult.ok) return kindResult.err;

      const kind = kindResult.value;

      if (kind === "timeout") {
        const timeoutResult = parseTimeout(args, "timeout", MIN_TIMEOUT_MS, MAX_WAIT_TIMEOUT_MS);
        if (!timeoutResult.ok) return timeoutResult.err;
        const result = await driver.wait({ kind: "timeout", timeout: timeoutResult.value });
        if (!result.ok) return { error: result.error.message, code: result.error.code };
        return { success: true };
      }

      if (kind === "selector") {
        const selectorResult = parseString(args, "selector");
        if (!selectorResult.ok) return selectorResult.err;
        const stateResult = parseOptionalSelectorState(args, "state");
        if (!stateResult.ok) return stateResult.err;
        const timeoutResult = parseOptionalTimeout(
          args,
          "timeout",
          MIN_TIMEOUT_MS,
          MAX_WAIT_TIMEOUT_MS,
        );
        if (!timeoutResult.ok) return timeoutResult.err;
        const result = await driver.wait({
          kind: "selector",
          selector: selectorResult.value,
          ...(stateResult.value !== undefined && { state: stateResult.value }),
          ...(timeoutResult.value !== undefined && { timeout: timeoutResult.value }),
        });
        if (!result.ok) return { error: result.error.message, code: result.error.code };
        return { success: true };
      }

      // kind === "navigation"
      const eventResult = parseOptionalWaitUntil(args, "event");
      if (!eventResult.ok) return eventResult.err;
      const timeoutResult = parseOptionalTimeout(
        args,
        "timeout",
        MIN_TIMEOUT_MS,
        MAX_WAIT_TIMEOUT_MS,
      );
      if (!timeoutResult.ok) return timeoutResult.err;
      const result = await driver.wait({
        kind: "navigation",
        ...(eventResult.value !== undefined && { event: eventResult.value }),
        ...(timeoutResult.value !== undefined && { timeout: timeoutResult.value }),
      });
      if (!result.ok) return { error: result.error.message, code: result.error.code };
      return { success: true };
    },
  };
}
