/**
 * Single-slot resolution logic.
 *
 * Checks agent-specific path first, then project-level path.
 * Returns undefined if no file exists for the slot.
 */

import { join, resolve } from "node:path";
import { isValidPathSegment, readBoundedFile } from "@koi/file-resolution";
import { fnv1a } from "@koi/hash";
import type { BootstrapSlot, ResolvedSlot } from "./types.js";

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
  if (!isValidPathSegment(slot.fileName)) {
    return undefined;
  }

  const koiDir = resolve(rootDir, ".koi");

  // Try agent-specific path first
  if (agentName !== undefined) {
    if (!isValidPathSegment(agentName)) {
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
 * Uses readBoundedFile with character budget for bounded I/O.
 */
async function tryReadSlot(
  slot: BootstrapSlot,
  filePath: string,
): Promise<ResolvedSlot | undefined> {
  const result = await readBoundedFile(filePath, slot.budget);
  if (result === undefined) {
    return undefined;
  }

  const contentHash = fnv1a(result.content);

  return {
    fileName: slot.fileName,
    label: slot.label,
    content: result.content,
    contentHash,
    resolvedFrom: filePath,
    truncated: result.truncated,
    originalSize: result.originalSize,
  };
}
