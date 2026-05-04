/**
 * Path layout + segment validation for the Nexus snapshot store.
 *
 * Snapshots are stored as JSON files at deterministic paths:
 *   <basePath>/<chainId>/<nodeId>.json   — node payload
 *   <basePath>/<chainId>/meta.json       — chain head + node list
 */

import type { KoiError, Result } from "@koi/core";
import { RETRYABLE_DEFAULTS } from "@koi/core";

export function nodePath(basePath: string, chainId: string, nodeId: string): string {
  return `${basePath}/${chainId}/${nodeId}.json`;
}

export function metaPath(basePath: string, chainId: string): string {
  return `${basePath}/${chainId}/meta.json`;
}

/**
 * Reject path segments that could escape the basePath sandbox.
 * Disallows: empty, slash, dot-dot, backslash, null byte.
 */
export function validateSegment(segment: string, label: string): Result<void, KoiError> {
  if (segment.length === 0) return invalid(`${label} cannot be empty`);
  if (segment.includes("/")) return invalid(`${label} cannot contain '/': ${segment}`);
  if (segment === "..") return invalid(`${label} cannot be '..'`);
  if (segment.includes("\\")) return invalid(`${label} cannot contain '\\': ${segment}`);
  if (segment.includes("\0")) return invalid(`${label} cannot contain null bytes`);
  return { ok: true, value: undefined };
}

function invalid(message: string): Result<void, KoiError> {
  return {
    ok: false,
    error: {
      code: "VALIDATION",
      message,
      retryable: RETRYABLE_DEFAULTS.VALIDATION,
    },
  };
}
