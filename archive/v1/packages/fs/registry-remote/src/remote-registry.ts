/**
 * Remote HTTP-based brick registry client.
 *
 * Implements BrickRegistryReader over HTTP with ETag/304 caching
 * for efficient polling. Also provides batch-check and hash-based
 * lookup for community marketplace integration.
 */

import type {
  BrickArtifact,
  BrickKind,
  BrickPage,
  BrickRegistryReader,
  BrickSearchQuery,
  KoiError,
  Result,
} from "@koi/core";
import { DEFAULT_BRICK_SEARCH_LIMIT } from "@koi/core";
import { toKoiError } from "@koi/errors";
import type { HttpCache } from "./http-cache.js";
import { createHttpCache } from "./http-cache.js";
import type { BatchCheckResult, RemoteRegistryConfig } from "./types.js";
import { DEFAULT_TIMEOUT_MS } from "./types.js";

// ---------------------------------------------------------------------------
// Extended client interface
// ---------------------------------------------------------------------------

export interface RemoteRegistryClient extends BrickRegistryReader {
  readonly loadByHash: (contentHash: string) => Promise<Result<BrickArtifact, KoiError>>;
  readonly batchCheck: (hashes: readonly string[]) => Promise<Result<BatchCheckResult, KoiError>>;
  readonly dispose: () => void;
}

// ---------------------------------------------------------------------------
// Internal HTTP helper
// ---------------------------------------------------------------------------

interface RequestOptions {
  readonly method: string;
  readonly url: string;
  readonly body?: unknown;
  readonly etag?: string | undefined;
  readonly fetchFn: typeof globalThis.fetch;
  readonly authToken?: string | undefined;
  readonly timeoutMs: number;
}

interface HttpResult {
  readonly status: number;
  readonly body: unknown;
  readonly etag?: string | undefined;
}

async function makeRequest(options: RequestOptions): Promise<Result<HttpResult, KoiError>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);

  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
    };

    if (options.authToken !== undefined) {
      headers.Authorization = `Bearer ${options.authToken}`;
    }

    if (options.etag !== undefined) {
      headers["If-None-Match"] = options.etag;
    }

    const init: RequestInit = {
      method: options.method,
      headers,
      signal: controller.signal,
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    };

    const response = await options.fetchFn(options.url, init);
    clearTimeout(timer);

    // 304 Not Modified — cache is still valid
    if (response.status === 304) {
      return {
        ok: true,
        value: { status: 304, body: undefined, etag: options.etag },
      };
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      return {
        ok: false,
        error: mapHttpStatusToError(response.status, text, options.url),
      };
    }

    // 204 No Content
    if (response.status === 204) {
      return { ok: true, value: { status: 204, body: undefined } };
    }

    const data: unknown = await response.json();
    const responseEtag = response.headers.get("etag") ?? undefined;

    return {
      ok: true,
      value: { status: response.status, body: data, etag: responseEtag },
    };
  } catch (e: unknown) {
    clearTimeout(timer);

    if (e instanceof DOMException && e.name === "AbortError") {
      return {
        ok: false,
        error: {
          code: "TIMEOUT",
          message: `Request to ${options.url} timed out after ${options.timeoutMs}ms`,
          retryable: true,
          context: { url: options.url, timeoutMs: options.timeoutMs },
        },
      };
    }

    return { ok: false, error: toKoiError(e) };
  }
}

