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
  EngineAdapter,
  KoiError,
  ProcessId,
  Result,
} from "@koi/core";
import type { AgentHost } from "./agent/host.js";
import { createAgentHost } from "./agent/host.js";
import type { StatusReporter } from "./agent/status.js";
import { createStatusReporter } from "./agent/status.js";
import type { CheckpointManager } from "./checkpoint.js";
import { createCheckpointManager } from "./checkpoint.js";
import { createCheckpointingEngine } from "./checkpointing-engine.js";
import { generateCorrelationId } from "./connection/protocol.js";
import type { Transport } from "./connection/transport.js";
import { createTransport } from "./connection/transport.js";
import type { DeliveryManager } from "./delivery-manager.js";
import { createDeliveryManager } from "./delivery-manager.js";
import type { DiscoveryService } from "./discovery.js";
import { createDiscoveryService } from "./discovery.js";
import type { FrameCounters } from "./frame-counter.js";
import { createFrameCounters } from "./frame-counter.js";
import type { FrameDeduplicator } from "./frame-dedup.js";
import { createFrameDeduplicator } from "./frame-dedup.js";
import type { MemoryMonitor } from "./monitor.js";
import { createMemoryMonitor } from "./monitor.js";
import type { ShutdownHandler } from "./shutdown.js";
import { createShutdownHandler } from "./shutdown.js";
import type { LocalResolver } from "./tools/local-resolver.js";
import { createLocalResolver } from "./tools/local-resolver.js";
import type {
  AdvertisedTool,
  CapacityReport,
  NodeCheckpoint,
  NodeConfig,
  NodeEvent,
  NodeEventListener,
  NodeFrame,
  NodeFrameType,
  NodeSessionRecord,
  NodeSessionStore,
  NodeState,
} from "./types.js";
import { parseNodeConfig } from "./types.js";
import type { WriteQueue } from "./write-queue.js";
import { createWriteQueue } from "./write-queue.js";

// ---------------------------------------------------------------------------
// KoiNode handle
// ---------------------------------------------------------------------------

