/**
 * Path layout + segment validation for the Nexus snapshot store.
 *
 * Three-tier layout:
 *
 *   <basePath>/_nodes/<nodeId>.json                — canonical node payload
 *                                                    (one file per unique nodeId,
 *                                                    shared across chains)
 *   <basePath>/<chainId>/members/<nodeId>.member   — membership marker
 *                                                    (presence means nodeId belongs
 *                                                    to chainId; file body is empty {})
 *   <basePath>/<chainId>/meta.json                 — chain head pointer + nodeIds list
 *
 * The `_nodes` prefix is reserved and cannot collide with user chain IDs because
 * `validateSegment` rejects empty segments and `_nodes` begins with `_`, which is
 * a normal character — but chain IDs are user-controlled and must not equal `_nodes`.
 * By convention, callers must not use `_nodes` as a chain ID.
 */

import type { KoiError, Result } from "@koi/core";
import { RETRYABLE_DEFAULTS } from "@koi/core";

/** Canonical node payload — one file per unique nodeId, shared across chains. */
export function canonicalNodePath(basePath: string, nodeId: string): string {
  return `${basePath}/_nodes/${nodeId}.json`;
}

/** Chain membership marker — presence means nodeId belongs to chainId. */
export function memberPath(basePath: string, chainId: string, nodeId: string): string {
  return `${basePath}/${chainId}/members/${nodeId}.member`;
}

/** Glob for all membership markers in a chain (used by list/prune sweeps). */
export function memberGlob(basePath: string, chainId: string): string {
  return `${basePath}/${chainId}/members/*.member`;
}

export function metaPath(basePath: string, chainId: string): string {
  return `${basePath}/${chainId}/meta.json`;
}

/**
 * Reject path segments that could escape the basePath sandbox or collide with
 * reserved internal namespaces.
 *
 * Disallows:
 *   - empty, slash, dot-dot, backslash, null byte  — path-traversal / sandbox-escape
 *   - the literal "_nodes" (case-sensitive)          — reserved canonical-node directory
 */
export function validateSegment(segment: string, label: string): Result<void, KoiError> {
  if (segment.length === 0) return invalid(`${label} cannot be empty`);
  if (segment.includes("/")) return invalid(`${label} cannot contain '/': ${segment}`);
  if (segment === "..") return invalid(`${label} cannot be '..'`);
  if (segment.includes("\\")) return invalid(`${label} cannot contain '\\': ${segment}`);
  if (segment.includes("\0")) return invalid(`${label} cannot contain null bytes`);
  // "_nodes" is the reserved directory for canonical node files; reject it as a
  // chain ID to prevent writes to <basePath>/_nodes/meta.json which would collide
  // with canonical node storage. Case-sensitive: "_NODES" is allowed.
  if (segment === "_nodes") return invalid(`${label} cannot be the reserved name '_nodes'`);
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
