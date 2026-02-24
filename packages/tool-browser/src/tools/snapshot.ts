/**
 * Tool factory for `browser_snapshot` — captures the accessibility tree as [ref=eN] text.
 */

import type { BrowserDriver, JsonObject, Tool, TrustTier } from "@koi/core";
import { parseOptionalNumber, parseOptionalString } from "../parse-args.js";

export function createBrowserSnapshotTool(
  driver: BrowserDriver,
  prefix: string,
  trustTier: TrustTier,
): Tool {
  return {
    descriptor: {
      name: `${prefix}_snapshot`,
      description:
        "Capture the current page as an accessibility-tree text snapshot. " +
        "Interactive elements get [ref=eN] markers (e.g., [button] Submit [ref=e3]). " +
        "Always call this before interacting with the page. Pass the returned " +
        "snapshotId to every interaction tool — if the page changes and a ref " +
        "becomes stale, you will receive a STALE_REF error telling you to " +
        "re-snapshot. Loop: snapshot → act → snapshot (after DOM-changing actions).",
      inputSchema: {
        type: "object",
        properties: {
          selector: {
            type: "string",
            description: "CSS selector to scope the snapshot to a subtree (optional)",
          },
          maxTokens: {
            type: "number",
            description: "Max tokens in the text output (default: 4000)",
          },
          maxDepth: {
            type: "number",
            description: "Max nesting depth to include (default: 8)",
          },
        },
        required: [],
      } as JsonObject,
    },
    trustTier,
    execute: async (args: JsonObject): Promise<unknown> => {
      const selectorResult = parseOptionalString(args, "selector");
      if (!selectorResult.ok) return selectorResult.err;
      const maxTokensResult = parseOptionalNumber(args, "maxTokens");
      if (!maxTokensResult.ok) return maxTokensResult.err;
      const maxDepthResult = parseOptionalNumber(args, "maxDepth");
      if (!maxDepthResult.ok) return maxDepthResult.err;

      const result = await driver.snapshot({
        ...(selectorResult.value !== undefined && { selector: selectorResult.value }),
        ...(maxTokensResult.value !== undefined && { maxTokens: maxTokensResult.value }),
        ...(maxDepthResult.value !== undefined && { maxDepth: maxDepthResult.value }),
      });
      if (!result.ok) {
        return { error: result.error.message, code: result.error.code };
      }
      // Return LLM-facing fields only (omit refs — those are for driver internals)
      const { snapshot, snapshotId, truncated, url, title } = result.value;
      return { snapshot, snapshotId, truncated, url, title };
    },
  };
}
