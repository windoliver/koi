/**
 * Canvas server wiring — creates and configures canvas store, SSE manager,
 * and HTTP server from GatewayConfig.
 *
 * Internal helper used by gateway.ts to keep it under the 800-line limit.
 */

import type { CanvasAuthenticator, CanvasServer } from "./canvas-routes.js";
import { createCanvasServer } from "./canvas-routes.js";
import type { CanvasSseManager } from "./canvas-sse.js";
import { createCanvasSseManager } from "./canvas-sse.js";
import type { SurfaceStore } from "./canvas-store.js";
import { createInMemorySurfaceStore } from "./canvas-store.js";
import type { GatewayConfig } from "./types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CanvasWiring {
  readonly server: CanvasServer;
  readonly sse: CanvasSseManager;
  readonly store: SurfaceStore;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createCanvasWiring(
  config: GatewayConfig,
  authenticator?: CanvasAuthenticator,
): CanvasWiring {
  const canvasPort = config.canvasPort;
  if (canvasPort === undefined) {
    throw new Error("canvasPort must be defined to create canvas wiring");
  }

  const store = createInMemorySurfaceStore(
    config.canvasMaxSurfaces !== undefined ? { maxSurfaces: config.canvasMaxSurfaces } : {},
  );

  const sse = createCanvasSseManager({
    ...(config.canvasMaxSsePerSurface !== undefined
      ? { maxSubscribersPerSurface: config.canvasMaxSsePerSurface }
      : {}),
    ...(config.canvasMaxSseTotal !== undefined
      ? { maxTotalSubscribers: config.canvasMaxSseTotal }
      : {}),
    ...(config.canvasSseKeepAliveMs !== undefined
      ? { keepAliveIntervalMs: config.canvasSseKeepAliveMs }
      : {}),
  });

  const server = createCanvasServer(
    {
      port: canvasPort,
      pathPrefix: config.canvasPath ?? "/gateway/canvas",
      ...(config.canvasMaxBodyBytes !== undefined
        ? { maxBodyBytes: config.canvasMaxBodyBytes }
        : {}),
    },
    store,
    sse,
    authenticator,
  );

  return { server, sse, store };
}
