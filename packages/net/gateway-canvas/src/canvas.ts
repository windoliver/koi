/**
 * Canvas factory — wires store + SSE manager + HTTP server from a CanvasConfig.
 */

import { createCanvasServer } from "./canvas-routes.js";
import { createCanvasSseManager } from "./canvas-sse.js";
import { createInMemorySurfaceStore } from "./canvas-store.js";
import type {
  CanvasAuthenticator,
  CanvasConfig,
  CanvasSseManager,
  CanvasWiring,
  SurfaceStore,
} from "./types.js";

/**
 * Optional dependency injection for production deployments. The default
 * in-memory store and SSE manager are process-local and ephemeral —
 * suitable for tests and single-instance dev. For multi-instance or
 * restart-sensitive deployments, inject:
 * - `store`: a durable {@link SurfaceStore} (database-backed)
 * - `sse`: a distributed {@link CanvasSseManager} that fans events
 *   across instances (e.g. Redis pub/sub, NATS)
 * Without injection, surfaces are lost on restart and SSE updates do not
 * cross instance boundaries.
 */
export interface CanvasDependencies {
  readonly store?: SurfaceStore;
  readonly sse?: CanvasSseManager;
}

export function createCanvas(
  config: CanvasConfig,
  authenticator: CanvasAuthenticator,
  dependencies: CanvasDependencies = {},
): CanvasWiring {
  const store =
    dependencies.store ??
    createInMemorySurfaceStore({
      ...(config.maxSurfaces !== undefined ? { maxSurfaces: config.maxSurfaces } : {}),
      ...(config.maxSurfacesPerTenant !== undefined
        ? { maxSurfacesPerTenant: config.maxSurfacesPerTenant }
        : {}),
    });

  // Track which dependencies we own so `stop()` only disposes resources
  // it created. Disposing an injected/shared SSE manager (e.g. a Redis-
  // backed distributed bus shared across instances) on instance shutdown
  // would clear global subscriber state and outage every other live
  // server using the same dependency.
  const ownsSse = dependencies.sse === undefined;
  const sse =
    dependencies.sse ??
    createCanvasSseManager({
      ...(config.maxSsePerSurface !== undefined
        ? { maxSubscribersPerSurface: config.maxSsePerSurface }
        : {}),
      ...(config.maxSseTotal !== undefined ? { maxTotalSubscribers: config.maxSseTotal } : {}),
      ...(config.sseKeepAliveMs !== undefined
        ? { keepAliveIntervalMs: config.sseKeepAliveMs }
        : {}),
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
      if (ownsSse) sse.dispose();
    },
    port: innerServer.port,
  };

  return { server, sse, store };
}
