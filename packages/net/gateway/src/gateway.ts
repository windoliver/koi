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
  readonly stop: () => Promise<void>;
  readonly sessions: () => SessionStore;
  readonly onFrame: (handler: (session: Session, frame: GatewayFrame) => void) => () => void;
  readonly send: (sessionId: string, frame: GatewayFrame) => Result<number, KoiError>;
  readonly dispatch: (session: Session, frame: GatewayFrame) => void;
  readonly destroySession: (sessionId: string, reason?: string) => Result<void, KoiError>;
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
    for (const frame of frames) {
      for (const handler of frameHandlers) {
        try {
          handler(session, frame);
        } catch (err: unknown) {
          swallowError(err, { package: "gateway", operation: "onFrame" });
        }
      }
    }
  }

  // Single send path for established-session writes so every outbound byte is
  // backpressure-accounted, including error/ack frames that bypass gateway.send().
  function sendFrame(conn: TransportConnection, data: string): void {
    conn.send(data);
    bp.record(conn.id, Buffer.byteLength(data, "utf8"));
  }

  function cleanupConn(conn: TransportConnection, reason: string): void {
    const sessionId = sessionByConn.get(conn.id);
    pendingHandshakes.delete(conn.id);
    trackers.delete(conn.id);
    msgQueues.delete(conn.id);
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
    if (sessionId === undefined) return;

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

    if (result === "buffered") return;

    // Persist the nextExpected watermark (last dispatched seq + 1) so reconnect
    // restoration resets the tracker past already-processed frames, preventing replay.
    // Await persistence before dispatching so handlers cannot run against stale state.
    const lastDispatched = ready[ready.length - 1];
    if (lastDispatched !== undefined) {
      const updatedSession: Session = {
        ...sessionResult.value,
        remoteSeq: lastDispatched.seq + 1,
      };
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
      emitFrames(updatedSession, ready);
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

          // Snapshot the previous connection for this session ID — we defer eviction
          // until after all store operations succeed (two-phase cutover). If store ops
          // fail, the new connection is closed and the old session remains authoritative.
          const prevConnId = connBySession.get(result.session.id);

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
            conn.close(CLOSE_CODES.SESSION_STORE_FAILURE, "Session store error on resume");
            cleanupConn(conn, "session store failure on resume");
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
            conn.close(CLOSE_CODES.SESSION_STORE_FAILURE, "Session store error");
            cleanupConn(conn, "session store failure");
            return;
          }
          if (!storeResult.ok) {
            conn.close(CLOSE_CODES.SESSION_STORE_FAILURE, "Session store error");
            cleanupConn(conn, "session store failure");
            return;
          }

          // All persistence succeeded — now atomically evict the previous connection.
          // Remove old conn maps first so its onClose/cleanupConn skips session teardown.
          if (prevConnId !== undefined && prevConnId !== conn.id) {
            sessionByConn.delete(prevConnId);
            trackers.delete(prevConnId);
            msgQueues.delete(prevConnId);
            const prevConn = connMap.get(prevConnId);
            connMap.delete(prevConnId);
            bp.remove(prevConnId);
            prevConn?.close(CLOSE_CODES.ADMIN_CLOSED, "Session resumed on new connection");
          }

          // Install maps and send ack only after persistence — prevents read-before-write.
          if (!connMap.has(conn.id)) return;
          sessionByConn.set(conn.id, result.session.id);
          connBySession.set(result.session.id, conn.id);
          result.sendAck();
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
        // When global usage exceeds the limit, shed any connection already in critical
        // state immediately rather than waiting for its per-connection timeout. This
        // enforces globalBufferLimitBytes as an ongoing cap, not just an admission gate.
        const globalOverLimit = !bp.canAccept();
        for (const [connId, conn] of connMap) {
          const since = bp.criticalSince(connId);
          if (since !== undefined) {
            const timedOut = now - since > config.backpressureCriticalTimeoutMs;
            if (timedOut || globalOverLimit) {
              conn.send(createErrorFrame(0, "BUFFER_LIMIT", "Buffer limit exceeded", nextId));
              conn.close(CLOSE_CODES.BACKPRESSURE_TIMEOUT, "Backpressure timeout");
            }
          }
        }
      }, 5_000);
    },

    async stop(): Promise<void> {
      if (criticalSweep !== undefined) {
        clearInterval(criticalSweep);
        criticalSweep = undefined;
      }

      // Close all live connections and emit destroy events before stopping transport.
      for (const [connId, conn] of connMap) {
        conn.close(CLOSE_CODES.SERVER_SHUTTING_DOWN, "Server shutting down");
        const sessionId = sessionByConn.get(connId);
        if (sessionId !== undefined) {
          void Promise.resolve(store.delete(sessionId));
          emitSessionEvent({ kind: "destroyed", sessionId, reason: "server shutdown" });
        }
      }
      connMap.clear();
      sessionByConn.clear();
      connBySession.clear();
      trackers.clear();
      pendingHandshakes.clear();

      deps.transport.close();
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
      const bytes = conn.send(encoded);
      if (bytes === -1) {
        const error: KoiError = {
          code: "EXTERNAL",
          message: `Transport send failed for session: ${sessionId}`,
          retryable: false,
          context: { sessionId },
        };
        return { ok: false, error };
      }
      bp.record(connId, encoded.length);
      return { ok: true, value: bytes };
    },

    dispatch(session: Session, frame: GatewayFrame): void {
      emitFrames(session, [frame]);
    },

    destroySession(sessionId: string, reason = "administratively closed"): Result<void, KoiError> {
      const connId = connBySession.get(sessionId);
      if (connId !== undefined) {
        const conn = connMap.get(connId);
        if (conn !== undefined) {
          conn.send(createErrorFrame(0, "ADMIN_CLOSED", reason, nextId));
          conn.close(CLOSE_CODES.ADMIN_CLOSED, reason);
        }
      }
      // Purge from store regardless of live connection state so operators can remove
      // stale disconnected sessions. Idempotent — store.delete is a no-op for unknowns.
      void Promise.resolve(store.delete(sessionId));
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