function mapHttpStatusToError(status: number, body: string, url: string): KoiError {
  if (status === 404) {
    return {
      code: "NOT_FOUND",
      message: `Resource not found: ${url}`,
      retryable: false,
      context: { url, status },
    };
  }
  if (status === 403) {
    return {
      code: "PERMISSION",
      message: `Access denied: ${url}`,
      retryable: false,
      context: { url, status },
    };
  }
  if (status === 429) {
    return {
      code: "RATE_LIMIT",
      message: `Rate limited: ${url}`,
      retryable: true,
      context: { url, status },
    };
  }
  if (status === 409) {
    return {
      code: "CONFLICT",
      message: `Conflict: ${body || url}`,
      retryable: true,
      context: { url, status },
    };
  }
  if (status >= 500) {
    return {
      code: "EXTERNAL",
      message: `Server error (${status}): ${body || url}`,
      retryable: true,
      context: { url, status },
    };
  }
  return {
    code: "EXTERNAL",
    message: `HTTP ${status}: ${body || url}`,
    retryable: false,
    context: { url, status },
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a remote brick registry client for the community marketplace.
 *
 * Implements BrickRegistryReader with ETag/304 caching for search results.
 * Also provides loadByHash and batchCheck for content-addressed lookups.
 */
export function createRemoteRegistry(config: RemoteRegistryConfig): RemoteRegistryClient {
  const fetchFn = config.fetch ?? globalThis.fetch;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const baseUrl = config.baseUrl.replace(/\/+$/, "");

  const cache: HttpCache = createHttpCache({
    ttlMs: config.cacheTtlMs,
    maxEntries: config.maxCacheEntries,
  });

  // ---------------------------------------------------------------------------
  // BrickRegistryReader.search
  // ---------------------------------------------------------------------------

  const search = async (query: BrickSearchQuery): Promise<BrickPage> => {
    const params = new URLSearchParams();
    if (query.kind !== undefined) params.set("kind", query.kind);
    if (query.text !== undefined) params.set("text", query.text);
    if (query.tags !== undefined && query.tags.length > 0) {
      params.set("tags", query.tags.join(","));
    }
    if (query.namespace !== undefined) params.set("namespace", query.namespace);
    if (query.cursor !== undefined) params.set("cursor", query.cursor);
    params.set("limit", String(query.limit ?? DEFAULT_BRICK_SEARCH_LIMIT));

    const qs = params.toString();
    const url = `${baseUrl}/v1/bricks${qs.length > 0 ? `?${qs}` : ""}`;

    // Check cache for ETag-based conditional GET
    const cached = cache.get(url);
    const cachedEtag = cached?.etag;

    const result = await makeRequest({
      method: "GET",
      url,
      etag: cachedEtag,
      fetchFn,
      authToken: config.authToken,
      timeoutMs,
    });

    if (!result.ok) {
      throw new Error(`Remote registry search failed: ${result.error.message}`, {
        cause: result.error,
      });
    }

    // 304 — return cached body
    if (result.value.status === 304 && cached !== undefined) {
      return cached.body as BrickPage;
    }

    const page = result.value.body as BrickPage;

    // Cache the response with ETag
    cache.set(url, {
      etag: result.value.etag,
      body: page,
      cachedAt: Date.now(),
    });

    return page;
  };

  // ---------------------------------------------------------------------------
  // BrickRegistryReader.get
  // ---------------------------------------------------------------------------

  const get = async (
    kind: BrickKind,
    name: string,
    namespace?: string,
  ): Promise<Result<BrickArtifact, KoiError>> => {
    const ns = namespace !== undefined ? encodeURIComponent(namespace) : "_";
    const encodedName = encodeURIComponent(name);
    const url = `${baseUrl}/v1/bricks/${ns}/${encodedName}?kind=${encodeURIComponent(kind)}`;

    const result = await makeRequest({
      method: "GET",
      url,
      fetchFn,
      authToken: config.authToken,
      timeoutMs,
    });

    if (!result.ok) {
      return { ok: false, error: result.error };
    }

    return { ok: true, value: result.value.body as BrickArtifact };
  };

  // ---------------------------------------------------------------------------
  // loadByHash — content-addressed lookup
  // ---------------------------------------------------------------------------

  const loadByHash = async (contentHash: string): Promise<Result<BrickArtifact, KoiError>> => {
    const url = `${baseUrl}/v1/bricks/hash/${encodeURIComponent(contentHash)}`;

    const result = await makeRequest({
      method: "GET",
      url,
      fetchFn,
      authToken: config.authToken,
      timeoutMs,
    });

    if (!result.ok) {
      return { ok: false, error: result.error };
    }

    return { ok: true, value: result.value.body as BrickArtifact };
  };

  // ---------------------------------------------------------------------------
  // batchCheck — check existence of multiple hashes
  // ---------------------------------------------------------------------------

  const batchCheck = async (
    hashes: readonly string[],
  ): Promise<Result<BatchCheckResult, KoiError>> => {
    const url = `${baseUrl}/v1/batch-check`;

    const result = await makeRequest({
      method: "POST",
      url,
      body: { hashes },
      fetchFn,
      authToken: config.authToken,
      timeoutMs,
    });

    if (!result.ok) {
      return { ok: false, error: result.error };
    }

    return { ok: true, value: result.value.body as BatchCheckResult };
  };

  // ---------------------------------------------------------------------------
  // dispose
  // ---------------------------------------------------------------------------

  const dispose = (): void => {
    cache.clear();
  };

  return { search, get, loadByHash, batchCheck, dispose };
}
