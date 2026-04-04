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
// Bridge notifications (local transport only)
// ---------------------------------------------------------------------------

/**
 * Out-of-band notification sent by the Python bridge on stdout (no `id` field).
 * Used exclusively for the inline OAuth flow — the bridge sends these while
 * an in-flight request is parked waiting for authentication to complete.
 *
 * Notification handlers registered via `NexusTransport.subscribe()` MUST be
 * non-blocking. Handlers are dispatched via a microtask and must resolve
 * quickly or offload work to their own queue.
 */
export type BridgeNotification =
  | {
      readonly jsonrpc: "2.0";
      readonly method: "auth_required";
      readonly params: {
        readonly provider: string;
        readonly user_email: string;
        readonly auth_url: string;
        readonly message: string;
        /**
         * "local"  — localhost callback server is running; browser redirect completes automatically.
         * "remote" — SSH/headless; user must paste the full redirect URL back into the conversation.
         */
        readonly mode: "local" | "remote";
        /** Only present when mode is "remote". Instructions to show the user. */
        readonly instructions?: string | undefined;
      };
    }
  | {
      readonly jsonrpc: "2.0";
      readonly method: "auth_complete";
      readonly params: {
        readonly provider: string;
        readonly user_email: string;
      };
    }
  | {
      readonly jsonrpc: "2.0";
      readonly method: "auth_progress";
      readonly params: {
        readonly provider: string;
        readonly elapsed_seconds: number;
        readonly message: string;
      };
    };

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
  /**
   * Subscribe to bridge notifications (auth_required, auth_complete, auth_progress).
   * Returns an unsubscribe function — call it to stop receiving notifications.
   *
   * HTTP transport always returns a no-op unsubscribe (notifications are
   * local-bridge-only — they travel over the stdio pipe, not HTTP).
   *
   * Handler MUST be non-blocking — it is dispatched via a microtask and must
   * resolve quickly or offload to its own queue.
   */
  readonly subscribe: (handler: (n: BridgeNotification) => void) => () => void;
  /**
   * Forward a pasted redirect URL to the bridge for the remote OAuth flow.
   * Called by the channel adapter when it receives a pasted redirect URL from
   * the user after an `auth_required` notification with `mode: "remote"`.
   *
   * The bridge extracts `?code=...` from the URL and completes the exchange.
   * No-op on HTTP transport (remote auth is local-bridge-only).
   */
  readonly submitAuthCode: (redirectUrl: string) => void;
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