export interface KoiNode {
  /** Unique node identifier. */
  readonly nodeId: string;
  /** Current node state. */
  readonly state: () => NodeState;
  /** Start the node (connect, discover, scan tools). */
  readonly start: () => Promise<void>;
  /** Stop the node gracefully. */
  readonly stop: () => Promise<void>;
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
  /** Register a node event listener. */
  readonly onEvent: (listener: NodeEventListener) => () => void;
  /** Access the local tool resolver. */
  readonly toolResolver: LocalResolver;
  /** Checkpoint manager (available when sessionStore is provided). */
  readonly checkpoint: CheckpointManager | undefined;
}

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
    session: NodeSessionRecord,
    checkpoint: NodeCheckpoint | undefined,
  ) => RecoveryResult | null | Promise<RecoveryResult | null>;
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

  // -- Wire subsystems -------------------------------------------------------
  let currentState: NodeState = "stopped";
  const eventListeners = new Set<NodeEventListener>();

  function emit(type: NodeEvent["type"], data?: unknown): void {
    const event: NodeEvent = { type, timestamp: Date.now(), data };
    for (const listener of eventListeners) {
      listener(event);
    }
  }

  // Engine registry: tracks engine adapters by agentId for checkpointing
  const engines = new Map<string, EngineAdapter>();

  const transport: Transport = createTransport(
    nodeId,
    config.gateway,
    config.heartbeat,
    config.auth,
  );
  const host: AgentHost = createAgentHost(config.resources);
  const resolver: LocalResolver = createLocalResolver(config.tools);

  // Frame counters for seq/remoteSeq tracking
  const frameCounters: FrameCounters = createFrameCounters();

  // Inbound frame deduplicator (drops Gateway retransmits on reconnect)
  const dedup: FrameDeduplicator = createFrameDeduplicator();

  // Write queue for batched checkpoint writes
  const writeQueue: WriteQueue | undefined =
    deps?.sessionStore !== undefined ? createWriteQueue(deps.sessionStore) : undefined;

  // Checkpoint manager (only if sessionStore is provided)
  const checkpointMgr: CheckpointManager | undefined =
    deps?.sessionStore !== undefined
      ? createCheckpointManager(deps.sessionStore, host, (agentId) => engines.get(agentId), {
          frameCounters,
          ...(writeQueue !== undefined ? { writeQueue } : {}),
        })
      : undefined;
  // Delivery manager for retrying pending frames with backoff
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
                type: frame.frameType as NodeFrame["type"],
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

  const discovery: DiscoveryService = createDiscoveryService(config.discovery);
  const monitor: MemoryMonitor = createMemoryMonitor(config.resources, host, emit);
  // Business frame types that should be persisted for crash recovery
  const PERSISTENT_FRAME_TYPES: ReadonlySet<NodeFrameType> = new Set([
    "agent:message",
    "tool_result",
    "tool_error",
  ] as const);

  // Outbound send wrapper: counts frames for seq tracking
  function sendFrame(frame: NodeFrame): void {
    if (frame.agentId.length > 0) {
      frameCounters.increment(frame.agentId);
    }
    // Route business frames through persistence layer when available
    if (
      deliveryMgr !== undefined &&
      checkpointMgr !== undefined &&
      frame.agentId.length > 0 &&
      PERSISTENT_FRAME_TYPES.has(frame.type)
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

  const statusReporter: StatusReporter = createStatusReporter(nodeId, host, sendFrame);

  // let: set during start(), used during stop()
  let shutdown: ShutdownHandler | undefined;

  // Forward transport/host events to node-level listeners; store unsubs for cleanup
  const unsubTransport = transport.onEvent((event) => {
    emit(event.type, event.data);

    // On reconnect, replay pending frames for active agents (no full DB scan)
    if (event.type === "reconnected" && deliveryMgr !== undefined && checkpointMgr !== undefined) {
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
  const unsubHost = host.onEvent((event) => emit(event.type, event.data));

  // Handle incoming frames from Gateway
  transport.onFrame((frame) => {
    // Dedup: skip frames already processed (e.g., Gateway retransmits on reconnect)
    if (frame.correlationId.length > 0 && dedup.isDuplicate(frame.correlationId)) {
      return;
    }

    // Track inbound sequence for crash recovery
    if (frame.agentId.length > 0) {
      const currentState = frameCounters.get(frame.agentId);
      frameCounters.updateRemote(frame.agentId, currentState.remoteSeq + 1);
    }

    switch (frame.type) {
      case "agent:terminate": {
        const agentId = frame.agentId;
        if (agentId.length > 0) {
          host.terminate(agentId);
        }
        break;
      }
      case "agent:message": {
        // Route message to the target agent's engine
        // TODO: wire to engine adapter's stream() when L1 is available
        break;
      }
      default:
        // Other frame types handled by specific subsystems
        break;
    }
  });

  // -- Recovery helper -------------------------------------------------------

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
        // Restore frame counters from session record
        frameCounters.restore(session.agentId, session.seq, session.remoteSeq);

        const checkpoint = checkpoints.get(session.agentId);
        const result = await onRecover(session, checkpoint);

        if (result === null) continue;

        // Restore engine state from checkpoint if available
        if (checkpoint !== undefined && result.engine.loadState !== undefined) {
          await result.engine.loadState(checkpoint.engineState);
        }

        // Dispatch directly through the host (bypasses "connected" guard)
        const dispatchResult = await host.dispatch(
          result.pid,
          session.manifestSnapshot,
          result.engine,
          result.providers ?? [],
        );

        if (dispatchResult.ok) {
          engines.set(result.pid.id, result.engine);

          // Replay pending frames with retry/backoff
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

  // -- Build KoiNode handle --------------------------------------------------
  const node: KoiNode = {
    nodeId,

    state() {
      return currentState;
    },

    async start() {
      if (currentState === "connected" || currentState === "starting") return;
      currentState = "starting";

      // Parallel startup: connect + mDNS + tool scan
      const connectPromise = transport.connect().then(() => {
        // Send handshake after connecting
        transport.send({
          nodeId,
          agentId: "",
          correlationId: generateCorrelationId(nodeId),
          type: "node:handshake",
          payload: {
            nodeId,
            version: "0.0.0",
            capacity: host.capacity(),
          },
        });

        // Advertise tool surface so Gateway can route tool_call frames to this Node
        const tools: readonly AdvertisedTool[] = resolver.list().map((meta) => ({
          name: meta.name,
          description: meta.description,
        }));
        transport.send({
          nodeId,
          agentId: "",
          correlationId: generateCorrelationId(nodeId),
          type: "node:capabilities",
          payload: {
            nodeType: config.mode,
            tools,
          },
        });
      });

      const discoveryPromise = discovery.publish({
        name: `koi-node-${nodeId}`,
        type: config.discovery.serviceType,
        port: 0, // TODO: actual port from transport
        txt: {
          nodeId,
          version: "0.0.0",
          capacity: String(config.resources.maxAgents),
        },
      });

      const toolsPromise = resolver.discover();

      // Wait for all — mDNS and tools are non-fatal
      const [connectResult] = await Promise.allSettled([
        connectPromise,
        discoveryPromise,
        toolsPromise,
      ]);

      if (connectResult.status === "rejected") {
        currentState = "stopped";
        throw new Error("Failed to connect to Gateway", { cause: connectResult.reason });
      }

      // Recover previously-dispatched agents before accepting new work
      if (checkpointMgr !== undefined && deps?.onRecover !== undefined) {
        await recoverAgents(deps.onRecover, checkpointMgr);
      }

      currentState = "connected";

      // Start background services
      monitor.start();
      statusReporter.start();

      // Install shutdown handler
      shutdown = createShutdownHandler(
        {
          onStopAccepting() {
            currentState = "stopping";
          },
          async onDrainAgents() {
            // Give agents time to finish current turns
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
            engines.clear();
            await discovery.unpublish();
            await transport.close();
            currentState = "stopped";
          },
        },
        emit,
      );
      shutdown.install();
    },

    async stop() {
      if (shutdown !== undefined) {
        await shutdown.shutdown();
        shutdown.uninstall();
      } else {
        // Manual cleanup if shutdown handler wasn't installed
        deliveryMgr?.dispose();
        if (writeQueue !== undefined) {
          await writeQueue.dispose();
        }
        checkpointMgr?.dispose();
        statusReporter.stop();
        monitor.stop();
        unsubTransport();
        unsubHost();
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

      // Wrap engine with auto-checkpointing when checkpoint manager is present
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

    onEvent(listener) {
      eventListeners.add(listener);
      return () => {
        eventListeners.delete(listener);
      };
    },

    toolResolver: resolver,
    checkpoint: checkpointMgr,
  };

  return { ok: true, value: node };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function generateNodeId(): string {
  const random = Math.random().toString(36).slice(2, 10);
  return `node-${random}-${Date.now()}`;
}
