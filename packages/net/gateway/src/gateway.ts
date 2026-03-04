/**
 * Gateway factory: wires transport, auth, sessions, sequencing,
 * backpressure, node registry, session resume, and channel binding
 * into a single control-plane entry point.
 */

import type { KoiError, Result } from "@koi/core";
import { notFound } from "@koi/core";
import { swallowError } from "@koi/errors";
import type { GatewayAuthenticator, HandshakeOptions } from "./auth.js";
import { handleHandshake, startHeartbeatSweep } from "./auth.js";
import { createBackpressureMonitor } from "./backpressure.js";
import { createNodeConnectionHandler } from "./node-connection.js";
import type { NodeFrame } from "./node-handler.js";
import { peekFrameKind } from "./node-handler.js";
import type { NodeRegistry, NodeRegistryEvent } from "./node-registry.js";
import { createInMemoryNodeRegistry } from "./node-registry.js";
import type { FrameIdGenerator } from "./protocol.js";
import {
  createAckFrame,
  createErrorFrame,
  createFrameIdGenerator,
  encodeFrame,
  parseFrame,
} from "./protocol.js";
import { resolveRoute } from "./routing.js";
import type { GatewayScheduler } from "./scheduler.js";
import { createScheduler } from "./scheduler.js";
import type { SequenceTracker } from "./sequence-tracker.js";
import { createSequenceTracker } from "./sequence-tracker.js";
import type { SessionStore } from "./session-store.js";
import { createInMemorySessionStore } from "./session-store.js";
import type { ToolRouter } from "./tool-router.js";
import { createToolRouter, DEFAULT_TOOL_ROUTING_CONFIG } from "./tool-router.js";
import type { Transport, TransportConnection } from "./transport.js";
import type { GatewayConfig, GatewayFrame, Session } from "./types.js";
import { DEFAULT_GATEWAY_CONFIG } from "./types.js";

// ---------------------------------------------------------------------------
// Session events
// ---------------------------------------------------------------------------

export type SessionEvent =
  | { readonly kind: "created"; readonly session: Session }
  | { readonly kind: "resumed"; readonly session: Session; readonly pendingFrameCount: number }
  | { readonly kind: "destroyed"; readonly sessionId: string; readonly reason: string }
  | { readonly kind: "expired"; readonly sessionId: string };

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
  /** Access the node registry for tool/node management. */
  readonly nodeRegistry: () => NodeRegistry;
  /** Subscribe to node lifecycle events. Returns unsubscribe function. */
  readonly onNodeEvent: (handler: (event: NodeRegistryEvent) => void) => () => void;
  /** Force-destroy a session by ID. */
  readonly destroySession: (sessionId: string, reason?: string) => Result<void, KoiError>;
  /** Subscribe to session lifecycle events. Returns unsubscribe function. */
  readonly onSessionEvent: (handler: (event: SessionEvent) => void) => () => void;
  /** Bind a channel name to a specific agent ID at runtime. */
  readonly bindChannel: (channelName: string, agentId: string) => void;
  /** Remove a channel-to-agent binding. Returns true if binding existed. */
  readonly unbindChannel: (channelName: string) => boolean;
  /** Snapshot of current channel bindings. */
  readonly channelBindings: () => ReadonlyMap<string, string>;
  /** Send a NodeFrame to a connected compute node. */
  readonly sendToNode: (nodeId: string, frame: NodeFrame) => Result<number, KoiError>;
  /**
   * Send a POSIX-style signal to a specific agent on whichever node hosts it.
   * Requires the agent's nodeId to be known (populated from agent:status frames).
   */
  readonly signalAgent: (
    agentId: string,
    signal: string,
    gracePeriodMs?: number,
  ) => Result<number, KoiError>;
  /**
   * Fan-out a signal to all active agents in a process group.
   * Finds every node hosting at least one group member and sends agent:signal_group.
   */
  readonly signalGroup: (
    groupId: string,
    signal: string,
    options?: { readonly deadlineMs?: number },
  ) => Result<readonly string[], KoiError>;
  /**
   * Wait for a specific agent to reach "terminated" state.
   * Resolves with the exit code from the terminal agent:status frame.
   * Rejects if timeoutMs is exceeded (default: 60 000 ms).
   */
  readonly waitForAgent: (
    agentId: string,
    timeoutMs?: number,
  ) => Promise<{ readonly agentId: string; readonly exitCode: number }>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface GatewayDeps {
  readonly transport: Transport;
  readonly auth: GatewayAuthenticator;
  readonly store?: SessionStore;
}

