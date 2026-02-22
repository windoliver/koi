/**
 * Gateway factory: wires transport, auth, sessions, sequencing,
 * and backpressure into a single control-plane entry point.
 */

import type { KoiError, Result } from "@koi/core";
import type { GatewayAuthenticator, HandshakeOptions } from "./auth.js";
import { handleHandshake, startHeartbeatSweep } from "./auth.js";
import { createBackpressureMonitor } from "./backpressure.js";
import { buildAckFrame, buildErrorFrame, encodeFrame, parseFrame } from "./protocol.js";
import { resolveRoute } from "./routing.js";
import type { GatewayScheduler } from "./scheduler.js";
import { createScheduler } from "./scheduler.js";
import { createSequenceTracker } from "./sequence-tracker.js";
import type { SessionStore } from "./session-store.js";
import { createInMemorySessionStore } from "./session-store.js";
import type { Transport, TransportConnection } from "./transport.js";
import type { GatewayConfig, GatewayFrame, Session } from "./types.js";
import { DEFAULT_GATEWAY_CONFIG } from "./types.js";
import type { WebhookAuthenticator, WebhookServer } from "./webhook.js";
import { createWebhookServer } from "./webhook.js";

// ---------------------------------------------------------------------------
// Gateway interface
// ---------------------------------------------------------------------------

export interface Gateway {
  readonly start: (port: number) => Promise<void>;
  readonly stop: () => Promise<void>;
  readonly sessions: () => SessionStore;
  readonly onFrame: (handler: (session: Session, frame: GatewayFrame) => void) => () => void;
  readonly send: (sessionId: string, frame: GatewayFrame) => Result<number, KoiError>;
  /** Inject a frame into the dispatch pipeline with route resolution. */
  readonly dispatch: (session: Session, frame: GatewayFrame) => void;
  /** Returns the webhook server port, or undefined if webhook is not configured. */
  readonly webhookPort: () => number | undefined;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface GatewayDeps {
  readonly transport: Transport;
  readonly auth: GatewayAuthenticator;
  readonly store?: SessionStore;
  readonly webhookAuth?: WebhookAuthenticator;
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
  let webhookServer: WebhookServer | undefined;
  let scheduler: GatewayScheduler | undefined;

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
      void store.delete(sessionId);
    }
  }

  function dispatchFrame(session: Session, frame: GatewayFrame): void {
    for (const handler of frameHandlers) {
      try {
        handler(session, frame);
      } catch (_err: unknown) {
        // Isolate handler exceptions so one bad handler doesn't break others
      }
    }
  }

  async function handlePostHandshake(conn: TransportConnection, data: string): Promise<void> {
    const sessionId = sessionByConn.get(conn.id);
    if (sessionId === undefined) {
      conn.close(4007, "No session");
      cleanup(conn.id);
      return;
    }

    const sessionResult = await store.get(sessionId);
    if (!sessionResult.ok) {
      conn.close(4008, "Session not found");
      cleanup(conn.id);
      return;
    }
    const session = sessionResult.value;

    // Check backpressure before processing
    const bpState = bp.state(conn.id);
    if (bpState === "critical") {
      const criticalAt = bp.criticalSince(conn.id);
      if (
        criticalAt !== undefined &&
        Date.now() - criticalAt > config.backpressureCriticalTimeoutMs
      ) {
        closeConnection(conn.id, 4009, "Backpressure timeout");
        return;
      }
      // Drop frame while in critical state
      return;
    }

    const result = parseFrame(data);
    if (!result.ok) {
      conn.send(buildErrorFrame(session.seq, result.error.code, result.error.message));
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
      conn.send(buildAckFrame(session.seq, frame.id));
      return;
    }

    if (acceptance.result === "out_of_window") {
      conn.send(buildErrorFrame(session.seq, "VALIDATION", "Sequence out of window"));
      return;
    }

    // Resolve route once per batch — routing context doesn't change within a batch
    const resolved = resolveRoute(config.routing, session.routing, session.agentId);
    const baseAgentId = resolved.agentId;

    // Process all ready frames (in order) with immutable session updates
    let currentSession = session;
    for (const readyFrame of acceptance.ready) {
      const routedSession =
        baseAgentId !== currentSession.agentId
          ? {
              ...currentSession,
              agentId: baseAgentId,
              remoteSeq: readyFrame.seq,
              lastHeartbeat: Date.now(),
            }
          : { ...currentSession, remoteSeq: readyFrame.seq, lastHeartbeat: Date.now() };
      currentSession = routedSession;
      await store.set(currentSession);
      dispatchFrame(currentSession, readyFrame);
      conn.send(buildAckFrame(currentSession.seq, readyFrame.id));
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

          // Build handshake options from config + runtime state
          const handshakeOptions: HandshakeOptions = {
            minProtocolVersion: config.minProtocolVersion,
            maxProtocolVersion: config.maxProtocolVersion,
            capabilities: config.capabilities,
            ...(config.includeSnapshot
              ? {
                  snapshot: {
                    serverTime: Date.now(),
                    activeConnections: deps.transport.connections(),
                  },
                }
              : {}),
          };

          // Start auth handshake
          void handleHandshake(
            conn,
            deps.auth,
            config.authTimeoutMs,
            handshakeOptions,
            (handler) => {
              pendingHandshakes.set(conn.id, handler);
            },
          ).then(
            async ({ session }) => {
              pendingHandshakes.delete(conn.id);
              await store.set(session);
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
          const handshakeHandler = pendingHandshakes.get(conn.id);
          if (handshakeHandler !== undefined) {
            handshakeHandler(data);
            return;
          }
          void handlePostHandshake(conn, data);
        },

        onClose(conn: TransportConnection): void {
          cleanup(conn.id);
        },

        onDrain(conn: TransportConnection): void {
          bp.drain(conn.id, config.maxBufferBytesPerConnection);
        },
      });

      // Start webhook server if configured
      if (config.webhookPort !== undefined) {
        webhookServer = createWebhookServer(
          { port: config.webhookPort, pathPrefix: config.webhookPath ?? "/webhook" },
          (session, frame) => {
            const resolved = resolveRoute(config.routing, session.routing, session.agentId);
            const routedSession =
              resolved.agentId !== session.agentId
                ? { ...session, agentId: resolved.agentId }
                : session;
            dispatchFrame(routedSession, frame);
          },
          deps.webhookAuth,
        );
        await webhookServer.start();
      }

      // Start schedulers if configured
      if (config.schedulers !== undefined && config.schedulers.length > 0) {
        scheduler = createScheduler(config.schedulers, (session, frame) => {
          dispatchFrame(session, frame);
        });
        scheduler.start();
      }
    },

    async stop(): Promise<void> {
      scheduler?.stop();
      webhookServer?.stop();
      stopSweep?.();
      // Best-effort graceful close
      for (const conn of connMap.values()) {
        conn.close(1001, "Server shutting down");
      }
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

    dispatch(session: Session, frame: GatewayFrame): void {
      const resolved = resolveRoute(config.routing, session.routing, session.agentId);
      const routedSession =
        resolved.agentId !== session.agentId ? { ...session, agentId: resolved.agentId } : session;
      dispatchFrame(routedSession, frame);
    },

    webhookPort(): number | undefined {
      return webhookServer?.port();
    },
  };
}
