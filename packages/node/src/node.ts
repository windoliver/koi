/**
 * createNode() — main entry point for the Koi Node runtime.
 *
 * Parses config → parallel startup [connect, mDNS, tools] → returns KoiNode handle.
 * The Node is a stateless host — agent state lives in Engine/Components.
 */

import type {
  Agent,
  AgentManifest,
  ComponentProvider,
  DelegationScope,
  EngineAdapter,
  KoiError,
  ProcessId,
  Result,
  ScopeChecker,
  SessionCheckpoint,
  SessionRecord,
} from "@koi/core";
import type { AgentHost } from "./agent/host.js";
import { createAgentHost } from "./agent/host.js";
import type { StatusReporter } from "./agent/status.js";
import { createStatusReporter } from "./agent/status.js";
import type { CheckpointManager } from "./checkpoint.js";
import { createCheckpointManager } from "./checkpoint.js";
import { createCheckpointingEngine } from "./checkpointing-engine.js";
import { generateCorrelationId } from "./connection/protocol.js";
import { createTransport } from "./connection/transport.js";
import type { DeliveryManager } from "./delivery-manager.js";
import { createDeliveryManager } from "./delivery-manager.js";
import { createDiscoveryService } from "./discovery.js";
import { createFrameCounters } from "./frame-counter.js";
import { createFrameDeduplicator } from "./frame-dedup.js";
import { createMemoryMonitor } from "./monitor.js";
import type { ShutdownHandler } from "./shutdown.js";
import { createShutdownHandler } from "./shutdown.js";
import { handleToolCall as handleToolCallImpl } from "./tool-call-handler.js";
import type { LocalResolver } from "./tools/local-resolver.js";
import { createLocalResolver } from "./tools/local-resolver.js";
import type {
  AdvertisedTool,
  CapacityReport,
  NodeConfig,
  NodeEvent,
  NodeEventListener,
  NodeFrame,
  NodeFrameKind,
  NodeMode,
  NodeSessionStore,
  NodeState,
} from "./types.js";
import { parseNodeConfig } from "./types.js";
import type { WriteQueue } from "./write-queue.js";
import { createWriteQueue } from "./write-queue.js";

// ---------------------------------------------------------------------------
// KoiNode handle — discriminated union by mode
// ---------------------------------------------------------------------------

/** Shared surface present on both Full and Thin nodes. */
interface KoiNodeBase {
  /** Unique node identifier. */
  readonly nodeId: string;
  /** Node mode (discriminant). */
  readonly mode: NodeMode;
  /** Current node state. */
  readonly state: () => NodeState;
  /** Start the node (connect, discover, scan tools). */
  readonly start: () => Promise<void>;
  /** Stop the node gracefully. */
  readonly stop: () => Promise<void>;
  /** Register a node event listener. */
  readonly onEvent: (listener: NodeEventListener) => () => void;
  /** Access the local tool resolver. */
  readonly toolResolver: LocalResolver;
}

/** Full mode — hosts agents, dispatches engines, manages checkpoints. */
export interface FullKoiNode extends KoiNodeBase {
  readonly mode: "full";
  /** Dispatch a new agent onto this node. */
  readonly dispatch: (
    pid: ProcessId,
    manifest: AgentManifest,
    engine: EngineAdapter,
    providers?: readonly ComponentProvider[],
  ) => Promise<Result<Agent, KoiError>>;
  /** Terminate an agent by ID. */
  readonly terminate: (agentId: string) => Result<void, KoiError>;
  /** Get an agent by ID. */
  readonly getAgent: (agentId: string) => Agent | undefined;
  /** List all hosted agents. */
  readonly listAgents: () => readonly Agent[];
  /** Current capacity report. */
  readonly capacity: () => CapacityReport;
  /** Checkpoint manager (available when sessionStore is provided). */
  readonly checkpoint: CheckpointManager | undefined;
}

/** Thin mode — exposes tools only, no engine execution. */
export interface ThinKoiNode extends KoiNodeBase {
  readonly mode: "thin";
}

/** Discriminated union: narrow on `mode` to access Full-only or Thin-only members. */
export type KoiNode = FullKoiNode | ThinKoiNode;

/**
 * Result returned by `onRecover` for each session during startup recovery.
 *
 * The caller controls which agents to recover (return `null` to skip),
 * which engine adapter to use per manifest, what `ProcessId` to assign,
 * and which `ComponentProvider`s to attach. This avoids the node needing
 * to know about engine types (L2 constraint).
 */
