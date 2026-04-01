/**
 * Canvas factory — creates and configures canvas store, SSE manager,
 * and HTTP server from a CanvasConfig.
 */

import type { CanvasAuthenticator, CanvasServer } from "./canvas-routes.js";
import { createCanvasServer } from "./canvas-routes.js";
import type { CanvasSseManager } from "./canvas-sse.js";
import { createCanvasSseManager } from "./canvas-sse.js";
import type { SurfaceStore } from "./canvas-store.js";
import { createInMemorySurfaceStore } from "./canvas-store.js";

// ---------------------------------------------------------------------------
// Types
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

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createCanvas(
  config: CanvasConfig,
  authenticator?: CanvasAuthenticator,
): CanvasWiring {
  const store = createInMemorySurfaceStore(
    config.maxSurfaces !== undefined ? { maxSurfaces: config.maxSurfaces } : {},
  );

  const sse = createCanvasSseManager({
    ...(config.maxSsePerSurface !== undefined
      ? { maxSubscribersPerSurface: config.maxSsePerSurface }
      : {}),
    ...(config.maxSseTotal !== undefined ? { maxTotalSubscribers: config.maxSseTotal } : {}),
    ...(config.sseKeepAliveMs !== undefined ? { keepAliveIntervalMs: config.sseKeepAliveMs } : {}),
  });

  const server = createCanvasServer(
    {
      port: config.port,
      pathPrefix: config.pathPrefix ?? "/gateway/canvas",
      ...(config.maxBodyBytes !== undefined ? { maxBodyBytes: config.maxBodyBytes } : {}),
    },
    store,
    sse,
    authenticator,
  );

  return { server, sse, store };
}
