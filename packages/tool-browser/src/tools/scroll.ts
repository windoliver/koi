/**
 * Tool factory for `browser_scroll` — scrolls the page or to an element.
 */

import type { BrowserDriver, JsonObject, Tool, TrustTier } from "@koi/core";
import {
  parseOptionalNumber,
  parseOptionalRef,
  parseOptionalScrollDirection,
  parseOptionalSnapshotId,
  parseOptionalTimeout,
} from "../parse-args.js";

const MIN_TIMEOUT_MS = 100;
const MAX_TIMEOUT_MS = 10_000;

export function createBrowserScrollTool(
  driver: BrowserDriver,
  prefix: string,
  trustTier: TrustTier,
): Tool {
  return {
    descriptor: {
      name: `${prefix}_scroll`,
      description:
        "Scroll the page in a direction, or scroll to bring an element into view. " +
        "Provide ref to scroll to an element; provide direction to scroll the page.",
      inputSchema: {
        type: "object",
        properties: {
          ref: {
            type: "string",
            description: 'Ref key to scroll into view (e.g., "e10"). If omitted, scrolls the page.',
          },
          direction: {
            type: "string",
            enum: ["up", "down", "left", "right"],
            description: "Page scroll direction (required when ref is omitted)",
          },
          amount: {
            type: "number",
            description: "Scroll amount in pixels (default: 500, only applies to page scroll)",
          },
          snapshotId: {
            type: "string",
            description:
              "snapshotId from the last browser_snapshot (required when ref is provided)",
          },
          timeout: {
            type: "number",
            description: `Action timeout in ms (default: 3000, max: ${MAX_TIMEOUT_MS})`,
          },
        },
        required: [],
      } as JsonObject,
    },
    trustTier,
    execute: async (args: JsonObject): Promise<unknown> => {
      const refResult = parseOptionalRef(args, "ref");
      if (!refResult.ok) return refResult.err;
      const directionResult = parseOptionalScrollDirection(args, "direction");
      if (!directionResult.ok) return directionResult.err;
      const amountResult = parseOptionalNumber(args, "amount");
      if (!amountResult.ok) return amountResult.err;
      const snapshotIdResult = parseOptionalSnapshotId(args, "snapshotId");
      if (!snapshotIdResult.ok) return snapshotIdResult.err;
      const timeoutResult = parseOptionalTimeout(args, "timeout", MIN_TIMEOUT_MS, MAX_TIMEOUT_MS);
      if (!timeoutResult.ok) return timeoutResult.err;

      // Build discriminated union for driver
      const ref = refResult.value;
      const direction = directionResult.value;

      if (ref !== undefined) {
        const result = await driver.scroll({
          kind: "element",
          ref,
          ...(snapshotIdResult.value !== undefined && { snapshotId: snapshotIdResult.value }),
          ...(timeoutResult.value !== undefined && { timeout: timeoutResult.value }),
        });
        if (!result.ok) return { error: result.error.message, code: result.error.code };
        return { success: true };
      }

      if (direction === undefined) {
        return {
          error: "Provide either ref (scroll to element) or direction (scroll page)",
          code: "VALIDATION",
        };
      }

      const result = await driver.scroll({
        kind: "page",
        direction,
        ...(amountResult.value !== undefined && { amount: amountResult.value }),
        ...(timeoutResult.value !== undefined && { timeout: timeoutResult.value }),
      });
      if (!result.ok) return { error: result.error.message, code: result.error.code };
      return { success: true };
    },
  };
}
