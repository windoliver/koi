/**
 * Gateway factory: wires transport, auth, sessions, sequencing,
 * and backpressure into a single control-plane entry point.
 */

import type { KoiError, Result } from "@koi/core";
import type { GatewayAuthenticator } from "./auth.js";
import { handleHandshake, startHeartbeatSweep } from "./auth.js";
import { createBackpressureMonitor } from "./backpressure.js";
import { encodeFrame, parseFrame } from "./protocol.js";
import { createSequenceTracker } from "./sequence-tracker.js";
import type { SessionStore } from "./session-store.js";
import { createInMemorySessionStore } from "./session-store.js";
import type { Transport, TransportConnection } from "./transport.js";
import type { GatewayConfig, GatewayFrame, Session } from "./types.js";
import { DEFAULT_GATEWAY_CONFIG } from "./types.js";

// ---------------------------------------------------------------------------
// Gateway interface
// ---------------------------------------------------------------------------

export interface Gateway {
  readonly start: (port: number) => Promise<void>;
  readonly stop: () => Promise<void>;
  readonly sessions: () => SessionStore;
  readonly onFrame: (handler: (session: Session, frame: GatewayFrame) => void) => () => void;
  readonly send: (sessionId: string, frame: GatewayFrame) => Result<number, KoiError>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface GatewayDeps {
  readonly transport: Transport;
  readonly auth: GatewayAuthenticator;
  readonly store?: SessionStore;
}

export function createGateway(configOverrides: Partial<GatewayConfig>, deps: GatewayDeps): Gateway {
  const config: GatewayConfig = { ...DEFAULT_GATEWAY_CONFIG, ...configOverrides };
  const store = deps.store ?? createInMemorySessionStore();
  const bp = createBackpressureMonitor(config);

  // Per-connection state (mutable internal, not exposed)
  const connMap = new Map<string, TransportConnection>();
  const sessionByConn = new Map<string, string>(); // connId → sessionId
  const connBySession = new Map<string, string>(); // sessionId → connId
  const trackers = new Map<string, ReturnType<typeof createSequenceTracker>>();
  const pendingHandshakes = new Map<string, (data: string) => void>();

  const frameHandlers = new Set<(session: Session, frame: GatewayFrame) => void>();
  let stopSweep: (() => void) | undefined;

  function closeConnection(connId: string, code: number, reason: string): void {
    const conn = connMap.get(connId);
    if (conn !== undefined) {
      conn.close(code, reason);
    }
    cleanup(connId);
  }

  function cleanup(connId: string): void {
    const sessionId = sessionByConn.get(connId);
    sessionByConn.delete(connId);
    connMap.delete(connId);
    pendingHandshakes.delete(connId);
    bp.remove(connId);
    if (sessionId !== undefined) {
      connBySession.delete(sessionId);
      trackers.delete(sessionId);
    }
  }

  function dispatchFrame(session: Session, frame: GatewayFrame): void {
    for (const handler of frameHandlers) {
      handler(session, frame);
    }
  }

  return {
    async start(port: number): Promise<void> {
      stopSweep = startHeartbeatSweep(
        store,
        deps.auth,
        config.heartbeatIntervalMs,
        config.sweepIntervalMs,
        (sessionId: string) => {
          const connId = connBySession.get(sessionId);
          if (connId !== undefined) {
            closeConnection(connId, 4004, "Session expired");
          }
        },
      );

      await deps.transport.listen(port, {
        onOpen(conn: TransportConnection): void {
          // Reject if at capacity
          if (deps.transport.connections() > config.maxConnections) {
            conn.close(4005, "Max connections exceeded");
            return;
          }
          if (!bp.canAccept()) {
            conn.close(4006, "Global buffer limit exceeded");
            return;
          }

          connMap.set(conn.id, conn);

          // Start auth handshake
          void handleHandshake(
            conn,
            deps.auth,
            config.authTimeoutMs,
            config.protocolVersion,
            (handler) => {
              pendingHandshakes.set(conn.id, handler);
            },
          ).then(
            ({ session }) => {
              pendingHandshakes.delete(conn.id);
              store.set(session);
              sessionByConn.set(conn.id, session.id);
              connBySession.set(session.id, conn.id);
              trackers.set(session.id, createSequenceTracker(config.dedupWindowSize));
            },
            () => {
              // Auth failed — connection already closed by handleHandshake
              cleanup(conn.id);
            },
          );
        },

        onMessage(conn: TransportConnection, data: string): void {
          // If still in handshake phase, forward to handshake handler
          const handshakeHandler = pendingHandshakes.get(conn.id);
          if (handshakeHandler !== undefined) {
            handshakeHandler(data);
            return;
          }

          const sessionId = sessionByConn.get(conn.id);
          if (sessionId === undefined) {
            conn.close(4007, "No session");
            cleanup(conn.id);
            return;
          }

          const session = store.get(sessionId);
          if (session === undefined) {
            conn.close(4008, "Session not found");
            cleanup(conn.id);
            return;
          }

          // Check backpressure before processing
          const bpState = bp.state(conn.id);
          if (bpState === "critical") {
            const criticalAt = bp.criticalSince(conn.id);
            if (criticalAt !== undefined && Date.now() - criticalAt > 30_000) {
              closeConnection(conn.id, 4009, "Backpressure timeout");
              return;
            }
            // Drop frame while in critical state
            return;
          }

          const result = parseFrame(data);
          if (!result.ok) {
            const errorFrame = encodeFrame({
              kind: "error",
              id: crypto.randomUUID(),
              seq: session.seq,
              timestamp: Date.now(),
              payload: { code: result.error.code, message: result.error.message },
            });
            conn.send(errorFrame);
            return;
          }

          const frame = result.value;

          // Track buffer usage
          bp.record(conn.id, data.length);

          // Sequence tracking
          const tracker = trackers.get(sessionId);
          if (tracker === undefined) return;

          const acceptance = tracker.accept(frame);

          if (acceptance.result === "duplicate") {
            // Send ack for duplicate (idempotent)
            const ackFrame = encodeFrame({
              kind: "ack",
              id: crypto.randomUUID(),
              seq: session.seq,
              ref: frame.id,
              timestamp: Date.now(),
              payload: null,
            });
            conn.send(ackFrame);
            return;
          }

          if (acceptance.result === "out_of_window") {
            const errorFrame = encodeFrame({
              kind: "error",
              id: crypto.randomUUID(),
              seq: session.seq,
              timestamp: Date.now(),
              payload: { code: "VALIDATION", message: "Sequence out of window" },
            });
            conn.send(errorFrame);
            return;
          }

          // Process all ready frames (in order)
          for (const readyFrame of acceptance.ready) {
            // Update session's remoteSeq
            store.set({ ...session, remoteSeq: readyFrame.seq, lastHeartbeat: Date.now() });
            dispatchFrame(session, readyFrame);

            // Send ack
            const ackFrame = encodeFrame({
              kind: "ack",
              id: crypto.randomUUID(),
              seq: session.seq,
              ref: readyFrame.id,
              timestamp: Date.now(),
              payload: null,
            });
            conn.send(ackFrame);
          }
        },

        onClose(conn: TransportConnection): void {
          cleanup(conn.id);
        },

        onDrain(conn: TransportConnection): void {
          bp.drain(conn.id, config.maxBufferPerConnection);
        },
      });
    },

    async stop(): Promise<void> {
      stopSweep?.();
      deps.transport.close();
      connMap.clear();
      sessionByConn.clear();
      connBySession.clear();
      trackers.clear();
      pendingHandshakes.clear();
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
        return {
          ok: false,
          error: { code: "NOT_FOUND", message: "Session not connected", retryable: false },
        };
      }

      const conn = connMap.get(connId);
      if (conn === undefined) {
        return {
          ok: false,
          error: { code: "NOT_FOUND", message: "Connection not found", retryable: false },
        };
      }

      const encoded = encodeFrame(frame);
      const sendResult = conn.send(encoded);

      if (sendResult === 0) {
        return {
          ok: false,
          error: {
            code: "INTERNAL",
            message: "Send dropped (connection closed)",
            retryable: false,
          },
        };
      }

      if (sendResult === -1) {
        bp.record(connId, encoded.length);
      }

      return { ok: true, value: sendResult };
    },
  };
}
