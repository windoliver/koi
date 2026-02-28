/**
 * Nexus JSON-RPC 2.0 transport types.
 *
 * Shared across all packages that communicate with a Nexus server.
 */

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface NexusClientConfig {
  /** Nexus server base URL (e.g., "http://localhost:2026"). */
  readonly baseUrl: string;
  /** Nexus API key for authentication. */
  readonly apiKey: string;
  /** Injectable fetch for testing. Default: globalThis.fetch. */
  readonly fetch?: typeof globalThis.fetch | undefined;
}

// ---------------------------------------------------------------------------
// JSON-RPC 2.0 protocol types
// ---------------------------------------------------------------------------

export interface JsonRpcRequest {
  readonly jsonrpc: "2.0";
  readonly id: number;
  readonly method: string;
  readonly params: Record<string, unknown>;
}

export interface JsonRpcSuccess<T> {
  readonly jsonrpc: "2.0";
  readonly id: number;
  readonly result: T;
}

export interface JsonRpcErrorResponse {
  readonly jsonrpc: "2.0";
  readonly id: number;
  readonly error: { readonly code: number; readonly message: string };
}

export type JsonRpcResponse<T> = JsonRpcSuccess<T> | JsonRpcErrorResponse;

// ---------------------------------------------------------------------------
// Client interface
// ---------------------------------------------------------------------------

import type { KoiError, Result } from "@koi/core";

/** Nexus JSON-RPC 2.0 client. */
export interface NexusClient {
  readonly rpc: <T>(
    method: string,
    params: Record<string, unknown>,
  ) => Promise<Result<T, KoiError>>;
}
