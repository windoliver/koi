/**
 * Gateway factory: wires transport, auth, sessions, sequencing, and backpressure
 * into a minimal WebSocket control-plane entry point.
 *
 * Intentionally omits: node registry, tool routing, session resume TTL,
 * channel binding, scheduler, and heartbeat sweep — those belong in future issues.
 */

import type { KoiError, Result } from "@koi/core";
import { notFound } from "@koi/core";
import { swallowError } from "@koi/errors";
import type { GatewayAuthenticator, HandshakeOptions } from "./auth.js";
import { handleHandshake } from "./auth.js";
import { createBackpressureMonitor } from "./backpressure.js";
import { CLOSE_CODES } from "./close-codes.js";
import {
  createAckFrame,
  createErrorFrame,
  createFrameIdGenerator,
  encodeFrame,
  parseFrame,
} from "./protocol.js";
import { createSequenceTracker } from "./sequence-tracker.js";
import type { SessionStore } from "./session-store.js";
import { createInMemorySessionStore } from "./session-store.js";
import type { Transport, TransportConnection, TransportHandler } from "./transport.js";
import type { GatewayConfig, GatewayFrame, Session } from "./types.js";
import { DEFAULT_GATEWAY_CONFIG } from "./types.js";

// ---------------------------------------------------------------------------
// Session events
// ---------------------------------------------------------------------------

export type SessionEvent =
  | { readonly kind: "created"; readonly session: Session }
  | { readonly kind: "destroyed"; readonly sessionId: string; readonly reason: string };

// ---------------------------------------------------------------------------
// Gateway interface
// ---------------------------------------------------------------------------

export interface Gateway {
  readonly start: (port: number) => Promise<void>;
  readonly stop: () => Promise<Result<void, KoiError>>;
  readonly sessions: () => SessionStore;
  readonly onFrame: (handler: (session: Session, frame: GatewayFrame) => void) => () => void;
  readonly send: (sessionId: string, frame: GatewayFrame) => Result<number, KoiError>;
  readonly dispatch: (session: Session, frame: GatewayFrame) => void;
  readonly destroySession: (sessionId: string, reason?: string) => Promise<Result<void, KoiError>>;
  readonly onSessionEvent: (handler: (event: SessionEvent) => void) => () => void;
}

// ---------------------------------------------------------------------------
// Deps
// ---------------------------------------------------------------------------

