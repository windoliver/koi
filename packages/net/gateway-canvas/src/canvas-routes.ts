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

/**
 * Per-server byte budget for pre-start SSE handshake buffers, summed
 * across every concurrent in-flight subscribe on a single
 * `createCanvasServer()` instance. Without this, a slow authenticator
 * or store recheck could let many handshakes each buffer up to
 * `2 * maxBodyBytes` simultaneously — with default limits that's
 * 10,000 subscribers × 2 MiB = 20 GiB worst case. Cap at 64 MiB per
 * server; handshakes that would exceed it are rejected with 503 before
 * reserving an SSE slot. Scoped per-server (not module-global) so one
 * canvas instance cannot starve unrelated instances in the same process.
 */
const HANDSHAKE_BYTES_CAP_PER_SERVER = 64 * 1024 * 1024;

interface HandshakeBudget {
  bytes: number;
}

/**
 * Compose a tenant-qualified SSE stream key. The CanvasSseManager registry
 * is keyed by raw string, so without this composition two tenants who own
 * surfaces with the same `surfaceId` (legal under the tenant-scoped store
 * namespace) would share one live event stream — a cross-tenant
 * confidentiality breach. Always pass the qualified key to
 * `sse.subscribe/publish/close/nextEventId`.
 */
function sseKey(ownerId: string, surfaceId: string): string {
  return `${ownerId}\x00${surfaceId}`;
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
  authenticator: CanvasAuthenticator,
): Promise<Result<CanvasAuthResult, AuthFailure>> {
  // let: holds the authenticator's result; reassigned in the catch path below.
  let result: Awaited<ReturnType<CanvasAuthenticator>>;
  try {
    result = await authenticator(request);
  } catch (cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    console.error(`[gateway-canvas] authenticator threw: ${detail}`);
    return {
      ok: false,
      error: {
        kind: "unavailable",
        message: cause instanceof Error ? cause.message : "Auth backend threw",
      },
    };
  }
  if (result.ok) {
    // Reject blank/whitespace agentId at the auth boundary. The store
    // distinguishes `undefined` (ownerless) from `""` (empty string), but
    // an authenticator that returns a blank agent would still produce a
    // legal-but-untrustworthy tenant identity. Treat it as unauthorized.
    if (result.value.agentId.trim() === "") {
      return { ok: false, error: { kind: "unauthorized" } };
    }
    return { ok: true, value: result.value };
  }
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
      headers: {
        "Content-Type": "application/json",
        "Retry-After": "5",
        "Cache-Control": "private, no-store",
        Vary: "Authorization",
      },
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
    headers: {
      "Content-Type": "application/json",
      "Retry-After": "5",
      "Cache-Control": "private, no-store",
      Vary: "Authorization",
    },
  });
}

async function safeStoreCall<T>(
  call: () => Promise<T> | T,
  context: string,
): Promise<{ ok: true; value: T } | { ok: false; response: Response }> {
  try {
    return { ok: true, value: await call() };
  } catch (cause: unknown) {
    // Log before swallowing into a generic 503: operators need to
    // distinguish dependency outages from code regressions during incident
    // triage. The 503 body itself stays generic so we don't leak backend
    // detail to callers.
    const detail = cause instanceof Error ? cause.message : String(cause);
    console.error(`[gateway-canvas] store backend failed at ${context}: ${detail}`);
    return { ok: false, response: storeUnavailableResponse() };
  }
}

/**
 * Map a structured `Result` error returned by a (durable) SurfaceStore
 * to a transient-503 response when the error code or `retryable` flag
 * indicates a backend problem rather than a client-fault. Returns
 * `undefined` when the error should fall through to route-specific
 * mapping (NOT_FOUND → 404, CONFLICT → 412, PERMISSION → 404, etc.).
 *
 * Without this, a pluggable backend reporting `EXTERNAL` / `TIMEOUT` /
 * `UNAVAILABLE` / `RESOURCE_EXHAUSTED` / `retryable: true` via Result
 * would be misclassified by routes (404 on GET, 500 on PATCH/DELETE),
 * breaking client retry behaviour and incident diagnosis.
 */
