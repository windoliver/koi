/**
 * DRY helper for creating a NexusClient from environment variables.
 *
 * Replaces the 5-line pattern duplicated across demo.ts and up/demo.ts.
 */

import type { NexusClient } from "@koi/nexus-client";
import { createNexusClient } from "@koi/nexus-client";

/**
 * Creates a NexusClient configured with the given base URL and
 * the NEXUS_API_KEY environment variable (if set).
 */
export function createNexusClientFromEnv(baseUrl: string): NexusClient {
  const apiKey = process.env.NEXUS_API_KEY;
  return createNexusClient({
    baseUrl,
    ...(apiKey !== undefined ? { apiKey } : {}),
  });
}
