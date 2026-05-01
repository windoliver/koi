/**
 * HTTP route handler for canvas surface CRUD + SSE streaming.
 *
 * All routes require authentication. Surfaces are tenant-scoped — a surface
 * is private to the agent that created it (`ownerId`); non-owner access on any
 * route returns 404 (not 403) so existence is not leaked.
 *
 * Routes:
 *   POST   {prefix}/{surfaceId}         Create (stamps ownerId from auth)
 *   GET    {prefix}/{surfaceId}         Read (owner-only, supports If-None-Match)
 *   PATCH  {prefix}/{surfaceId}         Update (owner-only, supports If-Match CAS)
 *   DELETE {prefix}/{surfaceId}         Delete (owner-only)
 *   GET    {prefix}/{surfaceId}/events  SSE stream (owner-only)
 */

import {
  type DispatchDeps,
  type SurfaceMethodHandler,
  dispatchRequest,
} from "./canvas-dispatch.js";
import {
  type HandshakeBudget,
  authFailureResponse,
  isRecord,
  requireAuth,
  safeStoreCall,
  sseKey,
  transientStoreFailureResponse,
} from "./canvas-shared.js";
import { surfaceEtag } from "./canvas-store.js";
import { jsonResponse, parseJsonBody } from "./http-helpers.js";
import type {
  CanvasAuthenticator,
  CanvasRouteConfig,
  CanvasServer,
  CanvasSseManager,
  SseEvent,
  SurfaceStore,
} from "./types.js";

const DEFAULT_CANVAS_ROUTE_CONFIG: CanvasRouteConfig = {
  pathPrefix: "/gateway/canvas",
  maxBodyBytes: 1_048_576,
} as const;

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function handlePost(
  request: Request,
  surfaceId: string,
  store: SurfaceStore,
  config: CanvasRouteConfig,
  authenticator: CanvasAuthenticator,
): Promise<Response> {
  const auth = await requireAuth(request, authenticator);
  if (!auth.ok) return authFailureResponse(auth.error);

  const bodyResult = await parseJsonBody(request, config.maxBodyBytes);
  if (!bodyResult.ok) {
    return jsonResponse(bodyResult.status, { ok: false, error: bodyResult.message });
  }

  const parsed = bodyResult.parsed;
  if (!isRecord(parsed) || typeof parsed.content !== "string") {
    return jsonResponse(400, { ok: false, error: "Body must include a string 'content' field" });
  }
  const content: string = parsed.content;
  const metadata = isRecord(parsed.metadata) ? parsed.metadata : undefined;

  const safe = await safeStoreCall(
    () =>
      store.create(surfaceId, content, {
        ownerId: auth.value.agentId,
        ...(metadata !== undefined ? { metadata } : {}),
      }),
    `POST ${surfaceId}`,
  );
  if (!safe.ok) return safe.response;
  const result = safe.value;
  if (!result.ok) {
    if (result.error.code === "PERMISSION") {
      return jsonResponse(404, { ok: false, error: "Surface not found" });
    }
    if (result.error.code === "CONFLICT") {
      return jsonResponse(409, { ok: false, error: result.error.message });
    }
    if (result.error.code === "RESOURCE_EXHAUSTED") {
      return new Response(JSON.stringify({ ok: false, error: result.error.message }), {
        status: 503,
        headers: {
          "Content-Type": "application/json",
          "Retry-After": "30",
          "Cache-Control": "private, no-store",
          Vary: "Authorization",
        },
      });
    }
    const transient = transientStoreFailureResponse(result.error, `POST ${surfaceId}`);
    if (transient !== undefined) return transient;
    return jsonResponse(500, { ok: false, error: "Internal error" });
  }

  return new Response(JSON.stringify({ ok: true, surfaceId }), {
    status: 201,
    headers: {
      "Content-Type": "application/json",
      ETag: `"${surfaceEtag(result.value)}"`,
      Location: `${config.pathPrefix}/${surfaceId}`,
      "Cache-Control": "private, no-store",
      Vary: "Authorization",
    },
  });
}