function transientStoreFailureResponse(
  error: {
    readonly code: string;
    readonly retryable?: boolean | undefined;
    readonly message: string;
  },
  context: string,
): Response | undefined {
  const code = error.code;
  const isTransient =
    code === "EXTERNAL" ||
    code === "TIMEOUT" ||
    code === "UNAVAILABLE" ||
    code === "RESOURCE_EXHAUSTED" ||
    code === "RATE_LIMIT" ||
    error.retryable === true;
  if (!isTransient) return undefined;
  console.error(
    `[gateway-canvas] store reported transient failure at ${context}: ${code} ${error.message}`,
  );
  return new Response(JSON.stringify({ ok: false, error: "Surface store unavailable" }), {
    status: 503,
    headers: {
      "Content-Type": "application/json",
      "Retry-After": "5",
      "Cache-Control": "private, no-store",
      Vary: "Authorization",
    },
  });
}

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
    // Cross-owner collision: store atomically returned PERMISSION so we
    // don't leak existence to non-owners. Self-collision: store returned
    // CONFLICT.
    if (result.error.code === "PERMISSION") {
      return jsonResponse(404, { ok: false, error: "Surface not found" });
    }
    if (result.error.code === "CONFLICT") {
      return jsonResponse(409, { ok: false, error: result.error.message });
    }
    // POST capacity overflow needs a longer Retry-After than a transient
    // backend blip — the operator must DELETE a surface before retry can
    // succeed. Other transient classes (EXTERNAL/TIMEOUT/UNAVAILABLE/
    // RATE_LIMIT/retryable) get the standard 5s response.
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
  // Reads enforce the same auth+ownership boundary as writes. A surface is
  // private to the agent that created it; non-owners get 404 (not 403) so
  // existence is not leaked.
  const auth = await requireAuth(request, authenticator);
  if (!auth.ok) return authFailureResponse(auth.error);

  const safe = await safeStoreCall(
    () => store.get(surfaceId, auth.value.agentId),
    `GET ${surfaceId}`,
  );
  if (!safe.ok) return safe.response;
  const result = safe.value;
  if (!result.ok) {
    // Transient backend failure (e.g. durable store reporting EXTERNAL/
    // TIMEOUT via Result) must surface as 503 + Retry-After, not 404 —
    // otherwise clients will mistake an outage for a deleted surface.
    const transient = transientStoreFailureResponse(result.error, `GET ${surfaceId}`);
    if (transient !== undefined) return transient;
    return jsonResponse(404, { ok: false, error: "Surface not found" });
  }
  // Fail-closed: ownership is mandatory. The HTTP `create()` path always
  // stamps `ownerId` from the authenticator, so an ownerless row reaching
  // this point can only have been pre-populated out of band by a durable
  // backend — operator must migrate (backfill ownerId) before it is
  // reachable via the HTTP API.
  if (result.value.ownerId !== auth.value.agentId) {
    return jsonResponse(404, { ok: false, error: "Surface not found" });
  }

  const etag = `"${surfaceEtag(result.value)}"`;
  // Tenant-private content. `private, no-store` prevents shared/reverse
  // proxies from caching the body across tenants — the URL is identical
  // for all tenants and access control lives only in `Authorization`, so
  // any cache that keys on path alone could replay one tenant's surface
  // to another. `Vary: Authorization` is also emitted as a defense in
  // depth for caches that ignore `no-store` directives on 304s.
  const privateHeaders = {
    "Cache-Control": "private, no-store",
    Vary: "Authorization",
  };
  const ifNoneMatch = request.headers.get("If-None-Match");
  if (ifNoneMatch === etag) {
    return new Response(null, {
      status: 304,
      headers: { ETag: etag, ...privateHeaders },
    });
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
      headers: { "Content-Type": "application/json", ETag: etag, ...privateHeaders },
    },
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

  const etag = `"${surfaceEtag(result.value)}"`;
  return new Response(JSON.stringify({ ok: true, surfaceId }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      ETag: etag,
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

  // Publish the public `deleted` event with the PUBLIC surfaceId, then
  // tear down subscribers. Embedding the registry key (which is tenant-
  // qualified) into the wire payload would leak internal key material
  // to every client.
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

async function handleSseSubscribe(
  request: Request,
  surfaceId: string,
  store: SurfaceStore,
  sse: CanvasSseManager,
  config: CanvasRouteConfig,
  authenticator: CanvasAuthenticator,
  budget: HandshakeBudget,
): Promise<Response> {
  // Live subscriptions enforce the same auth+ownership boundary as reads
  // and writes — a non-owner cannot tail another tenant's update stream.
  const auth = await requireAuth(request, authenticator);
  if (!auth.ok) return authFailureResponse(auth.error);

  // Capture the surface's generationId at admission time. The post-admit
  // recheck below verifies the same generation is still in place, so a
  // delete-then-recreate (even by the same owner) cannot splice a new
  // surface instance into this stream.
  const initialSafe = await safeStoreCall(
    () => store.get(surfaceId, auth.value.agentId),
    `SSE-init ${surfaceId}`,
  );
  if (!initialSafe.ok) return initialSafe.response;
  const initial = initialSafe.value;
  if (!initial.ok) {
    // Transient backend failure (EXTERNAL/TIMEOUT/UNAVAILABLE/etc.) must
    // surface as 503 so clients retry. Falling through to 404 on every
    // non-OK Result would convert a backend brownout into permanent
    // "surface gone" UX.
    const transient = transientStoreFailureResponse(initial.error, `SSE-init ${surfaceId}`);
    if (transient !== undefined) return transient;
    return jsonResponse(404, { ok: false, error: "Surface not found" });
  }
  if (initial.value.ownerId !== auth.value.agentId) {
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
  // Byte-budgeted pre-start buffer. Each chunk is a full SSE event whose
  // payload can be up to maxBodyBytes per accepted PATCH, so the cap MUST
  // accommodate at least one max-size event plus framing overhead — otherwise
  // legitimate updates within the allowed body size would knock over the
  // handshake. Cap = 2 × maxBodyBytes (room for one full event + a second
  // chunk during the handshake window) bounds worst-case memory while
  // keeping the SSE path usable for the same payloads PATCH accepts.
  const PENDING_BYTES_CAP = config.maxBodyBytes * 2;
  // let: running byte total of `pendingChunks`; checked before each push.
  let pendingBytes = 0;
  // let: set to true if the pre-start buffer overflowed, signaling that the
  // SSE manager reaped this subscriber. We must fail the handshake instead
  // of returning 200 on a zombie stream that will never see future events.
  let preStartOverflow = false;
  // let: set to true if `onClose` fires before the ReadableStream's `start()`
  // bound `controllerRef`. Without this, a DELETE landing between
  // `sse.subscribe()` admission and `start()` execution would invoke the
  // hook with `controllerRef === undefined`, drop the close on the floor,
  // and leave the client on a zombie 200 stream that never terminates.
  let closedBeforeStart = false;
  const streamKey = sseKey(auth.value.agentId, surfaceId);
  const subscribeResult = sse.subscribe(
    streamKey,
    (data) => {
      if (controllerRef === undefined) {
        // Two-tier admission: per-handshake cap stops one slow
        // subscriber from monopolising the per-conn budget, AND a global
        // counter caps total memory consumption across ALL concurrent
        // handshakes so a burst cannot blow up to (maxBodyBytes * 2 *
        // maxTotalSubscribers) of buffered bytes.
        if (
          pendingBytes + data.byteLength > PENDING_BYTES_CAP ||
          budget.bytes + data.byteLength > HANDSHAKE_BYTES_CAP_PER_SERVER
        ) {
          preStartOverflow = true;
          // Drop the buffer eagerly — the handshake will return 503 below and
          // the queued bytes will never be delivered to a client.
          budget.bytes -= pendingBytes;
          pendingChunks.length = 0;
          pendingBytes = 0;
          return false;
        }
        pendingChunks.push(data);
        pendingBytes += data.byteLength;
        budget.bytes += data.byteLength;
        return true;
      }
      try {
        controllerRef.enqueue(data);
        return true;
      } catch {
        return false;
      }
    },
    () => {
      // onClose: fired when sse.close(streamKey) tears down this stream
      // (e.g. on DELETE) or when the manager itself is disposed.
      // Terminate the underlying ReadableStream so the client's HTTP
      // connection actually ends — otherwise the response stays open
      // forever, the client believes it is still subscribed, and the
      // socket/fd leaks under churn.
      // Pre-start path: if `start()` has not bound `controllerRef` yet,
      // record the close so the eventual `start()` callback can terminate
      // the stream immediately instead of handing the client a zombie 200.
      if (controllerRef === undefined) {
        closedBeforeStart = true;
        return;
      }
      try {
        controllerRef.close();
      } catch {
        // controller may already be closed (cancel race); ignore.
      }
    },
  );
  if (!subscribeResult.ok) {
    return new Response(JSON.stringify({ ok: false, error: subscribeResult.error.message }), {
      status: 503,
      headers: {
        "Content-Type": "application/json",
        "Retry-After": "5",
        "Cache-Control": "private, no-store",
        Vary: "Authorization",
      },
    });
  }
  const unsubscribe = subscribeResult.value;

  // Release any pre-start buffered bytes back to the global handshake
  // budget on every failure path. Without this, a failed handshake with
  // queued chunks would leak bytes into `budget.bytes` and
  // gradually shrink the available budget for future subscribers.
  function releasePendingBytes(): void {
    budget.bytes -= pendingBytes;
    pendingChunks.length = 0;
    pendingBytes = 0;
  }
  function teardownHandshake(): void {
    releasePendingBytes();
    unsubscribe();
  }

  // Attach abort cleanup BEFORE the next await. If the client disconnects
  // during the post-admit recheck, the listener (or the synchronous
  // signal.aborted check below) ensures the reserved subscriber slot is
  // released — otherwise dead subscribers can accumulate and starve real
  // ones until a publish/keep-alive reaps them.
  request.signal.addEventListener("abort", () => {
    teardownHandshake();
  });
  if (request.signal.aborted) {
    teardownHandshake();
    return jsonResponse(499, { ok: false, error: "Client disconnected" });
  }

  // Generation-aware revalidation: if the surface was deleted/recreated
  // (any owner — same or different) between the initial read and this
  // subscribe(), the new instance has a fresh generationId. Reject so the
  // client cannot merge events across surface instances.
  // The store may be a durable backend whose `get()` can reject OR return
  // a transient Result error. In both cases we MUST release the reserved
  // subscriber slot before responding, or the slot leaks until next
  // publish/keep-alive — repeated backend faults would accumulate dead
  // reservations and starve real subscribers with false 503s.
  const recheckSafe = await safeStoreCall(
    () => store.get(surfaceId, auth.value.agentId),
    `SSE-recheck ${surfaceId}`,
  );
  if (!recheckSafe.ok) {
    teardownHandshake();
    return recheckSafe.response;
  }
  const recheck = recheckSafe.value;
  if (!recheck.ok) {
    teardownHandshake();
    const transient = transientStoreFailureResponse(recheck.error, `SSE-recheck ${surfaceId}`);
    if (transient !== undefined) return transient;
    return jsonResponse(404, { ok: false, error: "Surface not found" });
  }
  if (
    recheck.value.ownerId !== auth.value.agentId ||
    recheck.value.generationId !== expectedGeneration
  ) {
    teardownHandshake();
    return jsonResponse(404, { ok: false, error: "Surface not found" });
  }
  if (request.signal.aborted) {
    teardownHandshake();
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
        headers: {
          "Content-Type": "application/json",
          "Retry-After": "1",
          "Cache-Control": "private, no-store",
          Vary: "Authorization",
        },
      },
    );
  }

  // Initial `snapshot` event closes the GET→subscribe consistency gap: a
  // client doing the normal "GET surface, then subscribe" flow can miss an
  // update that lands between the two calls. The snapshot event lets the
  // client compare the etag it has from GET against the etag at the moment
  // of stream establishment and refresh state if they differ — without it,
  // the UI can stay stale until the next unrelated write.
  const snapshotEvent = textEncoder.encode(
    `id: 0\nevent: snapshot\ndata: ${JSON.stringify({
      surfaceId,
      etag: surfaceEtag(recheck.value),
      generationId: recheck.value.generationId,
      updatedAt: recheck.value.updatedAt,
    })}\n\n`,
  );

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controllerRef = controller;
      // Honor a close that fired during the subscribe→start window (e.g.
      // a DELETE that landed between recheck success and `start()`
      // executing). Replay the buffered `deleted` event so the client sees
      // why the stream ended, then close immediately — without this, the
      // hook's `controllerRef?.close()` would have no-op'd and the 200
      // response would remain open forever.
      if (closedBeforeStart) {
        for (const chunk of pendingChunks) {
          try {
            controller.enqueue(chunk);
          } catch {
            // controller already errored/closed; stop replay.
            break;
          }
        }
        pendingChunks.length = 0;
        budget.bytes -= pendingBytes;
        pendingBytes = 0;
        try {
          controller.close();
        } catch {
          // already closed.
        }
        return;
      }
      controller.enqueue(textEncoder.encode(": connected\n\n"));
      controller.enqueue(snapshotEvent);
      // Replay anything buffered during the subscribe→recheck window,
      // then release the bytes back to the global handshake budget.
      for (const chunk of pendingChunks) controller.enqueue(chunk);
      pendingChunks.length = 0;
      budget.bytes -= pendingBytes;
      pendingBytes = 0;
    },
    cancel() {
      unsubscribe();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      // Tenant-private stream — same cache posture as authenticated GET.
      // `private, no-store` blocks shared intermediaries from buffering
      // and replaying one tenant's events to another on the same path.
      // `X-Accel-Buffering: no` disables nginx response buffering, which
      // would otherwise stall events until the buffer fills.
      "Cache-Control": "private, no-store",
      Vary: "Authorization",
      "X-Accel-Buffering": "no",
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
  authenticator: CanvasAuthenticator,
): CanvasServer {
  // Authentication is mandatory. Surfaces are tenant-scoped — without an
  // authenticator, ownerId can never be stamped on create() and every read
  // would return 404 (fail-closed against ownerless rows). Reject at
  // construction so an integrator sees the misconfiguration immediately
  // instead of getting a server that 401s every request at runtime.
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
  // Per-server SSE handshake byte budget. Scoped here (not module-level)
  // so multiple `createCanvasServer()` instances in the same process do
  // not contend on a shared admission counter — without this, a slow
  // store on one server could starve unrelated servers with false 503s.
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

  return {
    async start(): Promise<void> {
      // Idempotent / fail-fast: a second start() without an intervening
      // stop() would orphan the existing listener — its handle would be
      // overwritten and unreachable. Throw instead so a deploy or
      // lifecycle bug surfaces immediately rather than leaving a leaked
      // socket exposed.
      if (server !== undefined) {
        throw new Error(
          "createCanvasServer: server is already running; call stop() before start() again",
        );
      }
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
            return handleSseSubscribe(
              request,
              surfaceId,
              store,
              sse,
              routeConfig,
              authenticator,
              handshakeBudget,
            );
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
