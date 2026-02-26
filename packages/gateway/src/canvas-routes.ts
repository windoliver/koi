/**
 * HTTP route handler for canvas surface CRUD + SSE streaming.
 *
 * Routes:
 *   POST   {prefix}/{surfaceId}         Create surface (auth required)
 *   GET    {prefix}/{surfaceId}         Fetch surface (public)
 *   PATCH  {prefix}/{surfaceId}         Update surface (auth required)
 *   DELETE {prefix}/{surfaceId}         Delete surface (auth required)
 *   GET    {prefix}/{surfaceId}/events  SSE stream (public)
 */

import type { KoiError, Result } from "@koi/core";
import type { CanvasSseManager, SseEvent } from "./canvas-sse.js";
import type { SurfaceStore } from "./canvas-store.js";
import { jsonResponse, matchPath, parseJsonBody } from "./http-helpers.js";

// ---------------------------------------------------------------------------
// Types
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

export type CanvasAuthenticator = (request: Request) => Promise<Result<CanvasAuthResult, KoiError>>;

export interface CanvasAuthResult {
  readonly agentId: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

const DEFAULT_CANVAS_ROUTE_CONFIG: CanvasRouteConfig = {
  pathPrefix: "/gateway/canvas",
  maxBodyBytes: 1_048_576,
} as const;

const textEncoder = new TextEncoder();

/** Surface ID: 1-128 alphanumeric chars, hyphens, underscores. */
const SURFACE_ID_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/;

function isValidSurfaceId(id: string): boolean {
  return SURFACE_ID_PATTERN.test(id);
}

/** Type guard: value is a non-null, non-array object usable as Record<string, unknown>. */
function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// Auth helper
// ---------------------------------------------------------------------------

async function requireAuth(
  request: Request,
  authenticator: CanvasAuthenticator | undefined,
): Promise<Result<CanvasAuthResult, "unauthorized">> {
  if (authenticator === undefined) {
    return { ok: false, error: "unauthorized" };
  }
  const result = await authenticator(request);
  if (!result.ok) {
    return { ok: false, error: "unauthorized" };
  }
  return { ok: true, value: result.value };
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

async function handlePost(
  request: Request,
  surfaceId: string,
  store: SurfaceStore,
  config: CanvasRouteConfig,
  authenticator: CanvasAuthenticator | undefined,
): Promise<Response> {
  const auth = await requireAuth(request, authenticator);
  if (!auth.ok) return jsonResponse(401, { ok: false, error: "Unauthorized" });

  const bodyResult = await parseJsonBody(request, config.maxBodyBytes);
  if (!bodyResult.ok) {
    return jsonResponse(bodyResult.status, { ok: false, error: bodyResult.message });
  }

  const parsed = bodyResult.parsed;
  if (!isRecord(parsed) || typeof parsed.content !== "string") {
    return jsonResponse(400, { ok: false, error: "Body must include a string 'content' field" });
  }

  const metadata = isRecord(parsed.metadata) ? parsed.metadata : undefined;

  const result = await store.create(surfaceId, parsed.content, metadata);
  if (!result.ok) {
    if (result.error.code === "CONFLICT") {
      return jsonResponse(409, { ok: false, error: result.error.message });
    }
    return jsonResponse(500, { ok: false, error: "Internal error" });
  }

  return new Response(JSON.stringify({ ok: true, surfaceId }), {
    status: 201,
    headers: {
      "Content-Type": "application/json",
      ETag: `"${result.value.contentHash}"`,
      Location: `${config.pathPrefix}/${surfaceId}`,
    },
  });
}

async function handleGet(
  request: Request,
  surfaceId: string,
  store: SurfaceStore,
): Promise<Response> {
  const result = await store.get(surfaceId);
  if (!result.ok) {
    return jsonResponse(404, { ok: false, error: "Surface not found" });
  }

  const etag = `"${result.value.contentHash}"`;
  const ifNoneMatch = request.headers.get("If-None-Match");
  if (ifNoneMatch === etag) {
    return new Response(null, { status: 304, headers: { ETag: etag } });
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
    {
      status: 200,
      headers: { "Content-Type": "application/json", ETag: etag },
    },
  );
}

async function handlePatch(
  request: Request,
  surfaceId: string,
  store: SurfaceStore,
  sse: CanvasSseManager,
  config: CanvasRouteConfig,
  authenticator: CanvasAuthenticator | undefined,
): Promise<Response> {
  const auth = await requireAuth(request, authenticator);
  if (!auth.ok) return jsonResponse(401, { ok: false, error: "Unauthorized" });

  const bodyResult = await parseJsonBody(request, config.maxBodyBytes);
  if (!bodyResult.ok) {
    return jsonResponse(bodyResult.status, { ok: false, error: bodyResult.message });
  }

  const parsed = bodyResult.parsed;
  if (!isRecord(parsed) || typeof parsed.content !== "string") {
    return jsonResponse(400, { ok: false, error: "Body must include a string 'content' field" });
  }

  // CAS via If-Match header
  const ifMatch = request.headers.get("If-Match");
  const expectedHash = ifMatch !== null ? ifMatch.replace(/^"|"$/g, "") : undefined;

  const result = await store.update(surfaceId, parsed.content, expectedHash);
  if (!result.ok) {
    if (result.error.code === "NOT_FOUND") {
      return jsonResponse(404, { ok: false, error: "Surface not found" });
    }
    if (result.error.code === "CONFLICT") {
      return jsonResponse(412, { ok: false, error: "Precondition failed: content hash mismatch" });
    }
    return jsonResponse(500, { ok: false, error: "Internal error" });
  }

  // Publish SSE update
  const sseEvent: SseEvent = {
    id: sse.nextEventId(surfaceId),
    event: "updated",
    data: JSON.stringify({ surfaceId, content: parsed.content }),
  };
  sse.publish(surfaceId, sseEvent);

  const etag = `"${result.value.contentHash}"`;
  return new Response(JSON.stringify({ ok: true, surfaceId }), {
    status: 200,
    headers: { "Content-Type": "application/json", ETag: etag },
  });
}

async function handleDelete(
  request: Request,
  surfaceId: string,
  store: SurfaceStore,
  sse: CanvasSseManager,
  authenticator: CanvasAuthenticator | undefined,
): Promise<Response> {
  const auth = await requireAuth(request, authenticator);
  if (!auth.ok) return jsonResponse(401, { ok: false, error: "Unauthorized" });

  const result = await store.delete(surfaceId);
  if (!result.ok) {
    return jsonResponse(500, { ok: false, error: "Internal error" });
  }
  if (!result.value) {
    return jsonResponse(404, { ok: false, error: "Surface not found" });
  }

  // Notify SSE subscribers and close their streams
  sse.close(surfaceId);

  return new Response(null, { status: 204 });
}

async function handleSseSubscribe(
  request: Request,
  surfaceId: string,
  store: SurfaceStore,
  sse: CanvasSseManager,
): Promise<Response> {
  const exists = await store.has(surfaceId);
  if (!exists.ok || !exists.value) {
    return jsonResponse(404, { ok: false, error: "Surface not found" });
  }

  // let: assigned inside ReadableStream.start(), read in cancel() and abort handler
  let unsubscribe: (() => void) | undefined;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      // Send initial SSE comment to flush response headers
      controller.enqueue(textEncoder.encode(": connected\n\n"));

      const result = sse.subscribe(surfaceId, (data: Uint8Array) => {
        try {
          controller.enqueue(data);
          return true;
        } catch {
          return false;
        }
      });
      if (!result.ok) {
        // Capacity exceeded — send error event and close
        controller.enqueue(
          textEncoder.encode(
            `event: error\ndata: ${JSON.stringify({ error: result.error.message })}\n\n`,
          ),
        );
        controller.close();
        return;
      }
      unsubscribe = result.value;
    },
    cancel() {
      unsubscribe?.();
    },
  });

  // Unsubscribe when client disconnects
  request.signal.addEventListener("abort", () => {
    unsubscribe?.();
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createCanvasServer(
  config: Partial<CanvasRouteConfig> & { readonly port: number },
  store: SurfaceStore,
  sse: CanvasSseManager,
  authenticator?: CanvasAuthenticator,
): CanvasServer {
  // let: server lifecycle — assigned in start(), cleared in stop()
  let server: ReturnType<typeof Bun.serve> | undefined;
  // let: resolved after Bun.serve() picks an ephemeral port (port: 0)
  let resolvedPort: number = config.port;

  const routeConfig: CanvasRouteConfig = {
    pathPrefix: config.pathPrefix ?? DEFAULT_CANVAS_ROUTE_CONFIG.pathPrefix,
    maxBodyBytes: config.maxBodyBytes ?? DEFAULT_CANVAS_ROUTE_CONFIG.maxBodyBytes,
  };

  const prefix = routeConfig.pathPrefix.endsWith("/")
    ? routeConfig.pathPrefix.slice(0, -1)
    : routeConfig.pathPrefix;

  return {
    async start(): Promise<void> {
      server = Bun.serve({
        port: config.port,
        async fetch(request: Request): Promise<Response> {
          const url = new URL(request.url);
          const pathResult = matchPath(url.pathname, prefix);
          if (!pathResult.match) {
            return jsonResponse(404, { ok: false, error: "Not found" });
          }

          const segments = pathResult.segments;
          if (segments.length === 0) {
            return jsonResponse(404, { ok: false, error: "Surface ID required" });
          }

          const firstSegment = segments[0];
          if (firstSegment === undefined) {
            return jsonResponse(404, { ok: false, error: "Surface ID required" });
          }
          const surfaceId = firstSegment;

          if (!isValidSurfaceId(surfaceId)) {
            return jsonResponse(400, { ok: false, error: "Invalid surface ID" });
          }

          // SSE endpoint: {prefix}/{surfaceId}/events
          if (segments.length === 2 && segments[1] === "events") {
            if (request.method !== "GET") {
              return jsonResponse(405, { ok: false, error: "Method not allowed" });
            }
            return handleSseSubscribe(request, surfaceId, store, sse);
          }

          // CRUD routes: {prefix}/{surfaceId}
          if (segments.length !== 1) {
            return jsonResponse(404, { ok: false, error: "Not found" });
          }

          switch (request.method) {
            case "POST":
              return handlePost(request, surfaceId, store, routeConfig, authenticator);
            case "GET":
              return handleGet(request, surfaceId, store);
            case "PATCH":
              return handlePatch(request, surfaceId, store, sse, routeConfig, authenticator);
            case "DELETE":
              return handleDelete(request, surfaceId, store, sse, authenticator);
            default:
              return jsonResponse(405, { ok: false, error: "Method not allowed" });
          }
        },
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