export interface GatewayDeps {
  readonly transport: Transport;
  readonly auth: GatewayAuthenticator;
  readonly store?: SessionStore | undefined;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createGateway(
  configOverrides: Readonly<Partial<GatewayConfig>>,
  deps: GatewayDeps,
): Gateway {
  const config: GatewayConfig = { ...DEFAULT_GATEWAY_CONFIG, ...configOverrides };
  const store = deps.store ?? createInMemorySessionStore();
  const bp = createBackpressureMonitor(config);
  const nextId = createFrameIdGenerator();

  const connMap = new Map<string, TransportConnection>();
  const sessionByConn = new Map<string, string>(); // connId → sessionId
  const connBySession = new Map<string, string>(); // sessionId → connId
  const trackers = new Map<string, ReturnType<typeof createSequenceTracker>>();
  const pendingHandshakes = new Map<string, (data: string) => void>();
  // Per-connection serial queues: each new message chains onto the previous so frames
  // from the same socket are processed one-at-a-time through the async store path,
  // preventing remoteSeq regression from interleaved store.set() completions.
  const msgQueues = new Map<string, Promise<void>>();
  // Per-connection inbound sequence-buffer pressure. SequenceTracker holds GatewayFrame
  // objects for out-of-order gaps; without a byte cap this is an unbounded OOM path.
  // Key: connId → Map<seq, frameBytes> — precise per-seq tracking so bytes are discharged
  // only when a frame actually leaves the reorder buffer (appears in ready[1..]).
  const inboundBufferedSeqs = new Map<string, Map<number, number>>();

  const frameHandlers = new Set<(session: Session, frame: GatewayFrame) => void>();
  const sessionEventHandlers = new Set<(event: SessionEvent) => void>();

  let criticalSweep: ReturnType<typeof setInterval> | undefined;

  function emitSessionEvent(event: SessionEvent): void {
    for (const handler of sessionEventHandlers) {
      try {
        handler(event);
      } catch (err: unknown) {
        swallowError(err, { package: "gateway", operation: "onSessionEvent" });
      }
    }
  }

  function emitFrames(session: Session, frames: readonly GatewayFrame[]): void {
    let firstError: unknown;
    for (const frame of frames) {
      for (const handler of frameHandlers) {
        try {
          handler(session, frame);
        } catch (err: unknown) {
          swallowError(err, { package: "gateway", operation: "onFrame" });
          if (firstError === undefined) firstError = err;
        }
      }
    }
    // Re-throw so processMessage can skip the watermark persist on handler failure,
    // giving at-least-once delivery: the frame will be replayed on reconnect rather
    // than silently lost with the watermark already advanced.
    if (firstError !== undefined) throw firstError;
  }

  // Single send path for established-session writes so every outbound byte is
  // backpressure-accounted, including error/ack frames that bypass gateway.send().
  // Returns false when the transport rejected the write (-1) or the connection is
  // already at or above its per-connection buffer limit; callers should abort any
  // further processing for that connection.
  function sendFrame(conn: TransportConnection, data: string): boolean {
    // Pre-write projected admission control: reject when this frame would push the
    // per-connection or global buffer past its configured limit, not just when already
    // at it, so a large frame near the limit cannot overshoot by its full size.
    const frameBytes = Buffer.byteLength(data, "utf8");
    if (
      bp.buffered(conn.id) + frameBytes > config.maxBufferBytesPerConnection ||
      bp.globalUsage() + frameBytes > config.globalBufferLimitBytes
    ) {
      conn.close(CLOSE_CODES.BACKPRESSURE_TIMEOUT, "Buffer limit exceeded");
      cleanupConn(conn, "buffer limit exceeded");
      return false;
    }
    const bytes = conn.send(data);
    if (bytes <= 0) {
      conn.close(CLOSE_CODES.ADMIN_CLOSED, "Transport send failure");
      cleanupConn(conn, "transport send failure");
      return false;
    }
    bp.record(conn.id, frameBytes);
    return true;
  }

  function cleanupConn(conn: TransportConnection, reason: string): void {
    const sessionId = sessionByConn.get(conn.id);
    pendingHandshakes.delete(conn.id);
    trackers.delete(conn.id);
    msgQueues.delete(conn.id);
    inboundBufferedSeqs.delete(conn.id);
    sessionByConn.delete(conn.id);
    connMap.delete(conn.id);
    bp.remove(conn.id);

    if (sessionId !== undefined) {
      connBySession.delete(sessionId);
      // Session record is intentionally retained in the store so remoteSeq survives
      // network flaps and can be restored on reconnect. Explicit purge happens in
      // destroySession() and stop().
      emitSessionEvent({ kind: "destroyed", sessionId, reason });
    }
  }

  async function processMessage(conn: TransportConnection, data: string): Promise<void> {
    if (Buffer.byteLength(data, "utf8") > config.capabilities.maxFrameBytes) {
      conn.send(
        createErrorFrame(0, "FRAME_TOO_LARGE", "Frame exceeds maxFrameBytes limit", nextId),
      );
      conn.close(CLOSE_CODES.INVALID_HANDSHAKE, "Frame too large");
      return;
    }

    const handshakeHandler = pendingHandshakes.get(conn.id);
    if (handshakeHandler !== undefined) {
      handshakeHandler(data);
      return;
    }

    const sessionId = sessionByConn.get(conn.id);
    if (sessionId === undefined) {
      // Connection is fenced (mid-reconnect cutover) or not yet authenticated.
      // Send an explicit error so the client can retry rather than silently losing the frame.
      conn.send(
        createErrorFrame(0, "NOT_AUTHORIZED", "No active session; retry after reconnect", nextId),
      );
      return;
    }

    let sessionResult: Result<Session, KoiError>;
    try {
      sessionResult = await Promise.resolve(store.get(sessionId));
    } catch {
      sendFrame(
        conn,
        createErrorFrame(0, "SESSION_STORE_FAILURE", "Session lookup failed", nextId),
      );
      conn.close(CLOSE_CODES.SESSION_STORE_FAILURE, "Session lookup failed");
      return;
    }
    if (!sessionResult.ok) {
      sendFrame(conn, createErrorFrame(0, "SESSION_STORE_FAILURE", "Session not found", nextId));
      conn.close(CLOSE_CODES.SESSION_STORE_FAILURE, "Session not found");
      return;
    }

    const frameResult = parseFrame(data);
    if (!frameResult.ok) {
      sendFrame(
        conn,
        createErrorFrame(0, frameResult.error.code, frameResult.error.message, nextId),
      );
      return;
    }

    const tracker = trackers.get(conn.id);
    if (tracker === undefined) return;

    const { result, ready } = tracker.accept(frameResult.value);

    if (result === "duplicate" || result === "out_of_window") {
      sendFrame(conn, createAckFrame(frameResult.value.seq, frameResult.value.id, null, nextId));
      return;
    }

    if (result === "buffered") {
      // Charge buffered bytes against the per-connection inbound cap. Track per-seq so
      // bytes are discharged precisely when a frame leaves the reorder buffer (appears
      // in ready[1..]) rather than resetting to 0 on any partial progress — which would
      // allow frames remaining in the tracker to escape the cap.
      const frameBytes = Buffer.byteLength(data, "utf8");
      let seqBytes = inboundBufferedSeqs.get(conn.id);
      if (seqBytes === undefined) {
        seqBytes = new Map<number, number>();
        inboundBufferedSeqs.set(conn.id, seqBytes);
      }
      seqBytes.set(frameResult.value.seq, frameBytes);
      let total = 0;
      for (const b of seqBytes.values()) total += b;
      if (total > config.maxBufferBytesPerConnection) {
        sendFrame(
          conn,
          createErrorFrame(0, "BUFFER_LIMIT", "Inbound sequence buffer exceeded", nextId),
        );
        conn.close(CLOSE_CODES.BUFFER_LIMIT, "Inbound sequence buffer exceeded");
        return;
      }
      return;
    }

    // Discharge bytes for previously-buffered frames that were flushed into ready[1..].
    // ready[0] is the just-received frame (never buffered); ready[1..] were in the tracker.
    const seqBytes = inboundBufferedSeqs.get(conn.id);
    if (seqBytes !== undefined) {
      for (const f of ready.slice(1)) seqBytes.delete(f.seq);
      if (seqBytes.size === 0) inboundBufferedSeqs.delete(conn.id);
    }

    // Dispatch handlers BEFORE persisting the watermark. If a handler throws, emitFrames
    // re-throws and we close the connection so the advanced tracker state cannot be used
    // to accept frames past the failed one. On reconnect, remoteSeq is restored from the
    // store (which we did not update), so the failed frame is replayed (at-least-once).
    const lastDispatched = ready[ready.length - 1];
    if (lastDispatched !== undefined) {
      const updatedSession: Session = {
        ...sessionResult.value,
        remoteSeq: lastDispatched.seq + 1,
      };
      try {
        emitFrames(updatedSession, ready);
      } catch {
        conn.close(CLOSE_CODES.ADMIN_CLOSED, "Frame handler failure");
        cleanupConn(conn, "frame handler failure");
        return;
      }

      let storeRes: Result<void, KoiError>;
      try {
        storeRes = await Promise.resolve(store.set(updatedSession));
      } catch {
        sendFrame(
          conn,
          createErrorFrame(0, "SESSION_STORE_FAILURE", "Session update failed", nextId),
        );
        conn.close(CLOSE_CODES.SESSION_STORE_FAILURE, "Session update failed");
        return;
      }
      if (!storeRes.ok) {
        sendFrame(
          conn,
          createErrorFrame(0, "SESSION_STORE_FAILURE", "Session update failed", nextId),
        );
        conn.close(CLOSE_CODES.SESSION_STORE_FAILURE, "Session update failed");
        return;
      }
    }
  }

  const transportHandler: TransportHandler = {
    onOpen(conn: TransportConnection): void {
      if (connMap.size >= config.maxConnections) {
        conn.send(createErrorFrame(0, "MAX_CONNECTIONS", "Max connections exceeded", nextId));
        conn.close(CLOSE_CODES.MAX_CONNECTIONS, "Max connections exceeded");
        return;
      }

      if (!bp.canAccept()) {
        conn.send(createErrorFrame(0, "BUFFER_LIMIT", "Global buffer limit exceeded", nextId));
        conn.close(CLOSE_CODES.BUFFER_LIMIT, "Global buffer limit exceeded");
        return;
      }

      connMap.set(conn.id, conn);

      const handshakeOptions: HandshakeOptions = {
        minProtocolVersion: config.minProtocolVersion,
        maxProtocolVersion: config.maxProtocolVersion,
        capabilities: config.capabilities,
        ...(config.includeSnapshot
          ? { snapshot: { serverTime: Date.now(), activeConnections: connMap.size } }
          : {}),
      };

      void handleHandshake(conn, deps.auth, config.authTimeoutMs, handshakeOptions, (handler) => {
        pendingHandshakes.set(conn.id, handler);
      })
        .then(async (result) => {
          pendingHandshakes.delete(conn.id);

          if (!connMap.has(conn.id)) return;

          // Two-phase reconnect cutover:
          //   Phase 1 — fence the old connection so it can no longer write to the store,
          //             then drain any already-running processMessage() work. We save the old
          //             tracker so we can restore it if the store operations below fail and we
          //             need to keep the old connection alive rather than losing the session.
          //   Phase 2 — after persistence succeeds, complete eviction by closing the socket.
          //   On any store failure between the two phases, un-fence the old connection so it
          //             continues serving rather than dropping the session entirely.
          const prevConnId = connBySession.get(result.session.id);
          let savedTracker: ReturnType<typeof createSequenceTracker> | undefined;
          if (prevConnId !== undefined && prevConnId !== conn.id) {
            sessionByConn.delete(prevConnId);
            savedTracker = trackers.get(prevConnId);
            trackers.delete(prevConnId);
            const drainQueue = msgQueues.get(prevConnId) ?? Promise.resolve();
            msgQueues.delete(prevConnId);
            await drainQueue;
          }

          // Helper: un-fence the old conn and reject the new one on store failure.
          function abortReconnect(closeCode: number, reason: string): void {
            if (prevConnId !== undefined && prevConnId !== conn.id) {
              sessionByConn.set(prevConnId, result.session.id);
              if (savedTracker !== undefined) trackers.set(prevConnId, savedTracker);
              msgQueues.set(prevConnId, Promise.resolve());
            }
            conn.close(closeCode, reason);
            cleanupConn(conn, reason);
          }

          // Restore remoteSeq from any previously persisted session to prevent frame replay.
          // Distinguish NOT_FOUND (new session → start at 0) from a store exception: if the
          // store throws we cannot safely determine the replay window, so we reject the
          // reconnect rather than silently downgrading to seq 0 and risking duplicate dispatch.
          let startSeq = 0;
          try {
            const prev = await Promise.resolve(store.get(result.session.id));
            if (prev.ok) startSeq = prev.value.remoteSeq;
            // !prev.ok (e.g. NOT_FOUND) → genuinely new session, start at 0
          } catch {
            abortReconnect(CLOSE_CODES.SESSION_STORE_FAILURE, "session store failure on resume");
            return;
          }
          const tracker = createSequenceTracker(config.dedupWindowSize);
          if (startSeq > 0) tracker.reset(startSeq);
          trackers.set(conn.id, tracker);

          // Carry recovered remoteSeq into the persisted session so subsequent reconnects
          // restore the correct window even if no new frames arrive before next disconnect.
          const sessionToStore: Session =
            startSeq > 0 ? { ...result.session, remoteSeq: startSeq } : result.session;

          let storeResult: Result<void, KoiError>;
          try {
            storeResult = await Promise.resolve(store.set(sessionToStore));
          } catch {
            abortReconnect(CLOSE_CODES.SESSION_STORE_FAILURE, "session store failure");
            return;
          }
          if (!storeResult.ok) {
            abortReconnect(CLOSE_CODES.SESSION_STORE_FAILURE, "session store failure");
            return;
          }

          // Phase 2: Persistence succeeded — complete eviction of the old connection.
          if (prevConnId !== undefined && prevConnId !== conn.id) {
            const prevConn = connMap.get(prevConnId);
            connMap.delete(prevConnId);
            bp.remove(prevConnId);
            prevConn?.close(CLOSE_CODES.ADMIN_CLOSED, "Session resumed on new connection");
          }

          // Install maps and send ack only after persistence — prevents read-before-write.
          if (!connMap.has(conn.id)) return;
          sessionByConn.set(conn.id, result.session.id);
          connBySession.set(result.session.id, conn.id);
          const ackBytes = result.sendAck();
          if (ackBytes <= 0) {
            // Transport rejected the ack write — session is unusable before the client
            // received its sessionId/protocol. Tear down cleanly so the client reconnects.
            conn.close(CLOSE_CODES.ADMIN_CLOSED, "Ack send failed");
            cleanupConn(conn, "ack send failed");
            return;
          }
          bp.record(conn.id, ackBytes);
          emitSessionEvent({ kind: "created", session: result.session });
        })
        .catch(() => {
          pendingHandshakes.delete(conn.id);
          connMap.delete(conn.id);
          bp.remove(conn.id);
        });
    },

    onMessage(conn: TransportConnection, data: string): void {
      // Serialize per-connection: chain onto the tail of this connection's queue so
      // each frame completes parse → accept → persist → emit before the next begins,
      // preventing remoteSeq regression from interleaved async store.set() completions.
      const prev = msgQueues.get(conn.id) ?? Promise.resolve();
      const next = prev.then((): Promise<void> => processMessage(conn, data)).catch((): void => {});
      msgQueues.set(conn.id, next);
    },

    onClose(conn: TransportConnection, _code: number, reason: string): void {
      cleanupConn(conn, reason || "connection closed");
    },

    onDrain(conn: TransportConnection): void {
      // A drain event means Bun's write buffer has cleared; drain all tracked bytes.
      bp.drain(conn.id, bp.buffered(conn.id));
    },
  };

  return {
    async start(port: number): Promise<void> {
      await deps.transport.listen(port, transportHandler);

      criticalSweep = setInterval(() => {
        const now = Date.now();
        // When global usage exceeds the limit, shed any connection carrying buffered
        // bytes (warning or critical) — not just individually-critical ones. A fleet
        // of warning-state connections can collectively push aggregate usage over the
        // cap while none individually triggers the criticalSince path.
        const globalOverLimit = !bp.canAccept();
        for (const [connId, conn] of connMap) {
          const since = bp.criticalSince(connId);
          const timedOut =
            since !== undefined && now - since > config.backpressureCriticalTimeoutMs;
          const globalShed = globalOverLimit && bp.buffered(connId) > 0;
          if (timedOut || globalShed) {
            conn.send(createErrorFrame(0, "BUFFER_LIMIT", "Buffer limit exceeded", nextId));
            conn.close(CLOSE_CODES.BACKPRESSURE_TIMEOUT, "Backpressure timeout");
          }
        }
      }, 5_000);
    },

    async stop(): Promise<Result<void, KoiError>> {
      if (criticalSweep !== undefined) {
        clearInterval(criticalSweep);
        criticalSweep = undefined;
      }

      // Phase 1: Sever session↔conn mappings BEFORE closing sockets so that when the
      // transport delivers onClose → cleanupConn(), sessionByConn is already cleared and
      // no duplicate 'destroyed' events are emitted.
      for (const [connId, conn] of connMap) {
        const sessionId = sessionByConn.get(connId);
        sessionByConn.delete(connId);
        if (sessionId !== undefined) {
          connBySession.delete(sessionId);
          emitSessionEvent({ kind: "destroyed", sessionId, reason: "server shutdown" });
        }
        conn.close(CLOSE_CODES.SERVER_SHUTTING_DOWN, "Server shutting down");
      }

      // Phase 2: Delete ALL sessions from the store — not just those with live connections.
      // Sessions retained for reconnect (cleanupConn intentionally keeps them) must also
      // be purged on shutdown so a restarting process doesn't inherit stale remoteSeq state.
      const deletePromises: Promise<Result<boolean, KoiError>>[] = [];
      for (const [sessionId] of store.entries()) {
        deletePromises.push(Promise.resolve(store.delete(sessionId)));
      }
      const settled = await Promise.allSettled(deletePromises);
      let cleanupFailed = false;
      for (const r of settled) {
        if (r.status === "rejected") {
          swallowError(r.reason as unknown, { package: "gateway", operation: "stop.delete" });
          cleanupFailed = true;
        } else if (!r.value.ok) {
          swallowError(new Error(r.value.error.message), {
            package: "gateway",
            operation: "stop.delete",
          });
          cleanupFailed = true;
        }
      }

      connMap.clear();
      sessionByConn.clear();
      connBySession.clear();
      trackers.clear();
      pendingHandshakes.clear();
      deps.transport.close();

      if (cleanupFailed) {
        return {
          ok: false,
          error: {
            code: "EXTERNAL",
            message: "Gateway stop: one or more session store deletions failed",
            retryable: false,
            context: {},
          },
        };
      }
      return { ok: true, value: undefined };
    },

    sessions(): SessionStore {
      return store;
    },

    onFrame(handler: (session: Session, frame: GatewayFrame) => void): () => void {
      frameHandlers.add(handler);
      return () => {
        frameHandlers.delete(handler);
      };
    },

    send(sessionId: string, frame: GatewayFrame): Result<number, KoiError> {
      const connId = connBySession.get(sessionId);
      if (connId === undefined) {
        return { ok: false, error: notFound(sessionId, `Session not connected: ${sessionId}`) };
      }
      const conn = connMap.get(connId);
      if (conn === undefined) {
        return {
          ok: false,
          error: notFound(connId, `Connection not found for session: ${sessionId}`),
        };
      }
      const encoded = encodeFrame(frame);
      const frameBytes = Buffer.byteLength(encoded, "utf8");
      if (
        bp.buffered(connId) + frameBytes > config.maxBufferBytesPerConnection ||
        bp.globalUsage() + frameBytes > config.globalBufferLimitBytes
      ) {
        conn.close(CLOSE_CODES.BACKPRESSURE_TIMEOUT, "Buffer limit exceeded");
        cleanupConn(conn, "buffer limit exceeded");
        return {
          ok: false,
          error: {
            code: "EXTERNAL",
            message: `Buffer limit exceeded for session: ${sessionId}`,
            retryable: false,
            context: { sessionId },
          } satisfies KoiError,
        };
      }
      const bytes = conn.send(encoded);
      if (bytes <= 0) {
        conn.close(CLOSE_CODES.ADMIN_CLOSED, "Transport send failure");
        cleanupConn(conn, "transport send failure");
        const error: KoiError = {
          code: "EXTERNAL",
          message: `Transport send failed for session: ${sessionId}`,
          retryable: false,
          context: { sessionId },
        };
        return { ok: false, error };
      }
      bp.record(connId, frameBytes);
      return { ok: true, value: bytes };
    },

    dispatch(session: Session, frame: GatewayFrame): void {
      emitFrames(session, [frame]);
    },

    async destroySession(
      sessionId: string,
      reason = "administratively closed",
    ): Promise<Result<void, KoiError>> {
      const connId = connBySession.get(sessionId);
      // Save queue BEFORE cleanupConn removes it so we can drain it below.
      const drainQueue =
        connId !== undefined ? (msgQueues.get(connId) ?? Promise.resolve()) : Promise.resolve();
      if (connId !== undefined) {
        const conn = connMap.get(connId);
        if (conn !== undefined) {
          conn.send(createErrorFrame(0, "ADMIN_CLOSED", reason, nextId));
          conn.close(CLOSE_CODES.ADMIN_CLOSED, reason);
          // Synchronously sever routing so send() fails immediately after this
          // call resolves, rather than leaking frames until onClose() fires.
          cleanupConn(conn, reason);
        }
      }
      // Drain any in-flight processMessage that could call store.set(session) after we
      // delete the session below, which would resurrect ghost state in the store.
      await drainQueue;
      // Await deletion so callers get a real success/failure contract. Idempotent —
      // store.delete is a no-op for unknown sessions.
      let deleteResult: Result<boolean, KoiError>;
      try {
        deleteResult = await Promise.resolve(store.delete(sessionId));
      } catch {
        const error: KoiError = {
          code: "EXTERNAL",
          message: `Failed to delete session from store: ${sessionId}`,
          retryable: true,
          context: { sessionId },
        };
        return { ok: false, error };
      }
      if (!deleteResult.ok) {
        return { ok: false, error: deleteResult.error };
      }
      return { ok: true, value: undefined };
    },

    onSessionEvent(handler: (event: SessionEvent) => void): () => void {
      sessionEventHandlers.add(handler);
      return () => {
        sessionEventHandlers.delete(handler);
      };
    },
  };
}
