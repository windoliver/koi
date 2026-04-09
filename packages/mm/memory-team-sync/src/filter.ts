/**
 * Memory filtering for team sync — type filtering + secret scanning.
 *
 * Fail-closed: any error during scanning blocks the memory.
 * "user" type is always denied regardless of config.
 */

import type { MemoryRecord, MemoryType } from "@koi/core";
import { createAllSecretPatterns, createRedactor } from "@koi/redaction";
import type { SyncBlockedEntry } from "./types.js";
import { DEFAULT_ALLOWED_TYPES } from "./types.js";

/** Lazily initialized redactor for secret scanning. */
// let justified: lazy singleton to avoid compiling patterns on import
let cachedRedactor: ReturnType<typeof createRedactor> | undefined;

function getRedactor(): ReturnType<typeof createRedactor> {
  if (cachedRedactor === undefined) {
    cachedRedactor = createRedactor({
      patterns: createAllSecretPatterns(),
    });
  }
  return cachedRedactor;
}

/** Result of filtering a single memory. */
export interface FilterResult {
  readonly passed: boolean;
  readonly blocked?: SyncBlockedEntry | undefined;
}

/**
 * Filters a memory for team sync eligibility.
 *
 * Checks in order:
 * 1. Type must be in allowedTypes (user is always denied)
 * 2. Content must pass secret scanning (fail-closed on error)
 */
export function filterMemoryForSync(
  memory: MemoryRecord,
  allowedTypes: readonly MemoryType[] = DEFAULT_ALLOWED_TYPES,
): FilterResult {
  // Always deny "user" type regardless of allowedTypes config
  if (memory.type === "user") {
    return {
      passed: false,
      blocked: {
        memoryId: memory.id,
        reason: "type_denied",
        detail: `type "user" is always private`,
      },
    };
  }

  // Check allowed types
  if (!allowedTypes.includes(memory.type)) {
    return {
      passed: false,
      blocked: {
        memoryId: memory.id,
        reason: "type_denied",
        detail: `type "${memory.type}" not in allowed types`,
      },
    };
  }

  // Scan for secrets — fail-closed on any error
  try {
    const redactor = getRedactor();
    const scanResult = redactor.redactString(memory.content);

    if (scanResult.changed) {
      return {
        passed: false,
        blocked: {
          memoryId: memory.id,
          reason: "secret_detected",
          detail: `${scanResult.matchCount} secret(s) detected in content`,
        },
      };
    }

    // Also scan name and description
    const nameScan = redactor.redactString(memory.name);
    if (nameScan.changed) {
      return {
        passed: false,
        blocked: {
          memoryId: memory.id,
          reason: "secret_detected",
          detail: `secret detected in memory name`,
        },
      };
    }

    const descScan = redactor.redactString(memory.description);
    if (descScan.changed) {
      return {
        passed: false,
        blocked: {
          memoryId: memory.id,
          reason: "secret_detected",
          detail: `secret detected in memory description`,
        },
      };
    }
  } catch (_e: unknown) {
    // Fail-closed: any scan error blocks the memory
    return {
      passed: false,
      blocked: {
        memoryId: memory.id,
        reason: "scan_error",
        detail: "secret scanning failed — blocked by default",
      },
    };
  }

  return { passed: true };
}

/**
 * Filters all memories for team sync, returning eligible and blocked lists.
 */
export function filterMemoriesForSync(
  memories: readonly MemoryRecord[],
  allowedTypes?: readonly MemoryType[],
): {
  readonly eligible: readonly MemoryRecord[];
  readonly blocked: readonly SyncBlockedEntry[];
} {
  const eligible: MemoryRecord[] = [];
  const blocked: SyncBlockedEntry[] = [];

  for (const memory of memories) {
    const result = filterMemoryForSync(memory, allowedTypes);
    if (result.passed) {
      eligible.push(memory);
    } else if (result.blocked !== undefined) {
      blocked.push(result.blocked);
    }
  }

  return { eligible, blocked };
}
