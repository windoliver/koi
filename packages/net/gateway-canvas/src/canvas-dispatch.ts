/**
 * Internal HTTP dispatch — splits URL/method routing out of the route handlers
 * + factory in canvas-routes.ts so each file fits the soft size limit.
 */

import { isValidSurfaceId } from "./canvas-shared.js";
import type { HandshakeBudget } from "./canvas-shared.js";
import { handleSseSubscribe } from "./canvas-sse-route.js";
import { jsonResponse, matchPath } from "./http-helpers.js";
import type {
  CanvasAuthenticator,
  CanvasRouteConfig,
  CanvasSseManager,
  SurfaceStore,
} from "./types.js";

export interface DispatchDeps {
  readonly store: SurfaceStore;
  readonly sse: CanvasSseManager;
  readonly routeConfig: CanvasRouteConfig;
  readonly authenticator: CanvasAuthenticator;
  readonly handshakeBudget: HandshakeBudget;
  readonly prefix: string;
}

export type SurfaceMethodHandler = (
  request: Request,
  surfaceId: string,
  deps: DispatchDeps,
) => Promise<Response>;

export async function dispatchRequest(
  request: Request,
  deps: DispatchDeps,
  methodHandler: SurfaceMethodHandler,
): Promise<Response> {
  const url = new URL(request.url);
  const pathResult = matchPath(url.pathname, deps.prefix);
  if (!pathResult.match) return jsonResponse(404, { ok: false, error: "Not found" });
  const segments = pathResult.segments;
  const firstSegment = segments[0];
  if (firstSegment === undefined) {
    return jsonResponse(404, { ok: false, error: "Surface ID required" });
  }
  const surfaceId = firstSegment;
  if (!isValidSurfaceId(surfaceId)) {
    return jsonResponse(400, { ok: false, error: "Invalid surface ID" });
  }
  if (segments.length === 2 && segments[1] === "events") {
    if (request.method !== "GET") {
      return jsonResponse(405, { ok: false, error: "Method not allowed" });
    }
    return handleSseSubscribe(
      request,
      surfaceId,
      deps.store,
      deps.sse,
      deps.routeConfig,
      deps.authenticator,
      deps.handshakeBudget,
    );
  }
  if (segments.length !== 1) return jsonResponse(404, { ok: false, error: "Not found" });
  return methodHandler(request, surfaceId, deps);
}
