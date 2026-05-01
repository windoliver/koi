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
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly lastAccessedAt: number;
  readonly metadata?: Readonly<Record<string, unknown>> | undefined;
}

export interface SurfaceStoreConfig {
  /** Max surfaces retained — LRU eviction beyond this. */
  readonly maxSurfaces: number;
}

/**
 * Pluggable surface persistence. Default in-memory implementation provided.
 * Operations return `T | Promise<T>` so durable backends can plug in.
 */
export interface SurfaceStore {
  readonly get: (id: string) => Result<SurfaceEntry> | Promise<Result<SurfaceEntry>>;
  readonly create: (
    id: string,
    content: string,
    metadata?: Readonly<Record<string, unknown>>,
  ) => Result<SurfaceEntry> | Promise<Result<SurfaceEntry>>;
  readonly update: (
    id: string,
    content: string,
    expectedHash: string | undefined,
  ) => Result<SurfaceEntry> | Promise<Result<SurfaceEntry>>;
  readonly delete: (id: string) => Result<boolean> | Promise<Result<boolean>>;
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
