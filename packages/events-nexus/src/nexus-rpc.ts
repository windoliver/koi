/**
 * JSON-RPC 2.0 client for Nexus filesystem operations.
 *
 * Provides a typed `rpc<T>(method, params)` wrapper that maps HTTP and
 * JSON-RPC errors to KoiError results. Supports injectable fetch for testing.
 */

import type { KoiError, Result } from "@koi/core";
import { RETRYABLE_DEFAULTS } from "@koi/core";

// ---------------------------------------------------------------------------
// JSON-RPC types
// ---------------------------------------------------------------------------

interface JsonRpcRequest {
  readonly jsonrpc: "2.0";
  readonly id: number;
  readonly method: string;
  readonly params: Record<string, unknown>;
}

interface JsonRpcSuccess<T> {
  readonly jsonrpc: "2.0";
  readonly id: number;
  readonly result: T;
}

interface JsonRpcError {
  readonly jsonrpc: "2.0";
  readonly id: number;
  readonly error: { readonly code: number; readonly message: string };
}

type JsonRpcResponse<T> = JsonRpcSuccess<T> | JsonRpcError;

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface NexusRpcConfig {
  /** Nexus server base URL (e.g., "http://localhost:2026"). */
  readonly baseUrl: string;
  /** Nexus API key for authentication. */
  readonly apiKey: string;
  /** Injectable fetch for testing. Default: globalThis.fetch. */
  readonly fetch?: typeof globalThis.fetch | undefined;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export interface NexusRpcClient {
  /** Send a JSON-RPC 2.0 request and return a typed Result. */
  readonly rpc: <T>(
    method: string,
    params: Record<string, unknown>,
  ) => Promise<Result<T, KoiError>>;
}

/** Create a JSON-RPC 2.0 client for Nexus. */
export function createNexusRpcClient(config: NexusRpcConfig): NexusRpcClient {
  const fetchFn = config.fetch ?? globalThis.fetch;
  // let justified: monotonically increasing counter for JSON-RPC request IDs
  let counter = 0;

  function nextRpcId(): number {
    counter += 1;
    return counter;
  }

  async function rpc<T>(
    method: string,
    params: Record<string, unknown>,
  ): Promise<Result<T, KoiError>> {
    const body: JsonRpcRequest = { jsonrpc: "2.0", id: nextRpcId(), method, params };

    // let justified: response assigned in try block, read after
    let response: Response;
    try {
      response = await fetchFn(config.baseUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify(body),
      });
    } catch (err: unknown) {
      return {
        ok: false,
        error: {
          code: "EXTERNAL",
          message: `Nexus request failed: ${err instanceof Error ? err.message : String(err)}`,
          retryable: true,
          cause: err,
        },
      };
    }

    if (!response.ok) {
      return { ok: false, error: mapHttpError(response.status) };
    }

    // let justified: json assigned in try block, read after
    let json: JsonRpcResponse<T>;
    try {
      json = (await response.json()) as JsonRpcResponse<T>;
    } catch {
      return {
        ok: false,
        error: { code: "INTERNAL", message: "Failed to parse Nexus response", retryable: false },
      };
    }

    if ("error" in json) {
      return { ok: false, error: mapRpcError(json.error) };
    }

    return { ok: true, value: json.result };
  }

  return { rpc };
}

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

function mapHttpError(status: number): KoiError {
  const message = `Nexus HTTP ${String(status)}`;
  if (status === 404) {
    return { code: "NOT_FOUND", message, retryable: RETRYABLE_DEFAULTS.NOT_FOUND };
  }
  if (status === 403 || status === 401) {
    return { code: "PERMISSION", message, retryable: RETRYABLE_DEFAULTS.PERMISSION };
  }
  if (status === 409) {
    return { code: "CONFLICT", message, retryable: RETRYABLE_DEFAULTS.CONFLICT };
  }
  if (status === 429) {
    return { code: "RATE_LIMIT", message, retryable: RETRYABLE_DEFAULTS.RATE_LIMIT };
  }
  return { code: "EXTERNAL", message, retryable: true };
}

function mapRpcError(rpcError: { readonly code: number; readonly message: string }): KoiError {
  if (rpcError.code === -32601) {
    return {
      code: "EXTERNAL",
      message: `RPC method not found: ${rpcError.message}`,
      retryable: false,
    };
  }
  return { code: "EXTERNAL", message: rpcError.message, retryable: true };
}