async function handleGet(
  request: Request,
  surfaceId: string,
  store: SurfaceStore,
  authenticator: CanvasAuthenticator,
): Promise<Response> {
  const auth = await requireAuth(request, authenticator);
  if (!auth.ok) return authFailureResponse(auth.error);

  const safe = await safeStoreCall(
    () => store.get(surfaceId, auth.value.agentId),
    `GET ${surfaceId}`,
  );
  if (!safe.ok) return safe.response;
  const result = safe.value;
  if (!result.ok) {
    const transient = transientStoreFailureResponse(result.error, `GET ${surfaceId}`);
    if (transient !== undefined) return transient;
    return jsonResponse(404, { ok: false, error: "Surface not found" });
  }
  if (result.value.ownerId !== auth.value.agentId) {
    return jsonResponse(404, { ok: false, error: "Surface not found" });
  }

  const etag = `"${surfaceEtag(result.value)}"`;
  const privateHeaders = {
    "Cache-Control": "private, no-store",
    Vary: "Authorization",
  };
  const ifNoneMatch = request.headers.get("If-None-Match");
  if (ifNoneMatch === etag) {
    return new Response(null, { status: 304, headers: { ETag: etag, ...privateHeaders } });
  }
  return new Response(
    JSON.stringify({
      ok: true,
      surface: {
        surfaceId: result.value.surfaceId,
        content: result.value.content,
        createdAt: result.value.createdAt,
        updatedAt: result.value.updatedAt,
        ...(result.value.metadata !== undefined ? { metadata: result.value.metadata } : {}),
      },
    }),
    { status: 200, headers: { "Content-Type": "application/json", ETag: etag, ...privateHeaders } },
  );
}

async function handlePatch(
  request: Request,
  surfaceId: string,
  store: SurfaceStore,
  sse: CanvasSseManager,
  config: CanvasRouteConfig,
  authenticator: CanvasAuthenticator,
): Promise<Response> {
  const auth = await requireAuth(request, authenticator);
  if (!auth.ok) return authFailureResponse(auth.error);

  const bodyResult = await parseJsonBody(request, config.maxBodyBytes);
  if (!bodyResult.ok) {
    return jsonResponse(bodyResult.status, { ok: false, error: bodyResult.message });
  }
  const parsed = bodyResult.parsed;
  if (!isRecord(parsed) || typeof parsed.content !== "string") {
    return jsonResponse(400, { ok: false, error: "Body must include a string 'content' field" });
  }

  const ifMatch = request.headers.get("If-Match");
  if (ifMatch === null) {
    return jsonResponse(428, {
      ok: false,
      error: "If-Match header is required (use the surface's current ETag)",
    });
  }
  const expectedEtag = ifMatch.replace(/^"|"$/g, "");
  const updateContent: string = parsed.content;
  const safe = await safeStoreCall(
    () => store.update(surfaceId, updateContent, expectedEtag, auth.value.agentId),
    `PATCH ${surfaceId}`,
  );
  if (!safe.ok) return safe.response;
  const result = safe.value;
  if (!result.ok) {
    if (result.error.code === "NOT_FOUND" || result.error.code === "PERMISSION") {
      return jsonResponse(404, { ok: false, error: "Surface not found" });
    }
    if (result.error.code === "CONFLICT") {
      return jsonResponse(412, { ok: false, error: "Precondition failed: content hash mismatch" });
    }
    const transient = transientStoreFailureResponse(result.error, `PATCH ${surfaceId}`);
    if (transient !== undefined) return transient;
    return jsonResponse(500, { ok: false, error: "Internal error" });
  }

  const streamKey = sseKey(auth.value.agentId, surfaceId);
  const sseEvent: SseEvent = {
    id: sse.nextEventId(streamKey),
    event: "updated",
    data: JSON.stringify({ surfaceId, content: parsed.content }),
  };
  sse.publish(streamKey, sseEvent);

  return new Response(JSON.stringify({ ok: true, surfaceId }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      ETag: `"${surfaceEtag(result.value)}"`,
      "Cache-Control": "private, no-store",
      Vary: "Authorization",
    },
  });
}

