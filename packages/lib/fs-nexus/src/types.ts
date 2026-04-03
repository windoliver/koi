/**
 * Configuration and transport types for @koi/fs-nexus.
 */

import type { KoiError, Result } from "@koi/core";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface NexusFileSystemConfig {
  /** Nexus server URL, e.g. "http://localhost:3100" or "https://nexus.example.com". */
  readonly url: string;
  /** Optional API key for Bearer auth. */
  readonly apiKey?: string | undefined;
  /** Nexus path prefix for all file operations. Default: "fs". */
  readonly mountPoint?: string | undefined;
  /** Total deadline for an operation including retries (ms). Default: 45_000. */
  readonly deadlineMs?: number | undefined;
  /** Max retry attempts for transient failures. Default: 2. */
  readonly retries?: number | undefined;
}

// ---------------------------------------------------------------------------
// Transport (inline — extract to @koi/nexus-client when 2nd consumer exists)
// ---------------------------------------------------------------------------

/** JSON-RPC 2.0 transport for Nexus server communication. */
export interface NexusTransport {
  /** Call a Nexus RPC method. Returns Result on all outcomes (never throws). */
  readonly call: <T>(
    method: string,
    params: Record<string, unknown>,
  ) => Promise<Result<T, KoiError>>;
  /** Close the transport, aborting any pending requests. */
  readonly close: () => void;
  /** Mount points discovered during startup (local transport only). */
  readonly mounts?: readonly string[] | undefined;
}

// ---------------------------------------------------------------------------
// JSON-RPC envelope (internal)
// ---------------------------------------------------------------------------

export interface JsonRpcRequest {
  readonly jsonrpc: "2.0";
  readonly method: string;
  readonly params: Record<string, unknown>;
  readonly id: number;
}

export interface JsonRpcError {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

export interface JsonRpcResponse<T = unknown> {
  readonly jsonrpc: "2.0";
  readonly id: number;
  readonly result?: T;
  readonly error?: JsonRpcError;
}
