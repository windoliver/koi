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

import type { Result } from "@koi/core";

import { surfaceEtag } from "./canvas-store.js";
import { jsonResponse, matchPath, parseJsonBody } from "./http-helpers.js";
import type {
  CanvasAuthenticator,
  CanvasAuthResult,
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
// Auth
// ---------------------------------------------------------------------------

/**
 * Distinguish "the caller is unauthorized" from "the auth backend failed."
 * - `unauthorized` → 401 (caller must fix credentials)
 * - `unavailable`  → 503 + Retry-After (backend outage; safe to retry)
 */
type AuthFailure =
  | { readonly kind: "unauthorized" }
  | { readonly kind: "unavailable"; readonly message: string };

async function requireAuth(
  request: Request,
  authenticator: CanvasAuthenticator | undefined,
): Promise<Result<CanvasAuthResult, AuthFailure>> {
  if (authenticator === undefined) {
    return { ok: false, error: { kind: "unauthorized" } };
  }
  // let: holds the authenticator's result; reassigned in the catch path below.
  let result: Awaited<ReturnType<CanvasAuthenticator>>;
  try {
    result = await authenticator(request);
  } catch (cause: unknown) {
    return {
      ok: false,
      error: {
        kind: "unavailable",
        message: cause instanceof Error ? cause.message : "Auth backend threw",
      },
    };
  }
  if (result.ok) return { ok: true, value: result.value };
  // Retryable error codes from the authenticator indicate backend trouble,
  // not caller misauthentication. Surface these as 503 so clients/LBs/metrics
  // do not mistake transient outages for permanent denials.
  const code = result.error.code;
  if (
    code === "EXTERNAL" ||
    code === "TIMEOUT" ||
    code === "UNAVAILABLE" ||
    code === "RESOURCE_EXHAUSTED" ||
    code === "RATE_LIMIT" ||
    result.error.retryable === true
  ) {
    return { ok: false, error: { kind: "unavailable", message: result.error.message } };
  }
  return { ok: false, error: { kind: "unauthorized" } };
}

function authFailureResponse(failure: AuthFailure): Response {
  if (failure.kind === "unavailable") {
    // Generic client-facing message — never echo backend exception text.
    // The detailed `failure.message` is intentionally not surfaced; operators
    // should consult server-side logs (added via the host application's
    // logging middleware) for correlation.
    return new Response(JSON.stringify({ ok: false, error: "Auth backend unavailable" }), {
      status: 503,
      headers: { "Content-Type": "application/json", "Retry-After": "5" },
    });
  }
  return jsonResponse(401, { ok: false, error: "Unauthorized" });
}

/**
 * Bounded 503 for store backend faults. Durable backends may reject store
 * calls (network errors, pool exhaustion, etc.); wrap every `await store.*`
 * with this helper so a thrown promise becomes a retryable response instead
 * of an opaque 500 with no `Retry-After`.
 */
function storeUnavailableResponse(): Response {
  return new Response(JSON.stringify({ ok: false, error: "Surface store unavailable" }), {
    status: 503,
    headers: { "Content-Type": "application/json", "Retry-After": "5" },
  });
}

async function safeStoreCall<T>(
  call: () => Promise<T> | T,
): Promise<{ ok: true; value: T } | { ok: false; response: Response }> {
  try {
    return { ok: true, value: await call() };
  } catch {
    return { ok: false, response: storeUnavailableResponse() };
  }
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function handlePost(
  request: Request,
  surfaceId: string,
  store: SurfaceStore,
  config: CanvasRouteConfig,
  authenticator: CanvasAuthenticator | undefined,
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

  const safe = await safeStoreCall(() =>
    store.create(surfaceId, content, {
      ownerId: auth.value.agentId,
      ...(metadata !== undefined ? { metadata } : {}),
    }),
  );
  if (!safe.ok) return safe.response;
  const result = safe.value;
  if (!result.ok) {
    // Cross-owner collision: store atomically returned PERMISSION so we
    // don't leak existence to non-owners. Self-collision: store returned
    // CONFLICT.
    if (result.error.code === "PERMISSION") {
      return jsonResponse(404, { ok: false, error: "Surface not found" });
    }
    if (result.error.code === "CONFLICT") {
      return jsonResponse(409, { ok: false, error: result.error.message });
    }
    if (result.error.code === "RESOURCE_EXHAUSTED") {
      return new Response(JSON.stringify({ ok: false, error: result.error.message }), {
        status: 503,
        headers: { "Content-Type": "application/json", "Retry-After": "30" },
      });
    }
    return jsonResponse(500, { ok: false, error: "Internal error" });
  }

  return new Response(JSON.stringify({ ok: true, surfaceId }), {
    status: 201,
    headers: {
      "Content-Type": "application/json",
      ETag: `"${surfaceEtag(result.value)}"`,
      Location: `${config.pathPrefix}/${surfaceId}`,
    },
  });
}

async function handleGet(
  request: Request,
  surfaceId: string,
  store: SurfaceStore,
  authenticator: CanvasAuthenticator | undefined,
): Promise<Response> {
  // Reads enforce the same auth+ownership boundary as writes. A surface is
  // private to the agent that created it; non-owners get 404 (not 403) so
  // existence is not leaked.
  const auth = await requireAuth(request, authenticator);
  if (!auth.ok) return authFailureResponse(auth.error);

  const safe = await safeStoreCall(() => store.get(surfaceId));
  if (!safe.ok) return safe.response;
  const result = safe.value;
  if (!result.ok) {
    return jsonResponse(404, { ok: false, error: "Surface not found" });
  }
  // Fail-closed: when auth is enabled, a surface without an `ownerId`
  // (legacy data, unmigrated backend row, etc.) is unreachable. Any
  // mismatch — including undefined — denies the read.
  if (result.value.ownerId !== auth.value.agentId) {
    return jsonResponse(404, { ok: false, error: "Surface not found" });
  }

  const etag = `"${surfaceEtag(result.value)}"`;
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
  if (!auth.ok) return authFailureResponse(auth.error);

  const bodyResult = await parseJsonBody(request, config.maxBodyBytes);
  if (!bodyResult.ok) {
    return jsonResponse(bodyResult.status, { ok: false, error: bodyResult.message });
  }

  const parsed = bodyResult.parsed;
  if (!isRecord(parsed) || typeof parsed.content !== "string") {
    return jsonResponse(400, { ok: false, error: "Body must include a string 'content' field" });
  }

  // If-Match is mandatory: it fences each PATCH against a specific surface
  // generation/content snapshot. Without it, a delayed retry from a previous
  // generation could silently mutate a surface that was deleted and recreated.
  // 428 Precondition Required is the precise status for this.
  const ifMatch = request.headers.get("If-Match");
  if (ifMatch === null) {
    return jsonResponse(428, {
      ok: false,
      error: "If-Match header is required (use the surface's current ETag)",
    });
  }
  const expectedEtag = ifMatch.replace(/^"|"$/g, "");

  // Atomic ownership + hash precondition inside the store. Avoids the TOCTOU
  // window of a separate get-then-update on async backends. Map PERMISSION
  // (owner mismatch) to 404 to avoid leaking existence to non-owners.
  const updateContent: string = parsed.content;
  const safe = await safeStoreCall(() =>
    store.update(surfaceId, updateContent, expectedEtag, auth.value.agentId),
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
    return jsonResponse(500, { ok: false, error: "Internal error" });
  }

  const sseEvent: SseEvent = {
    id: sse.nextEventId(surfaceId),
    event: "updated",
    data: JSON.stringify({ surfaceId, content: parsed.content }),
  };
  sse.publish(surfaceId, sseEvent);

  const etag = `"${surfaceEtag(result.value)}"`;
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
  if (!auth.ok) return authFailureResponse(auth.error);

  // If-Match is mandatory on DELETE for the same reason it's required on
  // PATCH: a stale/replayed unconditional DELETE could wipe a surface that
  // was recreated under the same surfaceId.
  const ifMatch = request.headers.get("If-Match");
  if (ifMatch === null) {
    return jsonResponse(428, {
      ok: false,
      error: "If-Match header is required (use the surface's current ETag)",
    });
  }
  const expectedEtag = ifMatch.replace(/^"|"$/g, "");

  // Atomic ownership + generation fence inside the store.
  const safe = await safeStoreCall(() => store.delete(surfaceId, auth.value.agentId, expectedEtag));
  if (!safe.ok) return safe.response;
  const result = safe.value;
  if (!result.ok) {
    if (result.error.code === "PERMISSION") {
      return jsonResponse(404, { ok: false, error: "Surface not found" });
    }
    if (result.error.code === "CONFLICT") {
      return jsonResponse(412, { ok: false, error: "Precondition failed: content hash mismatch" });
    }
    return jsonResponse(500, { ok: false, error: "Internal error" });
  }
  if (!result.value) {
    return jsonResponse(404, { ok: false, error: "Surface not found" });
  }

  sse.close(surfaceId);
  return new Response(null, { status: 204 });
}

async function handleSseSubscribe(
  request: Request,
  surfaceId: string,
  store: SurfaceStore,
  sse: CanvasSseManager,
  authenticator: CanvasAuthenticator | undefined,
): Promise<Response> {
  // Live subscriptions enforce the same auth+ownership boundary as reads
  // and writes — a non-owner cannot tail another tenant's update stream.
  const auth = await requireAuth(request, authenticator);
  if (!auth.ok) return authFailureResponse(auth.error);

  // Capture the surface's generationId at admission time. The post-admit
  // recheck below verifies the same generation is still in place, so a
  // delete-then-recreate (even by the same owner) cannot splice a new
  // surface instance into this stream.
  const initialSafe = await safeStoreCall(() => store.get(surfaceId));
  if (!initialSafe.ok) return initialSafe.response;
  const initial = initialSafe.value;
  if (!initial.ok || initial.value.ownerId !== auth.value.agentId) {
    return jsonResponse(404, { ok: false, error: "Surface not found" });
  }
  const expectedGeneration = initial.value.generationId;

  // Pre-admit: reserve a subscriber slot. While the route still awaits the
  // post-admit recheck, the callback may receive `publish()` or keep-alive
  // ticks before the ReadableStream's controller is bound — we buffer those
  // bytes and replay them when `start()` fires, instead of returning false
  // (which the SSE manager treats as "dead" and reaps, silently dropping
  // a successful 200 stream).
  // let: bound inside the ReadableStream.start callback below
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | undefined;
  const pendingChunks: Uint8Array[] = [];
  // Cap the pre-start buffer so a hot publisher cannot exhaust memory if
  // the recheck is slow on a durable backend.
  const PENDING_CAP = 64;
  // let: set to true if the pre-start buffer overflowed, signaling that the
  // SSE manager reaped this subscriber. We must fail the handshake instead
  // of returning 200 on a zombie stream that will never see future events.
  let preStartOverflow = false;
  const subscribeResult = sse.subscribe(surfaceId, (data) => {
    if (controllerRef === undefined) {
      if (pendingChunks.length >= PENDING_CAP) {
        preStartOverflow = true;
        return false;
      }
      pendingChunks.push(data);
      return true;
    }
    try {
      controllerRef.enqueue(data);
      return true;
    } catch {
      return false;
    }
  });
  if (!subscribeResult.ok) {
    return new Response(JSON.stringify({ ok: false, error: subscribeResult.error.message }), {
      status: 503,
      headers: { "Content-Type": "application/json", "Retry-After": "5" },
    });
  }
  const unsubscribe = subscribeResult.value;

  // Attach abort cleanup BEFORE the next await. If the client disconnects
  // during the post-admit recheck, the listener (or the synchronous
  // signal.aborted check below) ensures the reserved subscriber slot is
  // released — otherwise dead subscribers can accumulate and starve real
  // ones until a publish/keep-alive reaps them.
  request.signal.addEventListener("abort", () => {
    unsubscribe();
  });
  if (request.signal.aborted) {
    unsubscribe();
    return jsonResponse(499, { ok: false, error: "Client disconnected" });
  }

  // Generation-aware revalidation: if the surface was deleted/recreated
  // (any owner — same or different) between the initial read and this
  // subscribe(), the new instance has a fresh generationId. Reject so the
  // client cannot merge events across surface instances.
  // The store may be a durable backend whose `get()` can reject. If it does,
  // we MUST release the reserved subscriber slot before propagating, or the
  // slot leaks until next publish/keep-alive — repeated backend faults would
  // accumulate dead reservations and starve real subscribers with false
  // 503s. Catch + map to a retryable 503 instead of letting the exception
  // bubble as an opaque 500.
  let recheck: Awaited<ReturnType<typeof store.get>>;
  try {
    recheck = await store.get(surfaceId);
  } catch {
    unsubscribe();
    return new Response(JSON.stringify({ ok: false, error: "Surface store unavailable" }), {
      status: 503,
      headers: { "Content-Type": "application/json", "Retry-After": "5" },
    });
  }
  if (
    !recheck.ok ||
    recheck.value.ownerId !== auth.value.agentId ||
    recheck.value.generationId !== expectedGeneration
  ) {
    unsubscribe();
    return jsonResponse(404, { ok: false, error: "Surface not found" });
  }
  if (request.signal.aborted) {
    unsubscribe();
    return jsonResponse(499, { ok: false, error: "Client disconnected" });
  }
  // Pre-start buffer overflowed during the recheck await: the SSE manager
  // already reaped this subscriber (it returned false). Returning 200 now
  // would hand the client a zombie stream. Fail with a retryable 503.
  if (preStartOverflow) {
    return new Response(
      JSON.stringify({ ok: false, error: "Subscription handshake overrun; retry" }),
      {
        status: 503,
        headers: { "Content-Type": "application/json", "Retry-After": "1" },
      },
    );
  }

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controllerRef = controller;
      controller.enqueue(textEncoder.encode(": connected\n\n"));
      // Replay anything buffered during the subscribe→recheck window.
      for (const chunk of pendingChunks) controller.enqueue(chunk);
      pendingChunks.length = 0;
    },
    cancel() {
      unsubscribe();
    },
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
  if (prefix === "") {
    throw new Error(
      "createCanvasServer: pathPrefix cannot be '/' or empty. " +
        "Use a specific path like '/gateway/canvas' to avoid shadowing every route.",
    );
  }

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

          if (segments.length === 2 && segments[1] === "events") {
            if (request.method !== "GET") {
              return jsonResponse(405, { ok: false, error: "Method not allowed" });
            }
            return handleSseSubscribe(request, surfaceId, store, sse, authenticator);
          }

          if (segments.length !== 1) {
            return jsonResponse(404, { ok: false, error: "Not found" });
          }

          switch (request.method) {
            case "POST":
              return handlePost(request, surfaceId, store, routeConfig, authenticator);
            case "GET":
              return handleGet(request, surfaceId, store, authenticator);
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
