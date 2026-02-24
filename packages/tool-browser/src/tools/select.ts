/**
 * Tool factory for `browser_select` — selects an option in a combobox by ref.
 */

import type { BrowserDriver, JsonObject, Tool, TrustTier } from "@koi/core";
import {
  parseOptionalSnapshotId,
  parseOptionalTimeout,
  parseRef,
  parseString,
} from "../parse-args.js";

const MIN_TIMEOUT_MS = 100;
const MAX_TIMEOUT_MS = 10_000;

export function createBrowserSelectTool(
  driver: BrowserDriver,
  prefix: string,
  trustTier: TrustTier,
): Tool {
  return {
    descriptor: {
      name: `${prefix}_select`,
      description: "Select an option in a combobox or listbox identified by its snapshot ref.",
      inputSchema: {
        type: "object",
        properties: {
          ref: {
            type: "string",
            description: 'Ref key of the combobox/listbox (e.g., "e5")',
          },
          value: {
            type: "string",
            description: "Option value or label to select",
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
        required: ["ref", "value"],
      } as JsonObject,
    },
    trustTier,
    execute: async (args: JsonObject): Promise<unknown> => {
      const refResult = parseRef(args, "ref");
      if (!refResult.ok) return refResult.err;
      const valueResult = parseString(args, "value");
      if (!valueResult.ok) return valueResult.err;
      const snapshotIdResult = parseOptionalSnapshotId(args, "snapshotId");
      if (!snapshotIdResult.ok) return snapshotIdResult.err;
      const timeoutResult = parseOptionalTimeout(args, "timeout", MIN_TIMEOUT_MS, MAX_TIMEOUT_MS);
      if (!timeoutResult.ok) return timeoutResult.err;

      const result = await driver.select(refResult.value, valueResult.value, {
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
