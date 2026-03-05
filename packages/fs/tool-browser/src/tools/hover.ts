/**
 * Tool factory for `browser_hover` — hovers over an element by its snapshot ref.
 */

import type { BrowserDriver, JsonObject, Tool, ToolPolicy } from "@koi/core";
import { parseOptionalSnapshotId, parseOptionalTimeout, parseRef } from "../parse-args.js";

const MIN_TIMEOUT_MS = 100;
const MAX_TIMEOUT_MS = 10_000;

export function createBrowserHoverTool(
  driver: BrowserDriver,
  prefix: string,
  policy: ToolPolicy,
): Tool {
  return {
    descriptor: {
      name: `${prefix}_hover`,
      description:
        "Hover over an element to trigger hover effects such as dropdowns, tooltips, and " +
        "context menus. Always pass snapshotId from the last browser_snapshot call — " +
        "a STALE_REF error means the ref is outdated and you must re-snapshot. " +
        "Call browser_snapshot again after hovering if new elements appear.",
      inputSchema: {
        type: "object",
        properties: {
          ref: {
            type: "string",
            description: 'Ref key from browser_snapshot output (e.g., "e1", "e42")',
          },
          snapshotId: {
            type: "string",
            description: "snapshotId from the last browser_snapshot call (recommended)",
          },
          timeout: {
            type: "number",
            description: `Action timeout in ms (default: 3000, max: ${MAX_TIMEOUT_MS})`,
          },
        },
        required: ["ref"],
      } as JsonObject,
    },
    origin: "primordial",
    policy,
    execute: async (args: JsonObject): Promise<unknown> => {
      const refResult = parseRef(args, "ref");
      if (!refResult.ok) return refResult.err;
      const snapshotIdResult = parseOptionalSnapshotId(args, "snapshotId");
      if (!snapshotIdResult.ok) return snapshotIdResult.err;
      const timeoutResult = parseOptionalTimeout(args, "timeout", MIN_TIMEOUT_MS, MAX_TIMEOUT_MS);
      if (!timeoutResult.ok) return timeoutResult.err;

      const result = await driver.hover(refResult.value, {
        ...(snapshotIdResult.value !== undefined && { snapshotId: snapshotIdResult.value }),
        ...(timeoutResult.value !== undefined && { timeout: timeoutResult.value }),
      });
      if (!result.ok) {
        return { error: result.error.message, code: result.error.code };
      }
      return { success: true };
    },
  };
}
