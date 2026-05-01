/**
 * SSE subscribe handler — split out of `canvas-routes.ts` to keep both files
 * under the file-size and function-length limits. Internal — exported only
 * for `createCanvasServer` to wire.
 */

import {
  authFailureResponse,
  HANDSHAKE_BYTES_CAP_PER_SERVER,
  type HandshakeBudget,
  requireAuth,
  safeStoreCall,
  sseKey,
  textEncoder,
  transientStoreFailureResponse,
} from "./canvas-shared.js";
import { surfaceEtag } from "./canvas-store.js";
import { jsonResponse } from "./http-helpers.js";
import type {
  CanvasAuthenticator,
  CanvasRouteConfig,
  CanvasSseManager,
  SurfaceEntry,
  SurfaceStore,
} from "./types.js";

interface HandshakeState {
  controllerRef: ReadableStreamDefaultController<Uint8Array> | undefined;
  pendingChunks: Uint8Array[];
  pendingBytes: number;
  preStartOverflow: boolean;
  closedBeforeStart: boolean;
}

function buildSnapshotEvent(
  surfaceId: string,
  entry: SurfaceEntry,
  config: CanvasRouteConfig,
  budget: HandshakeBudget,
  state: HandshakeState,
): Uint8Array {
  // Preflight on raw content length BEFORE any JSON.stringify/encode.
  // String length × 2 is a conservative ceiling; only build the full
  // payload if it could plausibly fit, then check actual bytes precisely.
  const contentBytesUpperBound = entry.content.length * 2;
  const fullCouldFit =
    contentBytesUpperBound <= config.maxBodyBytes &&
    budget.bytes + contentBytesUpperBound <= HANDSHAKE_BYTES_CAP_PER_SERVER;
  if (fullCouldFit) {
    const fullPayload = JSON.stringify({
      surfaceId,
      etag: surfaceEtag(entry),
      generationId: entry.generationId,
      updatedAt: entry.updatedAt,
      content: entry.content,
    });
    const fullBytes = textEncoder.encode(`id: 0\nevent: snapshot\ndata: ${fullPayload}\n\n`);
    if (
      fullPayload.length <= config.maxBodyBytes &&
      budget.bytes + fullBytes.byteLength <= HANDSHAKE_BYTES_CAP_PER_SERVER
    ) {
      budget.bytes += fullBytes.byteLength;
      state.pendingBytes += fullBytes.byteLength;
      return fullBytes;
    }
  }
  const metaPayload = JSON.stringify({
    surfaceId,
    etag: surfaceEtag(entry),
    generationId: entry.generationId,
    updatedAt: entry.updatedAt,
  });
  const metaBytes = textEncoder.encode(`id: 0\nevent: snapshot\ndata: ${metaPayload}\n\n`);
  budget.bytes += metaBytes.byteLength;
  state.pendingBytes += metaBytes.byteLength;
  return metaBytes;
}

function deliverPreStart(
  data: Uint8Array,
  state: HandshakeState,
  budget: HandshakeBudget,
  pendingCap: number,
): boolean {
  if (state.controllerRef === undefined) {
    if (
      state.pendingBytes + data.byteLength > pendingCap ||
      budget.bytes + data.byteLength > HANDSHAKE_BYTES_CAP_PER_SERVER
    ) {
      state.preStartOverflow = true;
      budget.bytes -= state.pendingBytes;
      state.pendingChunks.length = 0;
      state.pendingBytes = 0;
      return false;
    }
    state.pendingChunks.push(data);
    state.pendingBytes += data.byteLength;
    budget.bytes += data.byteLength;
    return true;
  }
  try {
    state.controllerRef.enqueue(data);
    return true;
  } catch {
    return false;
  }
}

