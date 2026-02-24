/**
 * Single-slot resolution logic.
 *
 * Checks agent-specific path first, then project-level path.
 * Returns undefined if no file exists for the slot.
 */

import { join, resolve } from "node:path";
import { mapFsError } from "@koi/errors";
import { fnv1a } from "@koi/hash";
import type { BootstrapSlot, ResolvedSlot } from "./types.js";

/** Allowlist for path segments (agent names and file names). */
const SAFE_PATH_SEGMENT = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

/** Maximum bytes to read per file (4 bytes per char worst-case UTF-8). */
const BYTES_PER_CHAR_MAX = 4;

/**
 * Validates that a path segment is safe (no traversal, no special chars).
 * Returns true if the segment is safe to use in path construction.
 */
function isSafePathSegment(segment: string): boolean {
  return SAFE_PATH_SEGMENT.test(segment);
}

/**
 * Resolves a single bootstrap slot from the .koi/ hierarchy.
 *
 * Resolution order:
 * 1. {rootDir}/.koi/agents/{agentName}/{slot.fileName} (if agentName provided)
 * 2. {rootDir}/.koi/{slot.fileName}
 * 3. undefined (no file found)
 */
export async function resolveSlot(
  slot: BootstrapSlot,
  rootDir: string,
  agentName: string | undefined,
): Promise<ResolvedSlot | undefined> {
  // Validate fileName to prevent path traversal
  if (!isSafePathSegment(slot.fileName)) {
    return undefined;
  }

  const koiDir = resolve(rootDir, ".koi");

  // Try agent-specific path first
  if (agentName !== undefined) {
    if (!isSafePathSegment(agentName)) {
      return undefined;
    }
    const agentPath = join(koiDir, "agents", agentName, slot.fileName);
    const resolved = await tryReadSlot(slot, agentPath);
    if (resolved !== undefined) {
      return resolved;
    }
  }

  // Fall back to project-level path
  const projectPath = join(koiDir, slot.fileName);
  return tryReadSlot(slot, projectPath);
}

/**
 * Attempts to read a single file for a slot.
 * Returns undefined if the file does not exist.
 *
 * Budget is character-based. Reads a bounded number of bytes
 * (budget * 4 for worst-case UTF-8), then truncates by characters.
 */
async function tryReadSlot(
  slot: BootstrapSlot,
  filePath: string,
): Promise<ResolvedSlot | undefined> {
  const file = Bun.file(filePath);
  const exists = await file.exists();
  if (!exists) {
    return undefined;
  }

  try {
    const originalSize = file.size;
    // Read bounded bytes, then character-truncate for consistent budget semantics
    const maxBytes = slot.budget * BYTES_PER_CHAR_MAX;
    const raw = await file.slice(0, maxBytes).text();
    const truncated = raw.length > slot.budget;
    const content = truncated ? raw.slice(0, slot.budget) : raw;
    const contentHash = fnv1a(content);

    return {
      fileName: slot.fileName,
      label: slot.label,
      content,
      contentHash,
      resolvedFrom: filePath,
      truncated,
      originalSize,
    };
  } catch (e: unknown) {
    // Re-throw with FS-aware error mapping for better diagnostics
    const mapped = mapFsError(e, filePath);
    throw new Error(mapped.message, { cause: e });
  }
}