export interface RecoveryResult {
  readonly pid: ProcessId;
  readonly engine: EngineAdapter;
  readonly providers?: readonly ComponentProvider[];
}

/** Optional dependencies injected into the node. */
export interface NodeDeps {
  /** Session persistence for crash recovery. When provided, enables checkpointing. */
  readonly sessionStore?: NodeSessionStore;
  /**
   * Called once per session during startup recovery.
   * Return a `RecoveryResult` to re-dispatch the agent, or `null` to skip it.
   */
  readonly onRecover?: (
    session: SessionRecord,
    checkpoint: SessionCheckpoint | undefined,
  ) => RecoveryResult | null | Promise<RecoveryResult | null>;
  /**
   * Permission checker for tool_call authorization. When absent, all tool calls
   * are denied by default (fail closed). Inject a ScopeChecker + DelegationScope
   * to enable permission-checked tool execution.
   */
  readonly permission?:
    | {
        readonly checker: ScopeChecker;
        readonly scope: DelegationScope;
      }
    | undefined;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createNode(rawConfig: unknown, deps?: NodeDeps): Result<KoiNode, KoiError> {
  // -- Validate config via Zod -----------------------------------------------
  const parseResult = parseNodeConfig(rawConfig);
  if (!parseResult.ok) {
    return parseResult;
  }

  const config: NodeConfig = parseResult.value;
  const nodeId = config.nodeId ?? generateNodeId();

  // -- Shared subsystems (both modes) ----------------------------------------
  // let: mutated by start/stop lifecycle
  let currentState: NodeState = "stopped";
  const eventListeners = new Set<NodeEventListener>();

  function emit(type: NodeEvent["type"], data?: unknown): void {
    const event: NodeEvent = { type, timestamp: Date.now(), data };
    for (const listener of eventListeners) {
      listener(event);
    }
  }

  const transport = createTransport(nodeId, config.gateway, config.heartbeat, config.auth);
  const resolver: LocalResolver = createLocalResolver(config.tools);
  const discovery = createDiscoveryService(config.discovery);
  const frameCounters = createFrameCounters();
  const dedup = createFrameDeduplicator();

  // Forward transport events to node-level listeners
  const unsubTransport = transport.onEvent((event) => {
    emit(event.type, event.data);
  });

  // -- Shared: outbound frame sender ----------------------------------------

  // Default send: direct to transport (thin mode). Full mode overrides below.
  // let: overridden by full mode to route through delivery manager
  let sendOutbound: (frame: NodeFrame) => void = (frame) => {
    if (frame.agentId.length > 0) {
      frameCounters.increment(frame.agentId);
    }
    transport.send(frame);
  };

  // -- Shared: tool_call dispatch helper ------------------------------------

  function dispatchToolCall(frame: NodeFrame): void {
    void handleToolCallImpl(frame, {
      nodeId,
      permission: deps?.permission,
      resolver,
      sendOutbound,
      emit,
      timeoutMs: config.tools.toolCallTimeoutMs,
    }).catch((e: unknown) => {
      emit("agent_crashed", { reason: "tool_call handler failed", error: e });
    });
  }

  // -- Shared: capabilities advertisement helper -----------------------------

  function advertiseCapabilities(): void {
    const tools: readonly AdvertisedTool[] = resolver.list().map((meta) => ({
      name: meta.name,
      description: meta.description,
    }));
    transport.send({
      nodeId,
      agentId: "",
      correlationId: generateCorrelationId(nodeId),
      kind: "node:capabilities",
      payload: { nodeType: config.mode, tools },
    });
  }

  // -- Shared: onEvent helper ------------------------------------------------

  function onEvent(listener: NodeEventListener): () => void {
    eventListeners.add(listener);
    return () => {
      eventListeners.delete(listener);
    };
  }

  // -- Mode branch -----------------------------------------------------------

  if (config.mode === "thin") {
    return buildThinNode();
  }
  return buildFullNode();

  // -------------------------------------------------------------------------
  // Thin mode (inner function — closes over createNode scope)
  // -------------------------------------------------------------------------

  function buildThinNode(): Result<ThinKoiNode, KoiError> {
    // let: set during start(), used during stop()
    let shutdown: ShutdownHandler | undefined;

    // Wire inbound frame handler — thin mode only handles tool_call
    transport.onFrame((frame) => {
      if (frame.correlationId.length > 0 && dedup.isDuplicate(frame.correlationId)) {
        return;
      }
      if (frame.agentId.length > 0) {
        const current = frameCounters.get(frame.agentId);
        frameCounters.updateRemote(frame.agentId, current.remoteSeq + 1);
      }

      switch (frame.kind) {
        case "tool_call": {
          dispatchToolCall(frame);
          break;
        }
        default:
          break;
      }
    });

    const node: ThinKoiNode = {
      nodeId,
      mode: "thin",

      state() {
        return currentState;
      },

      async start() {
        if (currentState === "connected" || currentState === "starting") return;
        currentState = "starting";

        const connectPromise = transport.connect().then(() => {
          transport.send({
            nodeId,
            agentId: "",
            correlationId: generateCorrelationId(nodeId),
            kind: "node:handshake",
            payload: {
              nodeId,
              version: "0.0.0",
              capacity: { current: 0, max: 0, available: 0 },
            },
          });
          advertiseCapabilities();
        });

        const discoveryPromise = discovery.publish({
          name: `koi-node-${nodeId}`,
          type: config.discovery.serviceType,
          port: 0,
          txt: { nodeId, version: "0.0.0", capacity: "0" },
        });

        const toolsPromise = resolver.discover();

        const [connectResult] = await Promise.allSettled([
          connectPromise,
          discoveryPromise,
          toolsPromise,
        ]);

        if (connectResult.status === "rejected") {
          currentState = "stopped";
          throw new Error("Failed to connect to Gateway", { cause: connectResult.reason });
        }

        currentState = "connected";

        const shutdownEmit = (type: string, data?: unknown): void => {
          if (type === "shutdown_started" || type === "shutdown_complete") {
            emit(type, data);
          }
        };

        shutdown = createShutdownHandler(
          {
            onStopAccepting() {
              currentState = "stopping";
            },
            async onDrainAgents() {
              // Thin mode has no agents to drain
            },
            async onCleanup() {
              unsubTransport();
              await discovery.unpublish();
              await transport.close();
              currentState = "stopped";
            },
          },
          shutdownEmit,
        );
        shutdown.install();
      },

      async stop() {
        if (shutdown !== undefined) {
          await shutdown.shutdown();
          shutdown.uninstall();
        } else {
          unsubTransport();
          await discovery.unpublish();
          await transport.close();
          currentState = "stopped";
        }
      },

      onEvent,
      toolResolver: resolver,
    };

    return { ok: true, value: node };
  }

  // -------------------------------------------------------------------------
  // Full mode (inner function — closes over createNode scope)
  // -------------------------------------------------------------------------

  function buildFullNode(): Result<FullKoiNode, KoiError> {
    // -- Full-only subsystems ------------------------------------------------
    const engines = new Map<string, EngineAdapter>();
    const host: AgentHost = createAgentHost(config.resources);
    const monitor = createMemoryMonitor(config.resources, host, emit);

    const writeQueue: WriteQueue | undefined =
      deps?.sessionStore !== undefined ? createWriteQueue(deps.sessionStore) : undefined;

    const checkpointMgr: CheckpointManager | undefined =
      deps?.sessionStore !== undefined
        ? createCheckpointManager(deps.sessionStore, host, (id) => engines.get(id), {
            frameCounters,
            ...(writeQueue !== undefined ? { writeQueue } : {}),
          })
        : undefined;

    const deliveryMgr: DeliveryManager | undefined =
      deps?.sessionStore !== undefined
        ? createDeliveryManager(
            {
              store: deps.sessionStore,
              isConnected: () => transport.state() === "connected",
              sendFrame: (frame) => {
                transport.send({
                  nodeId,
                  agentId: String(frame.agentId),
                  correlationId: generateCorrelationId(nodeId),
                  kind: frame.frameType as NodeFrame["kind"],
                  payload: frame.payload,
                });
              },
              emit,
            },
            {
              baseDelayMs: config.gateway.reconnectBaseDelay,
              maxDelayMs: config.gateway.reconnectMaxDelay,
              multiplier: config.gateway.reconnectMultiplier,
              jitter: config.gateway.reconnectJitter,
            },
          )
        : undefined;

    const PERSISTENT_FRAME_KINDS: ReadonlySet<NodeFrameKind> = new Set([
      "agent:message",
      "tool_result",
      "tool_error",
    ] as const);

    function sendFrame(frame: NodeFrame): void {
      if (frame.agentId.length > 0) {
        frameCounters.increment(frame.agentId);
      }
      if (
        deliveryMgr !== undefined &&
        checkpointMgr !== undefined &&
        frame.agentId.length > 0 &&
        PERSISTENT_FRAME_KINDS.has(frame.kind)
      ) {
        const sessionId = checkpointMgr.getSessionId(frame.agentId);
        if (sessionId !== undefined) {
          deliveryMgr.enqueueSend(frame, sessionId).catch((e: unknown) => {
            emit("agent_crashed", {
              reason: "enqueueSend failed",
              agentId: frame.agentId,
              error: e,
            });
          });
          return;
        }
      }
      transport.send(frame);
    }

    // Override shared sendOutbound so tool_call results route through delivery manager
    sendOutbound = sendFrame;

    const statusReporter: StatusReporter = createStatusReporter(nodeId, host, sendFrame);

    // let: set during start(), used during stop()
    let shutdown: ShutdownHandler | undefined;

    // Forward host events to node-level listeners
    const unsubHost = host.onEvent((event) => emit(event.type, event.data));

    // Reconnect replay for full mode
    const unsubReconnect = transport.onEvent((event) => {
      if (
        event.type === "reconnected" &&
        deliveryMgr !== undefined &&
        checkpointMgr !== undefined
      ) {
        void (async () => {
          try {
            for (const agent of host.list()) {
              const sessionId = checkpointMgr.getSessionId(agent.pid.id);
              if (sessionId !== undefined) {
                await deliveryMgr.replayPendingFrames(sessionId);
              }
            }
          } catch (e: unknown) {
            emit("agent_crashed", { reason: "Reconnect replay failed", error: e });
          }
        })();
      }
    });

    // Wire inbound frame handler — full mode handles agent frames + tool_call
    transport.onFrame((frame) => {
      if (frame.correlationId.length > 0 && dedup.isDuplicate(frame.correlationId)) {
        return;
      }
      if (frame.agentId.length > 0) {
        const current = frameCounters.get(frame.agentId);
        frameCounters.updateRemote(frame.agentId, current.remoteSeq + 1);
      }

      switch (frame.kind) {
        case "agent:terminate": {
          if (frame.agentId.length > 0) {
            host.terminate(frame.agentId);
          }
          break;
        }
        case "agent:message": {
          // TODO: wire to engine adapter's stream() when L1 is available
          break;
        }
        case "tool_call": {
          dispatchToolCall(frame);
          break;
        }
        default:
          break;
      }
    });

    // -- Recovery helper -----------------------------------------------------

    async function recoverAgents(
      onRecover: NonNullable<NodeDeps["onRecover"]>,
      mgr: CheckpointManager,
    ): Promise<void> {
      const planResult = await mgr.recover();
      if (!planResult.ok) {
        emit("agent_crashed", {
          reason: "Failed to load recovery plan",
          error: planResult.error,
        });
        return;
      }

      const { sessions, checkpoints, pendingFrames } = planResult.value;

      for (const session of sessions) {
        try {
          frameCounters.restore(session.agentId, session.seq, session.remoteSeq);
          const checkpoint = checkpoints.get(session.agentId);
          const result = await onRecover(session, checkpoint);

          if (result === null) continue;

          if (checkpoint !== undefined && result.engine.loadState !== undefined) {
            await result.engine.loadState(checkpoint.engineState);
          }

          const dispatchResult = await host.dispatch(
            result.pid,
            session.manifestSnapshot,
            result.engine,
            result.providers ?? [],
          );

          if (dispatchResult.ok) {
            engines.set(result.pid.id, result.engine);
            if (deliveryMgr !== undefined && pendingFrames.has(session.sessionId)) {
              await deliveryMgr.replayPendingFrames(session.sessionId);
            }
            emit("agent_recovered", {
              agentId: result.pid.id,
              sessionId: session.sessionId,
              hadCheckpoint: checkpoint !== undefined,
            });
          } else {
            emit("agent_crashed", {
              agentId: session.agentId,
              sessionId: session.sessionId,
              reason: "Dispatch failed during recovery",
              error: dispatchResult.error,
            });
          }
        } catch (e: unknown) {
          emit("agent_crashed", {
            agentId: session.agentId,
            sessionId: session.sessionId,
            reason: "Recovery failed",
            error: e,
          });
        }
      }
    }

    // -- Build FullKoiNode handle --------------------------------------------

    const node: FullKoiNode = {
      nodeId,
      mode: "full",

      state() {
        return currentState;
      },

      async start() {
        if (currentState === "connected" || currentState === "starting") return;
        currentState = "starting";

        const connectPromise = transport.connect().then(() => {
          transport.send({
            nodeId,
            agentId: "",
            correlationId: generateCorrelationId(nodeId),
            kind: "node:handshake",
            payload: { nodeId, version: "0.0.0", capacity: host.capacity() },
          });
          advertiseCapabilities();
        });

        const discoveryPromise = discovery.publish({
          name: `koi-node-${nodeId}`,
          type: config.discovery.serviceType,
          port: 0,
          txt: {
            nodeId,
            version: "0.0.0",
            capacity: String(config.resources.maxAgents),
          },
        });

        const toolsPromise = resolver.discover();

        const [connectResult] = await Promise.allSettled([
          connectPromise,
          discoveryPromise,
          toolsPromise,
        ]);

        if (connectResult.status === "rejected") {
          currentState = "stopped";
          throw new Error("Failed to connect to Gateway", { cause: connectResult.reason });
        }

        if (checkpointMgr !== undefined && deps?.onRecover !== undefined) {
          await recoverAgents(deps.onRecover, checkpointMgr);
        }

        currentState = "connected";

        monitor.start();
        statusReporter.start();

        const shutdownEmit = (type: string, data?: unknown): void => {
          if (type === "shutdown_started" || type === "shutdown_complete") {
            emit(type, data);
          }
        };

        shutdown = createShutdownHandler(
          {
            onStopAccepting() {
              currentState = "stopping";
            },
            async onDrainAgents() {
              host.terminateAll();
            },
            async onCleanup() {
              deliveryMgr?.dispose();
              if (writeQueue !== undefined) {
                await writeQueue.dispose();
              }
              checkpointMgr?.dispose();
              statusReporter.stop();
              monitor.stop();
              unsubTransport();
              unsubHost();
              unsubReconnect();
              engines.clear();
              await discovery.unpublish();
              await transport.close();
              currentState = "stopped";
            },
          },
          shutdownEmit,
        );
        shutdown.install();
      },

      async stop() {
        if (shutdown !== undefined) {
          await shutdown.shutdown();
          shutdown.uninstall();
        } else {
          deliveryMgr?.dispose();
          if (writeQueue !== undefined) {
            await writeQueue.dispose();
          }
          checkpointMgr?.dispose();
          statusReporter.stop();
          monitor.stop();
          unsubTransport();
          unsubHost();
          unsubReconnect();
          host.terminateAll();
          engines.clear();
          await discovery.unpublish();
          await transport.close();
          currentState = "stopped";
        }
      },

      async dispatch(pid, manifest, engine, providers = []) {
        if (currentState !== "connected") {
          return {
            ok: false,
            error: {
              code: "VALIDATION",
              message: `Cannot dispatch agent: node is ${currentState}`,
              retryable: false,
            },
          };
        }

        const sessionId = checkpointMgr?.getSessionId(pid.id);
        const effectiveEngine =
          checkpointMgr !== undefined
            ? createCheckpointingEngine(engine, {
                agentId: pid.id,
                sessionId: sessionId ?? `session-${pid.id}-${String(Date.now())}`,
                onCheckpoint: async (agentId, sid) => {
                  await checkpointMgr.checkpointAgent(agentId, sid);
                },
              })
            : engine;

        const result = await host.dispatch(pid, manifest, effectiveEngine, providers);
        if (result.ok) {
          engines.set(pid.id, effectiveEngine);
        }
        return result;
      },

      terminate(agentId) {
        const result = host.terminate(agentId);
        if (result.ok) {
          engines.delete(agentId);
          frameCounters.remove(agentId);
        }
        return result;
      },

      getAgent(agentId) {
        return host.get(agentId);
      },

      listAgents() {
        return host.list();
      },

      capacity() {
        return host.capacity();
      },

      onEvent,
      toolResolver: resolver,
      checkpoint: checkpointMgr,
    };

    return { ok: true, value: node };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function generateNodeId(): string {
  const random = Math.random().toString(36).slice(2, 10);
  return `node-${random}-${Date.now()}`;
}
