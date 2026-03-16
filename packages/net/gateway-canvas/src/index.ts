/**
 * @koi/gateway-canvas — Canvas surface CRUD + SSE streaming (Layer 2)
 *
 * Provides HTTP server for surface management with real-time updates.
 * Depends on @koi/core only.
 */

// canvas factory
export type { CanvasConfig, CanvasWiring } from "./canvas.js";
export { createCanvas } from "./canvas.js";

// canvas routes
export type {
  CanvasAuthenticator,
  CanvasAuthResult,
  CanvasRouteConfig,
  CanvasServer,
} from "./canvas-routes.js";
export { createCanvasServer } from "./canvas-routes.js";

// canvas SSE
export type {
  CanvasSseConfig,
  CanvasSseManager,
  SseEvent,
  SseSubscriber,
} from "./canvas-sse.js";
export { createCanvasSseManager, formatSseEvent } from "./canvas-sse.js";

// canvas store
export type {
  SurfaceEntry,
  SurfaceStore,
  SurfaceStoreConfig,
} from "./canvas-store.js";
export { createInMemorySurfaceStore } from "./canvas-store.js";
