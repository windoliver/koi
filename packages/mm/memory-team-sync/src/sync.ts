/**
 * Team memory sync — validates, filters, and (eventually) transports memories.
 *
 * Transport is NOT implemented — this is a safety boundary stub.
 * Returns eligible/blocked counts to establish the filtering contract.
 */

import { filterMemoriesForSync } from "./filter.js";
import type { TeamSyncConfig, TeamSyncResult } from "./types.js";
import { DEFAULT_ALLOWED_TYPES } from "./types.js";

/**
 * Synchronizes team memories with a remote endpoint.
 *
 * Current implementation:
 * 1. Validates config (returns skipped if no endpoint)
 * 2. Lists local memories
 * 3. Filters by type + secret scanning
 * 4. Returns results (transport is a no-op stub)
 */
export async function syncTeamMemories(config: TeamSyncConfig): Promise<TeamSyncResult> {
  // No remote endpoint = sync disabled
  if (config.remoteEndpoint === undefined || config.remoteEndpoint.length === 0) {
    return {
      eligible: 0,
      blocked: 0,
      blockedEntries: [],
      errors: [],
      skipped: true,
    };
  }

  const memories = await config.listMemories();
  const allowedTypes = config.allowedTypes ?? DEFAULT_ALLOWED_TYPES;
  const { eligible, blocked } = filterMemoriesForSync(memories, allowedTypes);

  return {
    eligible: eligible.length,
    blocked: blocked.length,
    blockedEntries: blocked,
    errors:
      eligible.length > 0
        ? ["transport not yet implemented — eligible memories were not pushed"]
        : [],
    skipped: false,
  };
}
