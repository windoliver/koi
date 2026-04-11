/**
 * In-flight request deduplication.
 *
 * If two identical requests (same messages + model + temperature) arrive
 * concurrently, the second awaits the first result — one API call, zero
 * double-billing. Results are NOT cached after the promise settles; only
 * active in-progress requests are deduplicated.
 *
 * Hash: SHA-256 of JSON-serialized request key fields. Collision probability
 * is negligible for the concurrent-request dedup use case.
 */

import type { ModelRequest } from "@koi/core";

export interface InFlightCache<T> {
  /**
   * If an identical request is already in flight, returns its promise.
   * Otherwise returns undefined (caller should execute and call `complete`).
   */
  readonly get: (request: ModelRequest) => Promise<T> | undefined;
  /**
   * Registers a promise for a request. The cache automatically removes it
   * when the promise settles (success or failure).
   */
  readonly set: (request: ModelRequest, promise: Promise<T>) => void;
  /** Number of in-flight requests currently tracked. */
  readonly size: () => number;
}

/**
 * Computes a stable cache key for a ModelRequest.
 *
 * Uses Web Crypto API (available in Bun natively). Falls back to a
 * JSON string key if SubtleCrypto is unavailable (e.g., in certain test envs).
 */
async function computeRequestHash(request: ModelRequest): Promise<string> {
  const key = {
    messages: request.messages,
    model: request.model,
    temperature: request.temperature,
    maxTokens: request.maxTokens,
    systemPrompt: request.systemPrompt,
    // Include tools and metadata: different tool allowlists or metadata produce
    // different model responses and must NOT share an in-flight result.
    tools: request.tools ?? [],
    metadata: request.metadata ?? {},
  };
  const json = JSON.stringify(key);

  if (typeof crypto !== "undefined" && crypto.subtle) {
    const encoded = new TextEncoder().encode(json);
    const hashBuffer = await crypto.subtle.digest("SHA-256", encoded);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  // Fallback: raw JSON (no crypto — only in test environments without SubtleCrypto)
  return json;
}

/**
 * Creates a typed in-flight dedup cache.
 *
 * The cache is asynchronous because hashing is async (SubtleCrypto).
 * Callers use `getOrExecute` to cleanly handle the async lookup.
 */
export interface InFlightCacheAsync<T> {
  /**
   * If an identical request is in flight, awaits and returns its result.
   * Otherwise, calls `execute()`, registers the promise, and returns its result.
   * Guarantees exactly one in-flight call per unique request.
   */
  readonly getOrExecute: (request: ModelRequest, execute: () => Promise<T>) => Promise<T>;
  readonly size: () => number;
}

export function createInFlightCache<T>(): InFlightCacheAsync<T> {
  const inFlight = new Map<string, Promise<T>>();

  return {
    async getOrExecute(request: ModelRequest, execute: () => Promise<T>): Promise<T> {
      const hash = await computeRequestHash(request);

      const existing = inFlight.get(hash);
      if (existing !== undefined) return existing;

      const promise = execute().finally(() => {
        inFlight.delete(hash);
      });

      inFlight.set(hash, promise);
      return promise;
    },

    size(): number {
      return inFlight.size;
    },
  };
}
