/**
 * Gateway factory: wires transport, auth, sessions, sequencing, and backpressure
 * into a minimal WebSocket control-plane entry point.
 *
 * Intentionally omits: node registry, tool routing, channel binding, scheduler,
 * heartbeat sweep, and per-route onFrame handler isolation (routing enforcement
 * lives in the node-registry layer) — those belong in future issues.
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
  | { readonly kind: "disconnected"; readonly sessionId: string; readonly reason: string }
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
  // Monotonic per-connection server outbound seq counter. All server-originated frames
  // (handshake ack, protocol errors, dup/oow acks) use this so the client can dedup them
  // using the same sliding-window contract as client→server traffic.
  const connOutboundSeq = new Map<string, number>();
  // Disconnect timestamps for TTL sweep of retained sessions (connId-less, in-store).
  const disconnectedAt = new Map<string, number>(); // sessionId → ms since epoch
  // Session IDs created by this gateway instance. stop() only deletes owned sessions
  // so a shared/persistent store is not clobbered by an unrelated gateway shutdown.
  const ownedSessionIds = new Set<string>();
  // In-flight handleHandshake continuations. stop() awaits these so a mid-auth client
  // cannot complete store.set() after shutdown cleanup.
  const pendingHandshakePromises = new Set<Promise<void>>();
  // Per-connection abort callbacks for pending handshakes. stop() calls these so
  // handshakes fail immediately rather than waiting for the auth timeout to fire.
  const handshakeAborts = new Map<string, () => void>();
  // On-disconnect seq persists: store.get → store.set(seq) fired from cleanupConn to
  // capture outbound seq advanced by gateway.send() after the last inbound frame.
  // destroySession and reconnect await these before touching the store to prevent races.
  const pendingSeqPersists = new Map<string, Promise<void>>();
  // Set to true by stop() so pending handshake continuations bail out before store.set().
  let stopped = false;

  const frameHandlers = new Set<(session: Session, frame: GatewayFrame) => void>();
  const sessionEventHandlers = new Set<(event: SessionEvent) => void>();

  let criticalSweep: ReturnType<typeof setInterval> | undefined;

  function nextServerSeq(conn: TransportConnection): number {
    const seq = connOutboundSeq.get(conn.id) ?? 0;
    connOutboundSeq.set(conn.id, seq + 1);
    return seq;
  }

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
          // Abort immediately: do not invoke remaining handlers for this frame.
          // Any handler that ran before the failure will see the frame again on reconnect
          // replay (at-least-once), but continuing fanout would guarantee a duplicate for
          // handlers that have already succeeded — abort-early limits the blast radius.
          swallowError(err, { package: "gateway", operation: "onFrame" });
          throw err;
        }
      }
    }
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
    if (bytes < 0) {
      conn.close(CLOSE_CODES.ADMIN_CLOSED, "Transport send failure");
      cleanupConn(conn, "transport send failure");
      return false;
    }
    // Only charge bp when bytes > 0: the transport actually buffered data.
    // bytes === 0 means the write was accepted synchronously with nothing queued;
    // charging it would inflate bp.buffered() for traffic that was never held.
    if (bytes > 0) bp.record(conn.id, bytes);
    return true;
  }

  function cleanupConn(conn: TransportConnection, reason: string): void {
    const sessionId = sessionByConn.get(conn.id);
    // Capture before deleting: the current server outbound counter for this connection.
    const seqToSave = connOutboundSeq.get(conn.id) ?? 0;
    pendingHandshakes.delete(conn.id);
    trackers.delete(conn.id);
    msgQueues.delete(conn.id);
    inboundBufferedSeqs.delete(conn.id);
    connOutboundSeq.delete(conn.id);
    sessionByConn.delete(conn.id);
    connMap.delete(conn.id);
    bp.remove(conn.id);

    if (sessionId !== undefined) {
      connBySession.delete(sessionId);
      // Session record is intentionally retained in the store so remoteSeq survives
      // network flaps and can be restored on reconnect. Explicit purge happens in
      // destroySession() and stop() or via the disconnected-session TTL sweep.
      disconnectedAt.set(sessionId, Date.now());

      // Persist the final outbound seq so reconnects restore the correct server window.
      // processMessage only persists seq on inbound frames; gateway.send()-only traffic
      // after the last inbound frame would be lost without this on-disconnect write.
      // The guard (r.value.seq < seqToSave) avoids a no-op write when processMessage
      // already persisted an equal or higher value.
      if (seqToSave > 0) {
        const id = sessionId; // stable capture
        const persist = (async (): Promise<void> => {
          const r = await Promise.resolve(store.get(id));
          if (r.ok && r.value.seq < seqToSave) {
            await Promise.resolve(store.set({ ...r.value, seq: seqToSave }));
          }
        })()
          .catch((err: unknown) => {
            swallowError(err, { package: "gateway", operation: "disconnect.seq.persist" });
          })
          .finally(() => {
            pendingSeqPersists.delete(id);
          });
        pendingSeqPersists.set(id, persist);
      }

      // Emit 'disconnected' (not 'destroyed') — the session still exists in the store
      // and may reconnect. Reserve 'destroyed' for paths that permanently delete the record.
      emitSessionEvent({ kind: "disconnected", sessionId, reason });
    }
  }

  async function processMessage(conn: TransportConnection, data: string): Promise<void> {
    if (Buffer.byteLength(data, "utf8") > config.capabilities.maxFrameBytes) {
      // Use the connection's outbound seq counter if already authenticated so the client
      // dedup window treats this error as a distinct frame rather than a dup of seq 0.
      const errSeq = trackers.has(conn.id) ? nextServerSeq(conn) : 0;
      conn.send(
        createErrorFrame(errSeq, "FRAME_TOO_LARGE", "Frame exceeds maxFrameBytes limit", nextId),
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
        createErrorFrame(
          nextServerSeq(conn),
          "NOT_AUTHORIZED",
          "No active session; retry after reconnect",
          nextId,
        ),
      );
      return;
    }

    let sessionResult: Result<Session, KoiError>;
    try {
      sessionResult = await Promise.resolve(store.get(sessionId));
    } catch {
      sendFrame(
        conn,
        createErrorFrame(
          nextServerSeq(conn),
          "SESSION_STORE_FAILURE",
          "Session lookup failed",
          nextId,
        ),
      );
      conn.close(CLOSE_CODES.SESSION_STORE_FAILURE, "Session lookup failed");
      return;
    }
    if (!sessionResult.ok) {
      sendFrame(
        conn,
        createErrorFrame(nextServerSeq(conn), "SESSION_STORE_FAILURE", "Session not found", nextId),
      );
      conn.close(CLOSE_CODES.SESSION_STORE_FAILURE, "Session not found");
      return;
    }

    const frameResult = parseFrame(data);
    if (!frameResult.ok) {
      sendFrame(
        conn,
        createErrorFrame(
          nextServerSeq(conn),
          frameResult.error.code,
          frameResult.error.message,
          nextId,
        ),
      );
      return;
    }

    const tracker = trackers.get(conn.id);
    if (tracker === undefined) return;

    const { result, ready } = tracker.accept(frameResult.value);

    if (result === "duplicate" || result === "out_of_window") {
      // Use the server's outbound seq (not the client's) so the ack is in the correct
      // monotonic sequence space; the client's frame ID is preserved in the ref field.
      sendFrame(conn, createAckFrame(nextServerSeq(conn), frameResult.value.id, null, nextId));
      return;
    }

    if (result === "buffered") {
      // Charge buffered bytes against per-connection inbound cap AND global bp so that
      // globalBufferLimitBytes covers coordinated out-of-order inbound flooding.
      // Track per-seq so bytes are discharged precisely when a frame leaves the reorder
      // buffer (appears in ready[1..]) rather than resetting to 0 on partial progress —
      // which would allow remaining frames to escape the cap.
      const frameBytes = Buffer.byteLength(data, "utf8");
      let seqBytes = inboundBufferedSeqs.get(conn.id);
      if (seqBytes === undefined) {
        seqBytes = new Map<number, number>();
        inboundBufferedSeqs.set(conn.id, seqBytes);
      }
      seqBytes.set(frameResult.value.seq, frameBytes);
      bp.record(conn.id, frameBytes);
      // Synchronous global admission check so coordinated flooding across many
      // connections is rejected immediately rather than waiting for the 5s sweep.
      if (bp.globalUsage() > config.globalBufferLimitBytes) {
        sendFrame(
          conn,
          createErrorFrame(
            nextServerSeq(conn),
            "BUFFER_LIMIT",
            "Global inbound buffer limit exceeded",
            nextId,
          ),
        );
        conn.close(CLOSE_CODES.BUFFER_LIMIT, "Global inbound buffer limit exceeded");
        return;
      }
      let total = 0;
      for (const b of seqBytes.values()) total += b;
      if (total > config.maxBufferBytesPerConnection) {
        sendFrame(
          conn,
          createErrorFrame(
            nextServerSeq(conn),
            "BUFFER_LIMIT",
            "Inbound sequence buffer exceeded",
            nextId,
          ),
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
      let discharged = 0;
      for (const f of ready.slice(1)) {
        discharged += seqBytes.get(f.seq) ?? 0;
        seqBytes.delete(f.seq);
      }
      if (discharged > 0) bp.drain(conn.id, discharged);
      if (seqBytes.size === 0) inboundBufferedSeqs.delete(conn.id);
    }

    // Dispatch handlers BEFORE persisting the watermark. If a handler throws, emitFrames
    // re-throws and we close the connection so the advanced tracker state cannot be used
    // to accept frames past the failed one. On reconnect, remoteSeq is restored from the
    // store (which we did not update), so the failed frame is replayed (at-least-once).
    const lastDispatched = ready[ready.length - 1];
    if (lastDispatched !== undefined) {
      const sessionForHandlers: Session = {
        ...sessionResult.value,
        remoteSeq: lastDispatched.seq + 1,
      };
      try {
        emitFrames(sessionForHandlers, ready);
      } catch {
        conn.close(CLOSE_CODES.ADMIN_CLOSED, "Frame handler failure");
        cleanupConn(conn, "frame handler failure");
        return;
      }

      // Snapshot outbound seq AFTER handlers run: handlers may call gateway.send() which
      // advances connOutboundSeq; capturing before emitFrames() would persist a stale value
      // and allow reconnect to reuse already-issued seq numbers.
      const updatedSession: Session = {
        ...sessionForHandlers,
        seq: connOutboundSeq.get(conn.id) ?? 0,
      };

      let storeRes: Result<void, KoiError>;
      try {
        storeRes = await Promise.resolve(store.set(updatedSession));
      } catch {
        sendFrame(
          conn,
          createErrorFrame(
            nextServerSeq(conn),
            "SESSION_STORE_FAILURE",
            "Session update failed",
            nextId,
          ),
        );
        conn.close(CLOSE_CODES.SESSION_STORE_FAILURE, "Session update failed");
        return;
      }
      if (!storeRes.ok) {
        sendFrame(
          conn,
          createErrorFrame(
            nextServerSeq(conn),
            "SESSION_STORE_FAILURE",
            "Session update failed",
            nextId,
          ),
        );
        conn.close(CLOSE_CODES.SESSION_STORE_FAILURE, "Session update failed");
        return;
      }
    }
  }

  const transportHandler: TransportHandler = {
    onOpen(conn: TransportConnection): void {
      if (connMap.size >= config.maxConnections) {
        conn.send(
          createErrorFrame(
            nextServerSeq(conn),
            "MAX_CONNECTIONS",
            "Max connections exceeded",
            nextId,
          ),
        );
        conn.close(CLOSE_CODES.MAX_CONNECTIONS, "Max connections exceeded");
        return;
      }

      if (!bp.canAccept()) {
        conn.send(
          createErrorFrame(
            nextServerSeq(conn),
            "BUFFER_LIMIT",
            "Global buffer limit exceeded",
            nextId,
          ),
        );
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

      const handshakeChain: Promise<void> = handleHandshake(
        conn,
        deps.auth,
        config.authTimeoutMs,
        handshakeOptions,
        (handler) => {
          pendingHandshakes.set(conn.id, handler);
        },
        (abort) => {
          handshakeAborts.set(conn.id, abort);
        },
      )
        .then(async (result) => {
          pendingHandshakes.delete(conn.id);
          handshakeAborts.delete(conn.id);

          // Bail out if stop() was called while auth was in flight.
          if (stopped || !connMap.has(conn.id)) return;

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
            // Install the sever operation as the new queue tail (the "barrier") before
            // awaiting. Any message that arrives on the old socket during the drain is then
            // chained after the barrier, so it runs only AFTER sessionByConn/trackers are
            // cleared — preventing it from racing the new connection's store operations.
            // This also preserves at-least-once delivery for already-queued frames because
            // those frames run before the barrier, while the session mapping is still intact.
            savedTracker = trackers.get(prevConnId);
            const drainQueue = msgQueues.get(prevConnId) ?? Promise.resolve();
            const pId = prevConnId; // capture for closure
            const barrierDone = drainQueue.then((): void => {
              sessionByConn.delete(pId);
              trackers.delete(pId);
            });
            msgQueues.set(prevConnId, barrierDone);
            await barrierDone;
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

          // If a prior disconnect for this session fired an on-disconnect seq persist, await
          // it now so store.get() below sees the fully persisted outbound seq counter rather
          // than a stale value from the last processMessage write.
          const priorPersist = pendingSeqPersists.get(result.session.id);
          if (priorPersist !== undefined) {
            await priorPersist;
          }

          // Restore remoteSeq from any previously persisted session to prevent frame replay.
          // Distinguish NOT_FOUND (new session → start at 0) from a store exception: if the
          // store throws we cannot safely determine the replay window, so we reject the
          // reconnect rather than silently downgrading to seq 0 and risking duplicate dispatch.
          let startSeq = 0;
          let prevOutboundSeq = 0;
          // True only when the store returns NOT_FOUND: this gateway instance created
          // the record and is the rightful owner. For resumed sessions the record already
          // existed (in this process or another), so this gateway should not delete it.
          let isNewSession = true;
          try {
            const prev = await Promise.resolve(store.get(result.session.id));
            if (prev.ok) {
              startSeq = prev.value.remoteSeq;
              prevOutboundSeq = prev.value.seq;
              // Restore outbound seq so server frames continue monotonically after reconnect
              // rather than resetting to 0 and colliding with pre-reconnect frame IDs.
              connOutboundSeq.set(conn.id, prevOutboundSeq);
              isNewSession = false; // session already existed in the store
            }
            // !prev.ok (e.g. NOT_FOUND) → genuinely new session, start at 0
          } catch {
            abortReconnect(CLOSE_CODES.SESSION_STORE_FAILURE, "session store failure on resume");
            return;
          }
          const tracker = createSequenceTracker(config.dedupWindowSize);
          if (startSeq > 0) tracker.reset(startSeq);
          // Buffered out-of-order frames from the old tracker are NOT migrated: carrying them
          // into the new tracker without also transferring their inbound byte-accounting entries
          // would silently bypass the per-connection buffer cap. The client replays any
          // unacknowledged frames on reconnect, so no data is lost.
          trackers.set(conn.id, tracker);

          // Carry recovered watermarks into the persisted session so subsequent reconnects
          // restore both inbound (remoteSeq) and outbound (seq) windows correctly.
          const sessionToStore: Session =
            startSeq > 0 || prevOutboundSeq > 0
              ? { ...result.session, remoteSeq: startSeq, seq: prevOutboundSeq }
              : result.session;

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
          if (isNewSession) ownedSessionIds.add(result.session.id);
          // Clear stale disconnectedAt so TTL sweep does not evict this session now
          // that it is live again. Not clearing would race the sweep: a brief disconnect
          // followed by reconnect before TTL expiry would silently delete the live session.
          disconnectedAt.delete(result.session.id);

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
          const ackBytes = result.sendAck(nextServerSeq(conn), startSeq);
          if (ackBytes < 0) {
            // Transport rejected the ack write — session is unusable before the client
            // received its sessionId/protocol. Tear down cleanly so the client reconnects.
            conn.close(CLOSE_CODES.ADMIN_CLOSED, "Ack send failed");
            cleanupConn(conn, "ack send failed");
            return;
          }
          if (ackBytes > 0) bp.record(conn.id, ackBytes);
          emitSessionEvent({ kind: "created", session: result.session });
        })
        .catch(() => {
          pendingHandshakes.delete(conn.id);
          handshakeAborts.delete(conn.id);
          connMap.delete(conn.id);
          bp.remove(conn.id);
        });
      pendingHandshakePromises.add(handshakeChain);
      void handshakeChain.finally(() => {
        pendingHandshakePromises.delete(handshakeChain);
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
        // Backpressure shedding: drop connections that are individually over-budget or
        // that collectively push global usage over the cap.
        const globalOverLimit = !bp.canAccept();
        for (const [connId, conn] of connMap) {
          const since = bp.criticalSince(connId);
          const timedOut =
            since !== undefined && now - since > config.backpressureCriticalTimeoutMs;
          const globalShed = globalOverLimit && bp.buffered(connId) > 0;
          if (timedOut || globalShed) {
            conn.send(
              createErrorFrame(
                nextServerSeq(conn),
                "BUFFER_LIMIT",
                "Buffer limit exceeded",
                nextId,
              ),
            );
            conn.close(CLOSE_CODES.BACKPRESSURE_TIMEOUT, "Backpressure timeout");
          }
        }

        // Auth revocation: if the authenticator provides validate(), call it for each
        // live session and close any whose credentials have become invalid.
        if (deps.auth.validate !== undefined) {
          const validate = deps.auth.validate;
          for (const [connId, conn] of connMap) {
            const sessionId = sessionByConn.get(connId);
            if (sessionId === undefined) continue;
            let sessionRes: ReturnType<typeof store.get>;
            try {
              sessionRes = store.get(sessionId);
            } catch (err: unknown) {
              swallowError(err, { package: "gateway", operation: "revocation.store.get" });
              conn.close(CLOSE_CODES.AUTH_FAILED, "Revocation check failed");
              continue;
            }
            void Promise.resolve(sessionRes)
              .then((r) => {
                if (!r.ok) return;
                return Promise.resolve(validate(r.value)).then((valid) => {
                  if (!valid) {
                    conn.send(
                      createErrorFrame(
                        nextServerSeq(conn),
                        "AUTH_FAILED",
                        "Session credential revoked",
                        nextId,
                      ),
                    );
                    // Fence before close so in-flight frames received before onClose cannot
                    // pass processMessage() authorization after revocation is detected.
                    cleanupConn(conn, "Session credential revoked");
                    conn.close(CLOSE_CODES.AUTH_FAILED, "Session credential revoked");
                  }
                });
              })
              .catch((err: unknown) => {
                // Revocation check failed — close the session to avoid fail-open authorization.
                swallowError(err, { package: "gateway", operation: "revocation.validate" });
                cleanupConn(conn, "Revocation check failed");
                conn.close(CLOSE_CODES.AUTH_FAILED, "Revocation check failed");
              });
          }
        }

        // Disconnected-session TTL sweep: evict retained sessions whose credentials have
        // exceeded the configured TTL so stale remoteSeq state doesn't accumulate.
        const ttl = config.disconnectedSessionTtlMs;
        if (ttl !== undefined && ttl > 0) {
          for (const [sessionId, ts] of disconnectedAt) {
            // Skip sessions that have already reconnected — disconnectedAt.delete() is
            // called in the reconnect path, but the sweep could fire between reconnect
            // store.set() and the delete() call. Guard here as defense-in-depth.
            if (connBySession.has(sessionId)) continue;
            if (now - ts > ttl) {
              // Clear bookkeeping only after a successful delete so that a store failure
              // leaves the session in disconnectedAt for retry on the next sweep tick.
              try {
                void Promise.resolve(store.delete(sessionId))
                  .then((r) => {
                    if (r.ok) {
                      disconnectedAt.delete(sessionId);
                      ownedSessionIds.delete(sessionId);
                    }
                  })
                  .catch((err: unknown) => {
                    // Log async failure — session stays in disconnectedAt for retry on next tick.
                    swallowError(err, { package: "gateway", operation: "ttl.delete" });
                  });
              } catch (err: unknown) {
                // Sync throw: log and leave in disconnectedAt for next sweep.
                swallowError(err, { package: "gateway", operation: "ttl.delete" });
              }
            }
          }
        }
      }, 5_000);
    },

    async stop(): Promise<Result<void, KoiError>> {
      // Fence new handshakes immediately so any in-flight authenticate() that resolves
      // after this point will bail before store.set() and cannot recreate sessions.
      stopped = true;
      if (criticalSweep !== undefined) {
        clearInterval(criticalSweep);
        criticalSweep = undefined;
      }

      // Snapshot queues before closing connections. onClose → cleanupConn() deletes queue
      // entries, so we must capture references first to ensure drain includes in-flight work.
      const inflightQueues = [...msgQueues.values()];

      // Phase 1: Sever session↔conn mappings BEFORE closing sockets so that when the
      // transport delivers onClose → cleanupConn(), sessionByConn is already cleared and
      // no duplicate 'disconnected' events are emitted.
      for (const [connId, conn] of connMap) {
        const sessionId = sessionByConn.get(connId);
        sessionByConn.delete(connId);
        if (sessionId !== undefined) {
          connBySession.delete(sessionId);
          emitSessionEvent({ kind: "destroyed", sessionId, reason: "server shutdown" });
        }
        conn.close(CLOSE_CODES.SERVER_SHUTTING_DOWN, "Server shutting down");
      }

      // Abort all pending handshakes so they fail immediately rather than waiting for
      // the auth timeout. Then await the promises so stop() does not return before a
      // mid-auth continuation could call store.set() and race our session deletions.
      for (const abort of handshakeAborts.values()) abort();
      handshakeAborts.clear();
      await Promise.allSettled([...pendingHandshakePromises]);

      // Drain all in-flight per-connection message queues before touching the store so that
      // any handler currently executing can finish and its store.set() resolves cleanly.
      await Promise.allSettled(inflightQueues);
      msgQueues.clear();

      // Drain any on-disconnect seq persists from connections that closed naturally before
      // stop() was called so they cannot race the owned-session deletions below.
      await Promise.allSettled([...pendingSeqPersists.values()]);
      pendingSeqPersists.clear();

      // Phase 2: Delete only sessions owned by this gateway instance. A shared/persistent
      // store may hold sessions from other gateway processes; we must not clobber them.
      // Sessions retained for reconnect (cleanupConn keeps them) are included because
      // ownedSessionIds is populated at handshake persist time and cleared in destroySession.
      const deletePromises: Promise<Result<boolean, KoiError>>[] = [];
      for (const sessionId of ownedSessionIds) {
        deletePromises.push(Promise.resolve(store.delete(sessionId)));
      }
      ownedSessionIds.clear();
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
      connOutboundSeq.clear();
      disconnectedAt.clear();
      pendingSeqPersists.clear();
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
      // Override caller-supplied seq: the gateway owns monotonic outbound sequencing
      // so the client-side dedup window sees a single authoritative counter per connection.
      const outboundFrame: GatewayFrame = { ...frame, seq: nextServerSeq(conn) };
      const encoded = encodeFrame(outboundFrame);
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
      if (bytes < 0) {
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
      if (bytes > 0) bp.record(connId, bytes);
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
          conn.send(createErrorFrame(nextServerSeq(conn), "ADMIN_CLOSED", reason, nextId));
          conn.close(CLOSE_CODES.ADMIN_CLOSED, reason);
          // Synchronously sever routing so send() fails immediately after this
          // call resolves, rather than leaking frames until onClose() fires.
          cleanupConn(conn, reason);
        }
      }
      // Drain any in-flight processMessage that could call store.set(session) after we
      // delete the session below, which would resurrect ghost state in the store.
      await drainQueue;
      // Await any pending on-disconnect seq persist (fired by cleanupConn above) so it
      // cannot complete after store.delete() and resurrect the session in the store.
      const pendingPersist = pendingSeqPersists.get(sessionId);
      if (pendingPersist !== undefined) {
        await pendingPersist;
      }
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
      disconnectedAt.delete(sessionId);
      ownedSessionIds.delete(sessionId);
      emitSessionEvent({ kind: "destroyed", sessionId, reason });
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
