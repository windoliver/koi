/**
 * @koi/gateway-canvas — Canvas surface CRUD + SSE streaming (L2)
 *
 * HTTP server for surface management with real-time updates.
 * Depends only on @koi/core (L0) + @koi/hash (L0u).
 */

export { createCanvas } from "./canvas.js";
export { createCanvasServer } from "./canvas-routes.js";
export { createCanvasSseManager, formatSseEvent } from "./canvas-sse.js";
export { createInMemorySurfaceStore, surfaceEtag } from "./canvas-store.js";
export type {
  CanvasAuthenticator,
  CanvasAuthResult,
  CanvasConfig,
  CanvasRouteConfig,
  CanvasServer,
  CanvasSseConfig,
  CanvasSseManager,
  CanvasWiring,
  SseEvent,
  SseSubscriber,
  SurfaceEntry,
  SurfaceStore,
  SurfaceStoreConfig,
} from "./types.js";
