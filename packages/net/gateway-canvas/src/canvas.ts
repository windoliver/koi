/**
 * Canvas factory — wires store + SSE manager + HTTP server from a CanvasConfig.
 */

import { createCanvasServer } from "./canvas-routes.js";
import { createCanvasSseManager } from "./canvas-sse.js";
import { createInMemorySurfaceStore } from "./canvas-store.js";
import type { CanvasAuthenticator, CanvasConfig, CanvasWiring } from "./types.js";

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