/** Maximum frames buffered per disconnected session to prevent memory exhaustion. */
const MAX_PENDING_FRAMES = 1_000;

/** Disconnected session state kept alive during TTL window. */
interface DisconnectedSession {
  readonly timer: ReturnType<typeof setTimeout>;
  readonly tracker: SequenceTracker;
  /** Mutable buffer — encapsulated internal state, never shared outside cleanup()/send(). */
  readonly pendingFrames: GatewayFrame[];
}

export function createGateway(configOverrides: Partial<GatewayConfig>, deps: GatewayDeps): Gateway {
  const config: GatewayConfig = { ...DEFAULT_GATEWAY_CONFIG, ...configOverrides };
  const store = deps.store ?? createInMemorySessionStore();
  const bp = createBackpressureMonitor(config);
  const nextId: FrameIdGenerator = createFrameIdGenerator();
  const registry = createInMemoryNodeRegistry();

  // Tool routing (opt-in via config.toolRouting)
  // let: set once at construction, cleared in stop()
  let toolRouter: ToolRouter | undefined;

  // Per-connection state (mutable internal, not exposed)
  const connMap = new Map<string, TransportConnection>();
  const sessionByConn = new Map<string, string>(); // connId → sessionId
  const connBySession = new Map<string, string>(); // sessionId → connId
  const trackers = new Map<string, SequenceTracker>();
  const pendingHandshakes = new Map<string, (data: string) => void>();

  // Session resume: disconnected sessions kept alive during TTL
  const disconnected = new Map<string, DisconnectedSession>();

  // Channel bindings: channelName → agentId
  const channelBindingMap = new Map<string, string>();

  // Event handlers
  const frameHandlers = new Set<(session: Session, frame: GatewayFrame) => void>();
  const nodeEventHandlers = new Set<(event: NodeRegistryEvent) => void>();
  const sessionEventHandlers = new Set<(event: SessionEvent) => void>();

  // let: assigned in start(), cleared in stop()
  let stopSweep: (() => void) | undefined;
  let stopNodeSweep: (() => void) | undefined;
  let scheduler: GatewayScheduler | undefined;

  // Populate static channel bindings from config
  if (config.channelBindings !== undefined) {
    for (const binding of config.channelBindings) {
      channelBindingMap.set(binding.channelName, binding.agentId);
    }
  }

  // Effective capabilities: enable resumption if TTL > 0
  const effectiveCapabilities =
    config.sessionTtlMs > 0 ? { ...config.capabilities, resumption: true } : config.capabilities;

  function emitSessionEvent(event: SessionEvent): void {
    for (const handler of sessionEventHandlers) {
      try {
        handler(event);
      } catch (err: unknown) {
        swallowError(err, { package: "gateway", operation: "onSessionEvent" });
      }
    }
  }

  // Node connection handler (extracted module)
  function emitNodeEvent(event: NodeRegistryEvent): void {
    for (const handler of nodeEventHandlers) {
      try {
        handler(event);
      } catch (err: unknown) {
        swallowError(err, { package: "gateway", operation: "onNodeEvent" });
      }
    }
  }
  const nodeHandler = createNodeConnectionHandler(
    registry,
    emitNodeEvent,
    (connId: string) => {
      const conn = connMap.get(connId);
      if (conn !== undefined) {
        conn.close(4014, "Replaced by reconnecting node");
      }
      // Note: cleanupNode already called by the handler before onEvict
      connMap.delete(connId);
      pendingHandshakes.delete(connId);
      bp.remove(connId);
    },
    // Tool routing callback — only wired when tool routing is enabled
    config.toolRouting !== undefined
      ? (frame: NodeFrame) => {
          if (toolRouter === undefined) return;
          switch (frame.kind) {
            case "tool_call":
              toolRouter.handleToolCall(frame);
              break;
            case "tool_result":
              toolRouter.handleToolResult(frame);
              break;
            case "tool_error":
              toolRouter.handleToolError(frame);
              break;
          }
        }
      : undefined,
    // Tools updated callback — drain queued calls when node advertises new tools
    config.toolRouting !== undefined
      ? (nodeId: string) => {
          toolRouter?.handleToolsUpdated(nodeId);
        }
      : undefined,
  );

  // Initialize tool router after nodeHandler (needs sendToNode)
  if (config.toolRouting !== undefined) {
    toolRouter = createToolRouter(
      { ...DEFAULT_TOOL_ROUTING_CONFIG, ...config.toolRouting },
      {
        registry,
        sendToNode: (nodeId, frame) => nodeHandler.sendToNode(nodeId, frame, connMap),
      },
    );

    nodeEventHandlers.add((event: NodeRegistryEvent) => {
      if (toolRouter === undefined) return;
      if (event.kind === "deregistered") {
        toolRouter.handleNodeDisconnect(event.nodeId);
      }
      if (event.kind === "registered") {
        toolRouter.handleNodeRegistered(event.node.nodeId);
      }
    });
  }

  function closeConnection(connId: string, code: number, reason: string): void {
    const conn = connMap.get(connId);
    if (conn !== undefined) {
      conn.close(code, reason);
    }
    cleanup(connId);
  }

  function cleanup(connId: string): void {
    // Node connection cleanup (delegated to extracted handler)
    if (nodeHandler.cleanupNode(connId)) {
      connMap.delete(connId);
      pendingHandshakes.delete(connId);
      bp.remove(connId);
      return; // Node connections don't have sessions
    }

    const sessionId = sessionByConn.get(connId);
    sessionByConn.delete(connId);
    connMap.delete(connId);
    pendingHandshakes.delete(connId);
    bp.remove(connId);
    if (sessionId !== undefined) {
      connBySession.delete(sessionId);

      // If session resume is enabled, keep session alive during TTL window
      if (config.sessionTtlMs > 0) {
        const tracker = trackers.get(sessionId);
        if (tracker !== undefined) {
          trackers.delete(sessionId);
          const timer = setTimeout(() => {
            disconnected.delete(sessionId);
            trackers.delete(sessionId);
            void Promise.resolve(store.delete(sessionId)).then((result) => {
              if (!result.ok) {
                swallowError(result.error, { package: "gateway", operation: "store.delete" });
              }
            });
            emitSessionEvent({ kind: "expired", sessionId });
          }, config.sessionTtlMs);
          disconnected.set(sessionId, { timer, tracker, pendingFrames: [] });
        }
        return;
      }

      // Immediate cleanup (no TTL)
      trackers.delete(sessionId);
      void Promise.resolve(store.delete(sessionId)).then((result) => {
        if (!result.ok) {
          swallowError(result.error, { package: "gateway", operation: "store.delete" });
        }
      });
    }
  }

  function dispatchFrame(session: Session, frame: GatewayFrame): void {
    for (const handler of frameHandlers) {
      try {
        handler(session, frame);
      } catch (err: unknown) {
        swallowError(err, { package: "gateway", operation: "dispatchFrame" });
      }
    }
  }

  /** Resolve route and dispatch a frame — shared by post-handshake, webhook, and dispatch(). */
  function resolveAndDispatch(session: Session, frame: GatewayFrame): void {
    const resolved = resolveRoute(
      config.routing,
      session.routing,
      session.agentId,
      channelBindingMap.size > 0 ? channelBindingMap : undefined,
    );
    const routedSession =
      resolved.agentId !== session.agentId ? { ...session, agentId: resolved.agentId } : session;
    dispatchFrame(routedSession, frame);
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
      conn.send(createErrorFrame(session.seq, result.error.code, result.error.message, nextId));
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
      conn.send(createAckFrame(session.seq, frame.id, undefined, nextId));
      return;
    }

    if (acceptance.result === "out_of_window") {
      conn.send(createErrorFrame(session.seq, "VALIDATION", "Sequence out of window", nextId));
      return;
    }

    // Resolve route once per batch
    const resolved = resolveRoute(
      config.routing,
      session.routing,
      session.agentId,
      channelBindingMap.size > 0 ? channelBindingMap : undefined,
    );
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
      dispatchFrame(currentSession, readyFrame);
      conn.send(createAckFrame(currentSession.seq, readyFrame.id, undefined, nextId));
    }
    // Persist final session state once
    if (acceptance.ready.length > 0) {
      const setResult = await store.set(currentSession);
      if (!setResult.ok) {
        swallowError(setResult.error, { package: "gateway", operation: "store.set" });
        closeConnection(conn.id, 4008, "Session store failure");
      }
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

      stopNodeSweep = nodeHandler.startNodeSweep(
        config.nodeHeartbeatTimeoutMs,
        config.sweepIntervalMs,
        (nodeId: string, connId: string) => {
          closeConnection(connId, 4013, `Node heartbeat expired: ${nodeId}`);
        },
      );

      await deps.transport.listen(port, {
        onOpen(conn: TransportConnection): void {
          if (deps.transport.connections() > config.maxConnections) {
            conn.close(4005, "Max connections exceeded");
            return;
          }
          if (!bp.canAccept()) {
            conn.close(4006, "Global buffer limit exceeded");
            return;
          }

          connMap.set(conn.id, conn);

          // First-message router: peek at `kind` to distinguish clients from nodes
          const authTimer = setTimeout(() => {
            if (pendingHandshakes.has(conn.id)) {
              pendingHandshakes.delete(conn.id);
              conn.close(4001, "Auth timeout");
              cleanup(conn.id);
            }
          }, config.authTimeoutMs);

          pendingHandshakes.set(conn.id, (data: string) => {
            clearTimeout(authTimer);
            pendingHandshakes.delete(conn.id);

            const kind = peekFrameKind(data);

            if (kind === "connect") {
              // Client path: delegate to handleHandshake, feeding data via onMessage callback
              void handleHandshake(
                conn,
                deps.auth,
                config.authTimeoutMs,
                {
                  minProtocolVersion: config.minProtocolVersion,
                  maxProtocolVersion: config.maxProtocolVersion,
                  capabilities: effectiveCapabilities,
                  ...(config.includeSnapshot
                    ? {
                        snapshot: {
                          serverTime: Date.now(),
                          activeConnections: deps.transport.connections(),
                        },
                      }
                    : {}),
                } satisfies HandshakeOptions,
                (handler) => {
                  // Feed the already-received data immediately
                  handler(data);
                },
              ).then(
                async ({ session, connectFrame }) => {
                  // --- Session resume path ---
                  if (connectFrame.resume !== undefined) {
                    const { sessionId } = connectFrame.resume;
                    const disc = disconnected.get(sessionId);
                    if (disc === undefined) {
                      conn.send(
                        createErrorFrame(
                          0,
                          "SESSION_EXPIRED",
                          "Session not found or expired",
                          nextId,
                        ),
                      );
                      conn.close(4011, "Session expired");
                      cleanup(conn.id);
                      return;
                    }

                    clearTimeout(disc.timer);
                    disconnected.delete(sessionId);
                    trackers.set(sessionId, disc.tracker);
                    sessionByConn.set(conn.id, sessionId);
                    connBySession.set(sessionId, conn.id);

                    const pending = disc.pendingFrames;
                    for (const pendingFrame of pending) {
                      conn.send(encodeFrame(pendingFrame));
                    }

                    const existingSession = await store.get(sessionId);
                    if (existingSession.ok) {
                      emitSessionEvent({
                        kind: "resumed",
                        session: existingSession.value,
                        pendingFrameCount: pending.length,
                      });
                    }
                    return;
                  }

                  // --- Normal (new session) path ---
                  const setResult = await store.set(session);
                  if (!setResult.ok) {
                    swallowError(setResult.error, { package: "gateway", operation: "store.set" });
                    conn.close(4008, "Session store failure");
                    cleanup(conn.id);
                    return;
                  }
                  sessionByConn.set(conn.id, session.id);
                  connBySession.set(session.id, conn.id);
                  trackers.set(session.id, createSequenceTracker(config.dedupWindowSize));
                  emitSessionEvent({ kind: "created", session });
                },
                () => {
                  cleanup(conn.id);
                },
              );
              return;
            }

            if (kind?.startsWith("node:")) {
              // Node path
              nodeHandler.handleFirstMessage(conn, data);
              return;
            }

            // Unknown first message
            conn.close(4002, "Invalid first message: unrecognized kind");
            cleanup(conn.id);
          });
        },

        onMessage(conn: TransportConnection, data: string): void {
          const handshakeHandler = pendingHandshakes.get(conn.id);
          if (handshakeHandler !== undefined) {
            handshakeHandler(data);
            return;
          }
          // Node messages
          if (nodeHandler.isNodeConnection(conn.id)) {
            nodeHandler.handleMessage(conn, data);
            return;
          }
          // Client messages
          void handlePostHandshake(conn, data);
        },

        onClose(conn: TransportConnection): void {
          cleanup(conn.id);
        },

        onDrain(conn: TransportConnection): void {
          bp.drain(conn.id, config.maxBufferBytesPerConnection);
        },
      });

      // Start schedulers if configured
      if (config.schedulers !== undefined && config.schedulers.length > 0) {
        scheduler = createScheduler(config.schedulers, resolveAndDispatch);
        scheduler.start();
      }
    },

    async stop(): Promise<void> {
      toolRouter?.dispose();
      toolRouter = undefined;
      scheduler?.stop();
      stopSweep?.();
      stopNodeSweep?.();
      // Clean up TTL timers
      for (const disc of disconnected.values()) {
        clearTimeout(disc.timer);
      }
      disconnected.clear();
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
      nodeHandler.clear();
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
      // If session is disconnected but within TTL, buffer the frame
      const disc = disconnected.get(sessionId);
      if (disc !== undefined) {
        if (disc.pendingFrames.length >= MAX_PENDING_FRAMES) {
          return {
            ok: false,
            error: {
              code: "VALIDATION",
              message: `Pending frame limit exceeded (${MAX_PENDING_FRAMES})`,
              retryable: false,
            },
          };
        }
        disc.pendingFrames.push(frame);
        return { ok: true, value: 0 };
      }

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
      resolveAndDispatch(session, frame);
    },

    nodeRegistry(): NodeRegistry {
      return registry;
    },

    onNodeEvent(handler: (event: NodeRegistryEvent) => void): () => void {
      nodeEventHandlers.add(handler);
      return () => {
        nodeEventHandlers.delete(handler);
      };
    },

    destroySession(sessionId: string, reason = "destroyed"): Result<void, KoiError> {
      // Check if it's a disconnected session first
      const disc = disconnected.get(sessionId);
      if (disc !== undefined) {
        clearTimeout(disc.timer);
        disconnected.delete(sessionId);
        void Promise.resolve(store.delete(sessionId)).then((result) => {
          if (!result.ok) {
            swallowError(result.error, { package: "gateway", operation: "store.delete" });
          }
        });
        emitSessionEvent({ kind: "destroyed", sessionId, reason });
        return { ok: true, value: undefined };
      }

      const connId = connBySession.get(sessionId);
      if (connId === undefined) {
        return {
          ok: false,
          error: {
            code: "NOT_FOUND",
            message: `Session not found: ${sessionId}`,
            retryable: false,
          },
        };
      }
      closeConnection(connId, 4012, reason);
      emitSessionEvent({ kind: "destroyed", sessionId, reason });
      return { ok: true, value: undefined };
    },

    onSessionEvent(handler: (event: SessionEvent) => void): () => void {
      sessionEventHandlers.add(handler);
      return () => {
        sessionEventHandlers.delete(handler);
      };
    },

    bindChannel(channelName: string, agentId: string): void {
      channelBindingMap.set(channelName, agentId);
    },

    unbindChannel(channelName: string): boolean {
      return channelBindingMap.delete(channelName);
    },

    channelBindings(): ReadonlyMap<string, string> {
      return channelBindingMap;
    },

    sendToNode(nodeId: string, frame: NodeFrame): Result<number, KoiError> {
      return nodeHandler.sendToNode(nodeId, frame, connMap);
    },

    signalAgent(agentId: string, signal: string, gracePeriodMs?: number): Result<number, KoiError> {
      const nodeId = nodeHandler.lookupAgentNode(agentId);
      if (nodeId === undefined) {
        return { ok: false, error: notFound(agentId, `No node hosting agent: ${agentId}`) };
      }
      return nodeHandler.sendToNode(
        nodeId,
        {
          nodeId,
          agentId,
          correlationId: `sig-${agentId}-${String(Date.now())}`,
          kind: "agent:signal",
          payload: {
            signal,
            ...(gracePeriodMs !== undefined ? { gracePeriodMs } : {}),
          },
        },
        connMap,
      );
    },

    signalGroup(
      groupId: string,
      signal: string,
      options?: { readonly deadlineMs?: number },
    ): Result<readonly string[], KoiError> {
      const agentIds = nodeHandler.lookupAgentsByGroup(groupId);
      if (agentIds.length === 0) {
        return { ok: true, value: [] };
      }

      // Find unique nodes hosting agents in this group
      const nodeIds = new Set<string>();
      for (const agentId of agentIds) {
        const nodeId = nodeHandler.lookupAgentNode(agentId);
        if (nodeId !== undefined) nodeIds.add(nodeId);
      }

      for (const nodeId of nodeIds) {
        nodeHandler.sendToNode(
          nodeId,
          {
            nodeId,
            agentId: "",
            correlationId: `siggrp-${groupId}-${String(Date.now())}`,
            kind: "agent:signal_group",
            payload: {
              groupId,
              signal,
              ...(options?.deadlineMs !== undefined ? { deadlineMs: options.deadlineMs } : {}),
            },
          },
          connMap,
        );
      }

      return { ok: true, value: agentIds };
    },

    waitForAgent(
      agentId: string,
      timeoutMs = 60_000,
    ): Promise<{ readonly agentId: string; readonly exitCode: number }> {
      return new Promise((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        let unsub: (() => void) | undefined;

        const cleanup = (): void => {
          if (timer !== undefined) clearTimeout(timer);
          unsub?.();
        };

        unsub = nodeHandler.onAgentStatus((entry) => {
          if (entry.agentId !== agentId) return;
          if (entry.state === "terminated") {
            cleanup();
            resolve({ agentId, exitCode: entry.exitCode ?? 1 });
          }
        });

        timer = setTimeout(() => {
          unsub?.();
          reject(new Error(`waitForAgent timeout after ${String(timeoutMs)}ms: ${agentId}`));
        }, timeoutMs);
      });
    },
  };
}
