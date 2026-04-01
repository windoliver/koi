/**
 * Tool factory for `browser_screenshot` — captures a screenshot.
 */

import type { BrowserDriver, JsonObject, Tool, ToolPolicy } from "@koi/core";
import { parseOptionalBoolean, parseOptionalNumber, parseOptionalTimeout } from "../parse-args.js";

const MIN_TIMEOUT_MS = 100;
const MAX_TIMEOUT_MS = 30_000;

export function createBrowserScreenshotTool(
  driver: BrowserDriver,
  prefix: string,
  policy: ToolPolicy,
): Tool {
  return {
    descriptor: {
      name: `${prefix}_screenshot`,
      description:
        "Capture a screenshot of the current page. Returns base64-encoded JPEG by default. " +
        "Use browser_snapshot instead when the page has standard HTML/ARIA content — " +
        "it is ~100x cheaper. Reserve screenshot for canvases, CAPTCHAs, or visual-only content.",
      inputSchema: {
        type: "object",
        properties: {
          fullPage: {
            type: "boolean",
            description: "Capture full scrollable page (default: false — viewport only)",
          },
          quality: {
            type: "number",
            description: "JPEG quality 1–100 (default: 80). Use 100 for lossless.",
          },
          timeout: {
            type: "number",
            description: `Timeout in ms (default: 5000, max: ${MAX_TIMEOUT_MS})`,
          },
        },
        required: [],
      } as JsonObject,
    },
    origin: "primordial",
    policy,
    execute: async (args: JsonObject): Promise<unknown> => {
      const fullPageResult = parseOptionalBoolean(args, "fullPage");
      if (!fullPageResult.ok) return fullPageResult.err;
      const qualityResult = parseOptionalNumber(args, "quality");
      if (!qualityResult.ok) return qualityResult.err;
      const timeoutResult = parseOptionalTimeout(args, "timeout", MIN_TIMEOUT_MS, MAX_TIMEOUT_MS);
      if (!timeoutResult.ok) return timeoutResult.err;

      const result = await driver.screenshot({
        ...(fullPageResult.value !== undefined && { fullPage: fullPageResult.value }),
        ...(qualityResult.value !== undefined && { quality: qualityResult.value }),
        ...(timeoutResult.value !== undefined && { timeout: timeoutResult.value }),
      });
      if (!result.ok) {
        return { error: result.error.message, code: result.error.code };
      }
      return result.value;
    },
  };
}