async function handleDelete(
  request: Request,
  surfaceId: string,
  store: SurfaceStore,
  sse: CanvasSseManager,
  authenticator: CanvasAuthenticator,
): Promise<Response> {
  const auth = await requireAuth(request, authenticator);
  if (!auth.ok) return authFailureResponse(auth.error);

  const ifMatch = request.headers.get("If-Match");
  if (ifMatch === null) {
    return jsonResponse(428, {
      ok: false,
      error: "If-Match header is required (use the surface's current ETag)",
    });
  }
  const expectedEtag = ifMatch.replace(/^"|"$/g, "");
  const safe = await safeStoreCall(
    () => store.delete(surfaceId, auth.value.agentId, expectedEtag),
    `DELETE ${surfaceId}`,
  );
  if (!safe.ok) return safe.response;
  const result = safe.value;
  if (!result.ok) {
    if (result.error.code === "PERMISSION") {
      return jsonResponse(404, { ok: false, error: "Surface not found" });
    }
    if (result.error.code === "CONFLICT") {
      return jsonResponse(412, { ok: false, error: "Precondition failed: content hash mismatch" });
    }
    const transient = transientStoreFailureResponse(result.error, `DELETE ${surfaceId}`);
    if (transient !== undefined) return transient;
    return jsonResponse(500, { ok: false, error: "Internal error" });
  }
  if (!result.value) {
    return jsonResponse(404, { ok: false, error: "Surface not found" });
  }

  const deleteStreamKey = sseKey(auth.value.agentId, surfaceId);
  sse.publish(deleteStreamKey, {
    id: sse.nextEventId(deleteStreamKey),
    event: "deleted",
    data: JSON.stringify({ surfaceId }),
  });
  sse.close(deleteStreamKey);
  return new Response(null, {
    status: 204,
    headers: { "Cache-Control": "private, no-store", Vary: "Authorization" },
  });
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

const dispatchSurfaceMethod: SurfaceMethodHandler = (request, surfaceId, deps) => {
  switch (request.method) {
    case "POST":
      return handlePost(request, surfaceId, deps.store, deps.routeConfig, deps.authenticator);
    case "GET":
      return handleGet(request, surfaceId, deps.store, deps.authenticator);
    case "PATCH":
      return handlePatch(
        request,
        surfaceId,
        deps.store,
        deps.sse,
        deps.routeConfig,
        deps.authenticator,
      );
    case "DELETE":
      return handleDelete(request, surfaceId, deps.store, deps.sse, deps.authenticator);
    default:
      return Promise.resolve(jsonResponse(405, { ok: false, error: "Method not allowed" }));
  }
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createCanvasServer(
  config: Partial<CanvasRouteConfig> & { readonly port: number },
  store: SurfaceStore,
  sse: CanvasSseManager,
  authenticator: CanvasAuthenticator,
): CanvasServer {
  if (typeof authenticator !== "function") {
    throw new Error(
      "createCanvasServer: authenticator is required. Canvas surfaces are tenant-scoped " +
        "and cannot run in single-tenant/no-auth mode.",
    );
  }
  // let: server lifecycle — assigned in start(), cleared in stop()
  let server: ReturnType<typeof Bun.serve> | undefined;
  // let: resolved after Bun.serve() picks an ephemeral port (port: 0)
  let resolvedPort: number = config.port;
  // Per-server SSE handshake byte budget. Scoped per-server so multiple
  // canvas instances in the same process do not contend on a shared counter.
  const handshakeBudget: HandshakeBudget = { bytes: 0 };

  const routeConfig: CanvasRouteConfig = {
    pathPrefix: config.pathPrefix ?? DEFAULT_CANVAS_ROUTE_CONFIG.pathPrefix,
    maxBodyBytes: config.maxBodyBytes ?? DEFAULT_CANVAS_ROUTE_CONFIG.maxBodyBytes,
  };
  const prefix = routeConfig.pathPrefix.endsWith("/")
    ? routeConfig.pathPrefix.slice(0, -1)
    : routeConfig.pathPrefix;
  if (prefix === "") {
    throw new Error(
      "createCanvasServer: pathPrefix cannot be '/' or empty. " +
        "Use a specific path like '/gateway/canvas' to avoid shadowing every route.",
    );
  }
  const deps: DispatchDeps = {
    store,
    sse,
    routeConfig,
    authenticator,
    handshakeBudget,
    prefix,
  };

  return {
    async start(): Promise<void> {
      // Idempotent / fail-fast: a second start() without an intervening
      // stop() would orphan the existing listener — its handle would be
      // overwritten and unreachable.
      if (server !== undefined) {
        throw new Error(
          "createCanvasServer: server is already running; call stop() before start() again",
        );
      }
      server = Bun.serve({
        port: config.port,
        fetch: (request: Request): Promise<Response> =>
          dispatchRequest(request, deps, dispatchSurfaceMethod),
      });
      resolvedPort = server.port ?? config.port;
    },
    stop(): void {
      server?.stop(true);
      server = undefined;
    },
    port(): number {
      return resolvedPort;
    },
  };
}