function makeStartCallback(
  state: HandshakeState,
  snapshotEvent: Uint8Array,
  budget: HandshakeBudget,
): (controller: ReadableStreamDefaultController<Uint8Array>) => void {
  return (controller) => {
    state.controllerRef = controller;
    // Honor a close that fired during the subscribe→start window (e.g.
    // DELETE landing between recheck success and `start()` executing).
    if (state.closedBeforeStart) {
      for (const chunk of state.pendingChunks) {
        try {
          controller.enqueue(chunk);
        } catch {
          break;
        }
      }
      state.pendingChunks.length = 0;
      budget.bytes -= state.pendingBytes;
      state.pendingBytes = 0;
      try {
        controller.close();
      } catch {}
      return;
    }
    controller.enqueue(textEncoder.encode(": connected\n\n"));
    controller.enqueue(snapshotEvent);
    for (const chunk of state.pendingChunks) controller.enqueue(chunk);
    state.pendingChunks.length = 0;
    budget.bytes -= state.pendingBytes;
    state.pendingBytes = 0;
  };
}

function overrunResponse(): Response {
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

export async function handleSseSubscribe(
  request: Request,
  surfaceId: string,
  store: SurfaceStore,
  sse: CanvasSseManager,
  config: CanvasRouteConfig,
  authenticator: CanvasAuthenticator,
  budget: HandshakeBudget,
): Promise<Response> {
  const auth = await requireAuth(request, authenticator);
  if (!auth.ok) return authFailureResponse(auth.error);

  const initialSafe = await safeStoreCall(
    () => store.get(surfaceId, auth.value.agentId),
    `SSE-init ${surfaceId}`,
  );
  if (!initialSafe.ok) return initialSafe.response;
  const initial = initialSafe.value;
  if (!initial.ok) {
    const transient = transientStoreFailureResponse(initial.error, `SSE-init ${surfaceId}`);
    if (transient !== undefined) return transient;
    return jsonResponse(404, { ok: false, error: "Surface not found" });
  }
  if (initial.value.ownerId !== auth.value.agentId) {
    return jsonResponse(404, { ok: false, error: "Surface not found" });
  }
  const expectedGeneration = initial.value.generationId;

  const state: HandshakeState = {
    controllerRef: undefined,
    pendingChunks: [],
    pendingBytes: 0,
    preStartOverflow: false,
    closedBeforeStart: false,
  };
  const PENDING_BYTES_CAP = config.maxBodyBytes * 2;
  const streamKey = sseKey(auth.value.agentId, surfaceId);
  const subscribeResult = sse.subscribe(
    streamKey,
    (data) => deliverPreStart(data, state, budget, PENDING_BYTES_CAP),
    () => {
      if (state.controllerRef === undefined) {
        state.closedBeforeStart = true;
        return;
      }
      try {
        state.controllerRef.close();
      } catch {}
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

  const teardown = (): void => {
    budget.bytes -= state.pendingBytes;
    state.pendingChunks.length = 0;
    state.pendingBytes = 0;
    unsubscribe();
  };

  request.signal.addEventListener("abort", () => {
    teardown();
  });
  if (request.signal.aborted) {
    teardown();
    return jsonResponse(499, { ok: false, error: "Client disconnected" });
  }

  const recheckSafe = await safeStoreCall(
    () => store.get(surfaceId, auth.value.agentId),
    `SSE-recheck ${surfaceId}`,
  );
  if (!recheckSafe.ok) {
    teardown();
    return recheckSafe.response;
  }
  const recheck = recheckSafe.value;
  if (!recheck.ok) {
    teardown();
    const transient = transientStoreFailureResponse(recheck.error, `SSE-recheck ${surfaceId}`);
    if (transient !== undefined) return transient;
    return jsonResponse(404, { ok: false, error: "Surface not found" });
  }
  if (
    recheck.value.ownerId !== auth.value.agentId ||
    recheck.value.generationId !== expectedGeneration
  ) {
    teardown();
    return jsonResponse(404, { ok: false, error: "Surface not found" });
  }
  if (request.signal.aborted) {
    teardown();
    return jsonResponse(499, { ok: false, error: "Client disconnected" });
  }
  if (state.preStartOverflow) {
    return overrunResponse();
  }

  const snapshotEvent = buildSnapshotEvent(surfaceId, recheck.value, config, budget, state);
  const stream = new ReadableStream<Uint8Array>({
    start: makeStartCallback(state, snapshotEvent, budget),
    cancel: unsubscribe,
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "private, no-store",
      Vary: "Authorization",
      "X-Accel-Buffering": "no",
      Connection: "keep-alive",
    },
  });
}
