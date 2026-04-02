/**
 * Configuration and transport types for the Nexus-backed FileSystemBackend.
 */

import type { JsonObject } from "@koi/core";

// ---------------------------------------------------------------------------
// Transport abstraction
// ---------------------------------------------------------------------------

/**
 * JSON-RPC transport for Nexus communication.
 *
 * Implementations handle serialization, HTTP/socket concerns, and connection
 * lifecycle. The FileSystemBackend delegates all RPC calls through this.
 */
export interface NexusTransport {
  /** Send a JSON-RPC call and return the typed result. Throws on transport failure. */
  readonly call: <T>(method: string, params: JsonObject) => Promise<T>;
  /** Close the transport connection. Safe to call multiple times. */
  readonly close: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// HTTP transport config
// ---------------------------------------------------------------------------

export interface HttpTransportConfig {
  /** Nexus server URL (e.g. "http://localhost:3100"). */
  readonly url: string;
  /** Per-request timeout in milliseconds. Default: 30_000. */
  readonly timeout?: number;
  /** Injectable fetch for testing. Default: globalThis.fetch. */
  readonly fetch?: typeof globalThis.fetch;
}

// ---------------------------------------------------------------------------
// Backend config
// ---------------------------------------------------------------------------

export interface NexusFileSystemConfig {
  /** JSON-RPC transport — injected. Use createHttpTransport() for HTTP. */
  readonly transport: NexusTransport;
  /** RPC path prefix for all filesystem operations. Default: "fs". */
  readonly basePath?: string | undefined;
}
