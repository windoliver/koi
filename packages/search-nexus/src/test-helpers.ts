/**
 * Shared test utilities for @koi/search-nexus.
 */

import type { NexusSearchConfig } from "./nexus-search-config.js";

export const BASE_CONFIG: NexusSearchConfig = {
  baseUrl: "http://localhost:2026",
  apiKey: "sk-test",
} as const;

/**
 * Creates a mock fetch function returning a fixed response.
 */
export function createMockFetch(response: {
  readonly status: number;
  readonly body: unknown;
}): typeof fetch {
  return (async () => ({
    ok: response.status >= 200 && response.status < 300,
    status: response.status,
    json: async () => response.body,
    text: async () => JSON.stringify(response.body),
  })) as unknown as typeof fetch;
}
