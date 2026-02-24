/**
 * Tool factory for `browser_fill_form` — fills multiple form fields in one call.
 */

import type { BrowserDriver, JsonObject, Tool, TrustTier } from "@koi/core";
import { parseFormFields, parseOptionalSnapshotId, parseOptionalTimeout } from "../parse-args.js";

const MIN_TIMEOUT_MS = 100;
const MAX_TIMEOUT_MS = 30_000;

export function createBrowserFillFormTool(
  driver: BrowserDriver,
  prefix: string,
  trustTier: TrustTier,
): Tool {
  return {
    descriptor: {
      name: `${prefix}_fill_form`,
      description:
        "Fill multiple form fields in one call. More efficient than calling " +
        "browser_type/browser_select per field for multi-field forms. " +
        "Always pass snapshotId from the last browser_snapshot call — " +
        "a STALE_REF error on any field means the snapshot is outdated: " +
        "re-snapshot and retry with fresh refs.",
      inputSchema: {
        type: "object",
        properties: {
          fields: {
            type: "array",
            description: "Array of {ref, value, clear?} objects to fill",
            items: {
              type: "object",
              properties: {
                ref: { type: "string", description: 'Ref key (e.g., "e3")' },
                value: { type: "string", description: "Value to fill" },
                clear: {
                  type: "boolean",
                  description: "Clear existing content before filling (default: false)",
                },
              },
              required: ["ref", "value"],
            },
          },
          snapshotId: {
            type: "string",
            description: "snapshotId from the last browser_snapshot call (recommended)",
          },
          timeout: {
            type: "number",
            description: `Total timeout for all fields in ms (default: 10000, max: ${MAX_TIMEOUT_MS})`,
          },
        },
        required: ["fields"],
      } as JsonObject,
    },
    trustTier,
    execute: async (args: JsonObject): Promise<unknown> => {
      const fieldsResult = parseFormFields(args, "fields");
      if (!fieldsResult.ok) return fieldsResult.err;
      const snapshotIdResult = parseOptionalSnapshotId(args, "snapshotId");
      if (!snapshotIdResult.ok) return snapshotIdResult.err;
      const timeoutResult = parseOptionalTimeout(args, "timeout", MIN_TIMEOUT_MS, MAX_TIMEOUT_MS);
      if (!timeoutResult.ok) return timeoutResult.err;

      const result = await driver.fillForm(fieldsResult.value, {
        ...(snapshotIdResult.value !== undefined && { snapshotId: snapshotIdResult.value }),
        ...(timeoutResult.value !== undefined && { timeout: timeoutResult.value }),
      });
      if (!result.ok) {
        return { error: result.error.message, code: result.error.code };
      }
      return { success: true, fieldsFilledCount: fieldsResult.value.length };
    },
  };
}
