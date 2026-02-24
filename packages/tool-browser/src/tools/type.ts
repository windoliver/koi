/**
 * Tool factory for `browser_type` — types text into an element by its snapshot ref.
 */

import type { BrowserDriver, JsonObject, Tool, TrustTier } from "@koi/core";
import {
  parseOptionalBoolean,
  parseOptionalSnapshotId,
  parseOptionalTimeout,
  parseRef,
  parseString,
} from "../parse-args.js";

const MIN_TIMEOUT_MS = 100;
const MAX_TIMEOUT_MS = 10_000;

export function createBrowserTypeTool(
  driver: BrowserDriver,
  prefix: string,
  trustTier: TrustTier,
): Tool {
  return {
    descriptor: {
      name: `${prefix}_type`,
      description: "Type text into an element identified by its snapshot ref.",
      inputSchema: {
        type: "object",
        properties: {
          ref: {
            type: "string",
            description: 'Ref key from browser_snapshot output (e.g., "e3")',
          },
          value: { type: "string", description: "Text to type into the element" },
          clear: {
            type: "boolean",
            description: "Clear existing content before typing (default: false)",
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
      const clearResult = parseOptionalBoolean(args, "clear");
      if (!clearResult.ok) return clearResult.err;
      const snapshotIdResult = parseOptionalSnapshotId(args, "snapshotId");
      if (!snapshotIdResult.ok) return snapshotIdResult.err;
      const timeoutResult = parseOptionalTimeout(args, "timeout", MIN_TIMEOUT_MS, MAX_TIMEOUT_MS);
      if (!timeoutResult.ok) return timeoutResult.err;

      const result = await driver.type(refResult.value, valueResult.value, {
        ...(clearResult.value !== undefined && { clear: clearResult.value }),
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
