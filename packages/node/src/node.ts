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
import { generateCorrelationId } from "./connection/protocol.js";
import type { Transport } from "./connection/transport.js";
import { createTransport } from "./connection/transport.js";
import type { DiscoveryService } from "./discovery.js";
import { createDiscoveryService } from "./discovery.js";
import type { MemoryMonitor } from "./monitor.js";
import { createMemoryMonitor } from "./monitor.js";
import type { ShutdownHandler } from "./shutdown.js";
import { createShutdownHandler } from "./shutdown.js";
import type { LocalResolver } from "./tools/local-resolver.js";
import { createLocalResolver } from "./tools/local-resolver.js";
import type {
  AdvertisedTool,
  CapacityReport,
  NodeConfig,
  NodeEvent,
  NodeEventListener,
  NodeState,
} from "./types.js";
import { parseNodeConfig } from "./types.js";

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
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createNode(rawConfig: unknown): Result<KoiNode, KoiError> {
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

  const transport: Transport = createTransport(
    nodeId,
    config.gateway,
    config.heartbeat,
    config.auth,
  );
  const host: AgentHost = createAgentHost(config.resources);
  const resolver: LocalResolver = createLocalResolver(config.tools);
  const discovery: DiscoveryService = createDiscoveryService(config.discovery);
  const monitor: MemoryMonitor = createMemoryMonitor(config.resources, host, emit);
  const statusReporter: StatusReporter = createStatusReporter(nodeId, host, (frame) =>
    transport.send(frame),
  );

  // let: set during start(), used during stop()
  let shutdown: ShutdownHandler | undefined;

  // Forward transport/host events to node-level listeners; store unsubs for cleanup
  const unsubTransport = transport.onEvent((event) => emit(event.type, event.data));
  const unsubHost = host.onEvent((event) => emit(event.type, event.data));

  // Handle incoming frames from Gateway
  transport.onFrame((frame) => {
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
            statusReporter.stop();
            monitor.stop();
            unsubTransport();
            unsubHost();
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
        statusReporter.stop();
        monitor.stop();
        unsubTransport();
        unsubHost();
        host.terminateAll();
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
      return host.dispatch(pid, manifest, engine, providers);
    },

    terminate(agentId) {
      return host.terminate(agentId);
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
