/**
 * Thin async client over the official MCP registry HTTP API
 * (registry.modelcontextprotocol.io v0.1).
 *
 * The public read API is unauthenticated. The client surfaces 429 as a
 * retryable RATE_LIMIT error — backoff is the caller's responsibility
 * (the registry does not document rate-limit headers as of 2025-12).
 */

import type { KoiError, Result } from "@koi/core";
import { RETRYABLE_DEFAULTS } from "@koi/core";
import {
  type RegistryServer,
  registrySearchResponseSchema,
  registryServerResponseSchema,
} from "./schema.js";

export const DEFAULT_REGISTRY_BASE_URL = "https://registry.modelcontextprotocol.io";

export interface SearchOptions {
  readonly query?: string;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface SearchResult {
  readonly servers: readonly RegistryServer[];
  readonly nextCursor: string | undefined;
}

export interface RegistryClient {
  readonly searchServers: (opts: SearchOptions) => Promise<Result<SearchResult, KoiError>>;
  readonly getServer: (name: string, version?: string) => Promise<Result<RegistryServer, KoiError>>;
}

export interface RegistryClientOptions {
  readonly baseUrl?: string;
  readonly fetch?: typeof fetch;
}

export function createRegistryClient(options: RegistryClientOptions = {}): RegistryClient {
  const baseUrl = (options.baseUrl ?? DEFAULT_REGISTRY_BASE_URL).replace(/\/+$/, "");
  const fetchImpl = options.fetch ?? fetch;

  async function searchServers(opts: SearchOptions): Promise<Result<SearchResult, KoiError>> {
    const params = new URLSearchParams();
    if (opts.query !== undefined && opts.query.length > 0) params.set("search", opts.query);
    if (opts.limit !== undefined) params.set("limit", String(opts.limit));
    if (opts.cursor !== undefined && opts.cursor.length > 0) params.set("cursor", opts.cursor);
    const qs = params.toString();
    const url = `${baseUrl}/v0.1/servers${qs.length > 0 ? `?${qs}` : ""}`;

    const fetched = await tryFetch(fetchImpl, url);
    if (!fetched.ok) return fetched;
    const parsed = await parseJsonAsync(fetched.value, url);
    if (!parsed.ok) return parsed;
    const validated = safeParse(registrySearchResponseSchema, parsed.value, url);
    if (!validated.ok) return validated;
    return {
      ok: true,
      value: { servers: validated.value.servers, nextCursor: validated.value.metadata?.nextCursor },
    };
  }

  async function getServer(
    name: string,
    version = "latest",
  ): Promise<Result<RegistryServer, KoiError>> {
    const url = `${baseUrl}/v0.1/servers/${encodeURIComponent(name)}/versions/${encodeURIComponent(version)}`;
    const fetched = await tryFetch(fetchImpl, url);
    if (!fetched.ok) return fetched;
    const parsed = await parseJsonAsync(fetched.value, url);
    if (!parsed.ok) return parsed;
    return safeParse(registryServerResponseSchema, parsed.value, url);
  }

  return { searchServers, getServer };
}

async function tryFetch(fetchImpl: typeof fetch, url: string): Promise<Result<Response, KoiError>> {
  try {
    const response = await fetchImpl(url);
    if (!response.ok) {
      return { ok: false, error: mapHttpStatus(response.status, url) };
    }
    return { ok: true, value: response };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      error: {
        code: "EXTERNAL",
        message: `MCP registry request failed: ${message}`,
        retryable: RETRYABLE_DEFAULTS.EXTERNAL,
        cause: error instanceof Error ? error : undefined,
        context: { url },
      },
    };
  }
}

async function parseJsonAsync(response: Response, url: string): Promise<Result<unknown, KoiError>> {
  let text: string;
  try {
    text = await response.text();
  } catch (error: unknown) {
    return { ok: false, error: validationError(error, "failed to read registry response", url) };
  }
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch (error: unknown) {
    return {
      ok: false,
      error: validationError(error, "registry response was not valid JSON", url),
    };
  }
}

function safeParse<T>(
  schema: {
    readonly safeParse: (input: unknown) => { success: boolean; data?: T; error?: unknown };
  },
  input: unknown,
  url: string,
): Result<T, KoiError> {
  const result = schema.safeParse(input);
  if (result.success && result.data !== undefined) {
    return { ok: true, value: result.data };
  }
  return {
    ok: false,
    error: {
      code: "VALIDATION",
      message: "registry response did not match expected schema",
      retryable: false,
      cause: result.error instanceof Error ? result.error : undefined,
      context: { url },
    },
  };
}

function validationError(error: unknown, message: string, url: string): KoiError {
  const detail = error instanceof Error ? error.message : String(error);
  return {
    code: "VALIDATION",
    message: `${message}: ${detail}`,
    retryable: false,
    cause: error instanceof Error ? error : undefined,
    context: { url },
  };
}

function mapHttpStatus(status: number, url: string): KoiError {
  if (status === 404) {
    return {
      code: "NOT_FOUND",
      message: `MCP registry: server not found (HTTP 404)`,
      retryable: false,
      context: { url, status },
    };
  }
  if (status === 429) {
    return {
      code: "RATE_LIMIT",
      message: `MCP registry: rate limited (HTTP 429) — retry later`,
      retryable: true,
      context: { url, status },
    };
  }
  if (status >= 500) {
    return {
      code: "EXTERNAL",
      message: `MCP registry: upstream error (HTTP ${status})`,
      retryable: true,
      context: { url, status },
    };
  }
  return {
    code: "EXTERNAL",
    message: `MCP registry: unexpected HTTP ${status}`,
    retryable: false,
    context: { url, status },
  };
}
