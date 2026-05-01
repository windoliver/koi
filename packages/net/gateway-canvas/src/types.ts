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
  /** Hex content hash. NOT the ETag — see {@link SurfaceEntry.etag}. */
  readonly contentHash: string;
  /**
   * Epoch- generation- and version-aware precondition token:
   * `${instanceEpoch}-${generationId}-${version}-${contentHash}`.
   * This is the value the HTTP layer emits as ETag and compares against
   * `If-Match` / `If-None-Match`. Custom durable backends MUST emit and
   * validate this exact value, not raw `contentHash` — comparing only the
   * hash silently reintroduces the delete+recreate-with-identical-content
   * vulnerability the generation fence is designed to close.
   */
  readonly etag: string;
  /**
   * Per-store-instance random epoch. Without this, a process restart resets
   * the in-memory `generationCounter` to 0 and makes new etags collide with
   * old ones (`1-1-<hash>` after restart matches `1-1-<hash>` before restart).
   * A delayed PATCH/DELETE retry carrying a pre-restart `If-Match` token
   * could then succeed against a different post-restart surface generation.
   * Durable backends should persist this value across restarts; volatile
   * backends generate a fresh random value at creation so cross-restart
   * collisions are computationally negligible.
   *
   * REQUIRED on the type so the cross-restart fence cannot be silently
   * undermined by a backend that omits the field. Pluggable durable
   * backends MUST populate this on every row before serving it through
   * the HTTP API; until they do, conditional writes against those rows
   * are unsafe (a delayed pre-restart If-Match can still collide with
   * post-restart state). Operators rolling out a backend that didn't
   * previously emit this field MUST backfill or read-before-write the
   * value as part of the migration — silent legacy fallback was
   * considered and rejected because it leaves the original
   * vulnerability open under exactly the failure mode (process restart)
   * the field is designed to fence.
   */
  readonly instanceEpoch: string;
  /**
   * Per-entry write counter, starts at 1 on `create()` and bumps by 1 on
   * every successful `update()` — including no-op updates where the new
   * content equals the old content. Without this, a no-op PATCH would not
   * advance the etag, leaving stale `If-Match` tokens valid against
   * subsequent writes/deletes.
   */
  readonly version: number;
  /**
   * Authenticated identity that created the surface. Subsequent writes
   * (PATCH/DELETE) must be performed by the same `ownerId`. The HTTP server
   * always stamps this from the authenticator on `create()` (authentication
   * is mandatory at construction); the field is optional on the type only
   * to permit pluggable durable backends that pre-populate rows out of band
   * — such rows are unreachable through the HTTP API by design (fail-closed)
   * and must be migrated by the operator, not surfaced to authenticated
   * callers as orphaned data.
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
   * Global cap across all tenants. When reached, `create()` returns
   * `RESOURCE_EXHAUSTED` (no silent eviction). Should be set high enough
   * that legitimate usage doesn't hit it; the per-tenant quota
   * (`maxSurfacesPerTenant`) is the primary admission control.
   */
  readonly maxSurfaces: number;
  /**
   * Per-tenant quota. Without this, one noisy tenant can consume the
   * entire global pool and force every later tenant onto the
   * `RESOURCE_EXHAUSTED` → 503 path. Default: 1_000.
   */
  readonly maxSurfacesPerTenant: number;
}

/**
 * Pluggable surface persistence. Default in-memory implementation provided.
 * Operations return `T | Promise<T>` so durable backends can plug in.
 *
 * Storage namespace is **tenant-scoped**: keys are `(ownerId, surfaceId)`.
 * Two different agents can independently hold the same `surfaceId` — there
 * is no shared global surfaceId namespace. This prevents cross-tenant
 * squatting (one tenant reserving "home" for everyone) and existence
 * probing (POST returning 201 vs 404 to leak whether another tenant owns
 * an ID).
 *
 * Owner-mismatch (defense-in-depth) returns `PERMISSION`; not-found
 * returns `NOT_FOUND`. Routes map both to HTTP 404.
 */
export interface SurfaceStore {
  readonly get: (
    id: string,
    ownerId?: string,
  ) => Result<SurfaceEntry> | Promise<Result<SurfaceEntry>>;
  /**
   * Create a new surface in the `ownerId` tenant's namespace. Collision
   * (same `(ownerId, id)` pair) returns `CONFLICT`. Cross-tenant collision
   * is impossible by construction.
   */
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
   * not — atomically with the etag check. Implementations that ignore this
   * argument silently break tenant isolation under concurrency.
   *
   * `expectedEtag` MUST be compared against the surface's full
   * generation-aware {@link SurfaceEntry.etag}, not raw `contentHash`.
   * Comparing only the hash re-opens the delete+recreate-with-identical-
   * content vulnerability the generation fence is designed to close.
   */
  readonly update: (
    id: string,
    content: string,
    expectedEtag: string | undefined,
    expectedOwnerId?: string,
  ) => Result<SurfaceEntry> | Promise<Result<SurfaceEntry>>;
  /**
   * Conditional delete. When `expectedOwnerId` is provided, the backend MUST
   * verify ownership atomically and reject with `PERMISSION` on mismatch.
   * When `expectedEtag` is provided, the backend MUST verify the surface's
   * current `etag` (i.e. {@link SurfaceEntry.etag} = generation-aware token,
   * NOT raw `contentHash`) matches and reject with `CONFLICT` on mismatch.
   * Comparing only `contentHash` re-opens the delete+recreate-with-identical-
   * content vulnerability — the generation fence is mandatory for backend
   * conformance.
   */
  readonly delete: (
    id: string,
    expectedOwnerId?: string,
    expectedEtag?: string,
  ) => Result<boolean> | Promise<Result<boolean>>;
  readonly has: (id: string, ownerId?: string) => Result<boolean> | Promise<Result<boolean>>;
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
   *
   * `onClose`, when provided, fires AFTER the subscriber is removed from
   * the registry — including the path where `close(surfaceId)` tears
   * down the bucket. The route layer uses this to terminate the
   * underlying `ReadableStream` so a DELETE'd surface does not leave
   * clients on a zombie HTTP/2 stream that will never receive another
   * event (and never frees its socket/fd).
   */
  readonly subscribe: (
    surfaceId: string,
    subscriber: SseSubscriber,
    onClose?: () => void,
  ) => Result<() => void>;
  /** Fan out an event to all subscribers for a surface. */
  readonly publish: (surfaceId: string, event: SseEvent) => void;
  /**
   * **Teardown only**: drops all subscribers for a surface and clears its
   * event-id counter. Does NOT emit a `deleted` event — callers MUST
   * `publish()` the terminal `deleted` event with the public `surfaceId`
   * BEFORE calling `close()` if they want clients to receive it.
   *
   * Embedding a `deleted` event in `close()` would force the registry key
   * into the wire payload, which leaks tenant-qualified internal keys
   * when the route layer scopes streams by `(ownerId, surfaceId)`.
   */
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
  /** Global cap across all tenants. Default: 10_000. */
  readonly maxSurfaces?: number;
  /**
   * Per-tenant quota — primary admission control under multi-tenant load.
   * Without this, a noisy tenant can fill the global pool and force every
   * later tenant onto the 503 path. Default: 1_000. Should be set so that
   * `maxSurfacesPerTenant ≤ maxSurfaces`.
   */
  readonly maxSurfacesPerTenant?: number;
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
