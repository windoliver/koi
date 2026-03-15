/**
 * createNexusClient — JSON-RPC 2.0 transport for Nexus services.
 *
 * Provides a typed RPC method that handles:
 * - Bearer auth via apiKey
 * - Monotonic request ID generation
 * - HTTP error → KoiError mapping
 * - JSON-RPC error → KoiError mapping
 * - Injectable fetch for testing
 */

import type { KoiError, Result } from "@koi/core";
import { mapHttpError, mapRpcError } from "./errors.js";
import type { JsonRpcRequest, JsonRpcResponse, NexusClient, NexusClientConfig } from "./types.js";

function createRpcIdGenerator(): () => number {
  // let justified: monotonically increasing counter for JSON-RPC request IDs
  let counter = 0;
  return () => {
    counter += 1;
    return counter;
  };
}

/** Create a Nexus JSON-RPC 2.0 client. */
export function createNexusClient(config: NexusClientConfig): NexusClient {
  const fetchFn = config.fetch ?? globalThis.fetch;
  const nextRpcId = createRpcIdGenerator();

  async function rpc<T>(
    method: string,
    params: Record<string, unknown>,
  ): Promise<Result<T, KoiError>> {
    const body: JsonRpcRequest = { jsonrpc: "2.0", id: nextRpcId(), method, params };

    let response: Response;
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (config.apiKey) {
        headers.Authorization = `Bearer ${config.apiKey}`;
      }

      // Nexus serves JSON-RPC at /api/nfs/{method} — strip trailing slash
      // from baseUrl then append the method-specific path.
      const base = config.baseUrl.replace(/\/+$/, "");
      const url = `${base}/api/nfs/${encodeURIComponent(method)}`;

      response = await fetchFn(url, {
        method: "POST",
        headers,
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
      return { ok: false, error: mapHttpError(response.status, `Nexus HTTP ${response.status}`) };
    }

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

    if (!("result" in json)) {
      return {
        ok: false,
        error: {
          code: "INTERNAL",
          message: "Malformed JSON-RPC response: missing result",
          retryable: false,
        },
      };
    }

    return { ok: true, value: json.result };
  }

  return { rpc };
}
