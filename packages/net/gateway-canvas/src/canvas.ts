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

  const innerServer = createCanvasServer(
    {
      port: config.port,
      pathPrefix: config.pathPrefix ?? "/gateway/canvas",
      ...(config.maxBodyBytes !== undefined ? { maxBodyBytes: config.maxBodyBytes } : {}),
    },
    store,
    sse,
    authenticator,
  );

  // Lifecycle: `stop()` is TERMINAL — it disposes the SSE manager along with
  // the HTTP listener, so the returned wiring is single-use. Callers that
  // need start→stop→start should call `createCanvas()` again to obtain a
  // fresh wiring; reusing a stopped wiring would accept HTTP connections
  // backed by a disposed (timer-less) SSE manager and silently drop
  // long-lived event streams.
  let stopped = false;
  const server = {
    start: async (): Promise<void> => {
      if (stopped) {
        throw new Error(
          "createCanvas: server.stop() is terminal — call createCanvas() again for a fresh wiring",
        );
      }
      await innerServer.start();
    },
    stop: (): void => {
      if (stopped) return;
      stopped = true;
      innerServer.stop();
      sse.dispose();
    },
    port: innerServer.port,
  };

  return { server, sse, store };
}
