/**
 * Tool factory for `browser_upload` — uploads files to a file input element.
 *
 * Opt-in only (not in default OPERATIONS). Must be explicitly enabled in
 * BrowserProviderConfig because it writes files to the server-side process.
 */

import type { BrowserDriver, JsonObject, Tool, TrustTier } from "@koi/core";
import {
  parseOptionalBoolean,
  parseOptionalSnapshotId,
  parseOptionalTimeout,
  parseRef,
  parseUploadFiles,
} from "../parse-args.js";

const MIN_TIMEOUT_MS = 100;
const MAX_TIMEOUT_MS = 10_000;

export function createBrowserUploadTool(
  driver: BrowserDriver,
  prefix: string,
  trustTier: TrustTier,
): Tool {
  return {
    descriptor: {
      name: `${prefix}_upload`,
      description:
        "Upload one or more files to a file input element identified by its snapshot ref. " +
        "Files must be provided as base64-encoded content with a filename.",
      inputSchema: {
        type: "object",
        properties: {
          ref: {
            type: "string",
            description: 'Ref key of the file input element (e.g., "e3" from browser_snapshot).',
          },
          files: {
            type: "array",
            description: "Files to upload. Each must have content (base64) and name.",
            items: {
              type: "object",
              properties: {
                content: {
                  type: "string",
                  description: "Base64-encoded file content.",
                },
                name: {
                  type: "string",
                  description: "Filename as it will appear in the input element.",
                },
                mimeType: {
                  type: "string",
                  description: "MIME type (default: application/octet-stream).",
                },
              },
              required: ["content", "name"],
            },
            minItems: 1,
          },
          snapshotId: {
            type: "string",
            description: "Snapshot ID from the last browser_snapshot call (recommended).",
          },
          timeout: {
            type: "number",
            description: `Action timeout in ms (default: 3000, max: ${MAX_TIMEOUT_MS})`,
          },
        },
        required: ["ref", "files"],
      } as JsonObject,
    },
    trustTier,
    execute: async (args: JsonObject): Promise<unknown> => {
      const refResult = parseRef(args, "ref");
      if (!refResult.ok) return refResult.err;

      const filesResult = parseUploadFiles(args, "files");
      if (!filesResult.ok) return filesResult.err;

      const snapshotIdResult = parseOptionalSnapshotId(args, "snapshotId");
      if (!snapshotIdResult.ok) return snapshotIdResult.err;

      const timeoutResult = parseOptionalTimeout(args, "timeout", MIN_TIMEOUT_MS, MAX_TIMEOUT_MS);
      if (!timeoutResult.ok) return timeoutResult.err;

      const clearResult = parseOptionalBoolean(args, "clear");
      if (!clearResult.ok) return clearResult.err;

      const upload = driver.upload;
      if (!upload) {
        return { error: "driver does not support file upload", code: "INTERNAL" };
      }
      const result = await upload(refResult.value, filesResult.value, {
        ...(snapshotIdResult.value !== undefined && { snapshotId: snapshotIdResult.value }),
        ...(timeoutResult.value !== undefined && { timeout: timeoutResult.value }),
        ...(clearResult.value !== undefined && { clear: clearResult.value }),
      });
      if (!result.ok) {
        return { error: result.error.message, code: result.error.code };
      }
      return { success: true };
    },
  };
}
