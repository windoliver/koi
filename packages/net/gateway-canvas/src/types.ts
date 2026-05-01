/**
 * Public types for @koi/gateway-canvas — surface store, SSE manager, HTTP server.
 *
 * Defined locally so the package stays self-contained at L2 (depends only on
 * `@koi/core` + `@koi/hash`). All properties readonly.
 */

import type { Result } from "@koi/core";

// ---------------------------------------------------------------------------
// Surface store
// ---------------------------------------------------------------------------

/**
 * A stored canvas surface — opaque content blob with hash-based ETag.
 * Surfaces are agent-rendered HTML/JSON. The store does not interpret content.
 */
export interface SurfaceEntry {
  readonly surfaceId: string;
  readonly content: string;
  /** Hex content hash, used as ETag. */
  readonly contentHash: string;
  /**
   * Authenticated identity that created the surface. Subsequent writes
   * (PATCH/DELETE) must be performed by the same `ownerId`. Undefined only
   * when the server runs without an authenticator (single-tenant mode).
   */
  readonly ownerId?: string | undefined;
  /**
   * Monotonic per-store identifier for *this instance* of the surface.
   * Distinct from `surfaceId`: re-creating the same `surfaceId` after a
   * delete produces a fresh `generationId`. Used by SSE subscribe to detect
   * delete/recreate races so a stream cannot be silently spliced across
   * surface generations.
   */
  readonly generationId: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly lastAccessedAt: number;
  readonly metadata?: Readonly<Record<string, unknown>> | undefined;
}

export interface SurfaceStoreConfig {
  /**
   * Soft cap on retained surfaces. When the store is full, `create()` returns
   * `RESOURCE_EXHAUSTED` rather than silently evicting an unrelated surface.
   * Operators must explicitly DELETE surfaces (or raise the cap) to make room.
   */
  readonly maxSurfaces: number;
}

/**
 * Pluggable surface persistence. Default in-memory implementation provided.
 * Operations return `T | Promise<T>` so durable backends can plug in.
 *
 * Ownership is enforced inside the store on mutations (`update`, `delete`):
 * passing `expectedOwnerId` makes the backend perform an atomic owner check
 * alongside the hash precondition, closing the TOCTOU window that would
 * otherwise exist between a route-layer ownership read and the mutation.
 *
 * Owner-mismatch returns the `PERMISSION` error code; not-found returns
 * `NOT_FOUND`. Routes should map both to HTTP 404 to avoid leaking existence.
 */
export interface SurfaceStore {
  readonly get: (id: string) => Result<SurfaceEntry> | Promise<Result<SurfaceEntry>>;
  readonly create: (
    id: string,
    content: string,
    options?: {
      readonly ownerId?: string;
      readonly metadata?: Readonly<Record<string, unknown>>;
    },
  ) => Result<SurfaceEntry> | Promise<Result<SurfaceEntry>>;
  /**
   * Conditional update. When `expectedOwnerId` is provided, the backend MUST
   * verify the surface's `ownerId` equals it and reject with `PERMISSION` if
   * not — atomically with the hash check. Implementations that ignore this
   * argument silently break tenant isolation under concurrency.
   */
  readonly update: (
    id: string,
    content: string,
    expectedHash: string | undefined,
    expectedOwnerId?: string,
  ) => Result<SurfaceEntry> | Promise<Result<SurfaceEntry>>;
  /**
   * Conditional delete. When `expectedOwnerId` is provided, the backend MUST
   * verify ownership atomically and reject with `PERMISSION` on mismatch.
   */
  readonly delete: (
    id: string,
    expectedOwnerId?: string,
  ) => Result<boolean> | Promise<Result<boolean>>;
  readonly has: (id: string) => Result<boolean> | Promise<Result<boolean>>;
  readonly size: () => number | Promise<number>;
}

// ---------------------------------------------------------------------------
// SSE
// ---------------------------------------------------------------------------

export interface SseEvent {
  /** Monotonic event ID. Replay from Last-Event-ID is not supported; reconnections are live-only. */
  readonly id: string;
  /** Event type, e.g. "updated" | "deleted". */
  readonly event: string;
  /** JSON payload string. */
  readonly data: string;
}

/**
 * Callback that receives raw SSE bytes.
 * Returns false if the subscriber is dead (connection closed).
 */
export type SseSubscriber = (data: Uint8Array) => boolean;

export interface CanvasSseManager {
  /**
   * Register a subscriber for a surface's event stream.
   * Returns an unsubscribe function on success.
   * Fails with RATE_LIMIT if per-surface or global limit reached.
   */
  readonly subscribe: (surfaceId: string, subscriber: SseSubscriber) => Result<() => void>;
  /** Fan out an event to all subscribers for a surface. */
  readonly publish: (surfaceId: string, event: SseEvent) => void;
  /** Send "deleted" event and remove all subscribers for a surface. */
  readonly close: (surfaceId: string) => void;
  /** Stop keep-alive timer and clear all subscribers. */
  readonly dispose: () => void;
  /** Get the next monotonic event ID for a surface. */
  readonly nextEventId: (surfaceId: string) => string;
  readonly subscriberCount: (surfaceId: string) => number;
  readonly totalSubscribers: () => number;
}

export interface CanvasSseConfig {
  /** Max subscribers per surface. Default: 100. */
  readonly maxSubscribersPerSurface: number;
  /** Max total subscribers across all surfaces. Default: 10_000. */
  readonly maxTotalSubscribers: number;
  /** Keep-alive interval in ms. Default: 15_000. */
  readonly keepAliveIntervalMs: number;
}

// ---------------------------------------------------------------------------
// HTTP server / routes
// ---------------------------------------------------------------------------

export interface CanvasRouteConfig {
  /** URL path prefix. Default: "/gateway/canvas". */
  readonly pathPrefix: string;
  /** Maximum request body size in bytes. Default: 1_048_576 (1MB). */
  readonly maxBodyBytes: number;
}

export interface CanvasServer {
  readonly start: () => Promise<void>;
  readonly stop: () => void;
  readonly port: () => number;
}

export type CanvasAuthenticator = (request: Request) => Promise<Result<CanvasAuthResult>>;

export interface CanvasAuthResult {
  readonly agentId: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// Top-level config
// ---------------------------------------------------------------------------

export interface CanvasConfig {
  /** Port for canvas HTTP server. */
  readonly port: number;
  /** URL path prefix for canvas endpoints. Default: "/gateway/canvas". */
  readonly pathPrefix?: string;
  /** Maximum canvas request body size in bytes. Default: 1_048_576 (1MB). */
  readonly maxBodyBytes?: number;
  /** Maximum number of stored surfaces. Default: 10_000. */
  readonly maxSurfaces?: number;
  /** Maximum SSE subscribers per surface. Default: 100. */
  readonly maxSsePerSurface?: number;
  /** Maximum total SSE subscribers across all surfaces. Default: 10_000. */
  readonly maxSseTotal?: number;
  /** SSE keep-alive interval in ms. Default: 15_000. */
  readonly sseKeepAliveMs?: number;
}

export interface CanvasWiring {
  readonly server: CanvasServer;
  readonly sse: CanvasSseManager;
  readonly store: SurfaceStore;
}
