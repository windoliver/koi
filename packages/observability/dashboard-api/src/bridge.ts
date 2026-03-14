/**
 * createAdminPanelBridge — adapts live CLI runtime state into
 * DashboardHandlerOptions for the admin panel HTTP handler.
 *
 * The bridge accepts a minimal set of inputs from the CLI runtime and
 * exposes them through the DashboardDataSource interface. It tracks
 * a single primary agent with its channels and skills, providing
 * system metrics from the Bun runtime.
 *
 * This is designed for CLI-hosted agents where there is exactly one
 * agent running. For multi-agent deployments, use the engine registry
 * directly with a full data source implementation.
 */

import type {
  AgentId,
  DataSourceDescriptor,
  FileSystemBackend,
  KoiError,
  ProcessState,
  Result,
} from "@koi/core";
import { agentId } from "@koi/core";
import type {
  AgentProcfs,
  CommandDispatcher,
  DashboardAgentDetail,
  DashboardAgentSummary,
  DashboardChannelSummary,
  DashboardDataSource,
  DashboardEvent,
  DashboardSkillSummary,
  DashboardSystemMetrics,
  DataSourceSummary,
  GatewayTopology,
  MiddlewareChain,
  ProcessTreeSnapshot,
  RuntimeViewDataSource,
} from "@koi/dashboard-types";
import type { DashboardHandlerOptions } from "./handler.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BridgeOptions {
  /** Display name of the agent (from manifest). */
  readonly agentName: string;
  /** Agent type: copilot or worker. */
  readonly agentType: "copilot" | "worker";
  /** Model name (e.g. "anthropic:claude-sonnet-4-5-20250929"). */
  readonly model?: string | undefined;
  /** Channel type names (e.g. ["cli", "telegram"]). */
  readonly channels: readonly string[];
  /** Skill names (e.g. ["web-search", "code-review"]). */
  readonly skills: readonly string[];
  /** Optional filesystem backend for file browsing in the admin panel. */
  readonly fileSystem?: FileSystemBackend | undefined;
  /** Optional orchestration view sources to merge into runtimeViews. */
  readonly orchestration?:
    | {
        readonly temporal?: RuntimeViewDataSource["temporal"];
        readonly scheduler?: RuntimeViewDataSource["scheduler"];
        readonly taskBoard?: RuntimeViewDataSource["taskBoard"];
        readonly harness?: RuntimeViewDataSource["harness"];
      }
    | undefined;
  /** Optional orchestration commands (e.g. from temporal-admin-adapter). */
  readonly orchestrationCommands?:
    | Pick<
        CommandDispatcher,
        | "signalWorkflow"
        | "terminateWorkflow"
        | "pauseSchedule"
        | "resumeSchedule"
        | "deleteSchedule"
        | "retrySchedulerDeadLetter"
        | "pauseHarness"
        | "resumeHarness"
      >
    | undefined;
  /** Discovered data sources to expose via the dashboard API. */
  readonly discoveredSources?: readonly DataSourceSummary[] | undefined;
  /** Full data source descriptors — used for schema/detail endpoint responses. */
  readonly dataSourceDescriptors?: readonly DataSourceDescriptor[] | undefined;
  /** Optional agent dispatch implementation (e.g. from AgentHost). */
  readonly dispatchAgent?: CommandDispatcher["dispatchAgent"] | undefined;
  /** Called when a dispatched agent is terminated — disposes the runtime. */
  readonly onTerminateAgent?: ((id: AgentId) => Promise<void> | void) | undefined;
}

/** Registration entry for a dispatched agent. */
export interface DispatchedAgentEntry {
  readonly agentId: AgentId;
  readonly name: string;
  readonly agentType: "copilot" | "worker";
  readonly model?: string;
  readonly startedAt: number;
}

export interface AdminPanelBridgeResult extends DashboardHandlerOptions {
  /** Synthetic agent ID used by the bridge (e.g. `cli:<name>:<ts>`). */
  readonly agentId: AgentId;
  /** Emit a dashboard event to all subscribers. */
  readonly emitEvent: (event: DashboardEvent) => void;
  /** Update agent metrics (turns, tokens). Emits a metrics_updated event. */
  readonly updateMetrics: (metrics: {
    readonly turns: number;
    readonly totalTokens: number;
  }) => void;
  /** Register a dispatched agent so it appears in listAgents/getAgent. */
  readonly registerDispatchedAgent: (entry: DispatchedAgentEntry) => void;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createAdminPanelBridge(options: BridgeOptions): AdminPanelBridgeResult {
  const primaryAgentId = agentId(`cli:${options.agentName}:${Date.now()}`);
  const startedAt = Date.now();
  const listeners = new Set<(event: DashboardEvent) => void>();

  // Mutable data source state — updated by rescan
  // let justified: rescan adds newly discovered sources at runtime
  let currentSources: readonly DataSourceSummary[] = options.discoveredSources ?? [];
  // let justified: rescan adds newly discovered descriptors for schema detail
  let currentDescriptors: readonly DataSourceDescriptor[] = options.dataSourceDescriptors ?? [];

  // Mutable agent state — tracks lifecycle transitions
  // let justified: state changes on terminate, read by list/get/terminate
  let agentState: ProcessState = "running";
  // let justified: updated by CLI via updateMetrics(), read by list/get
  let currentTurns = 0;
  // let justified: updated by CLI via updateMetrics(), read by get
  let currentTokenCount = 0;

  // Registry for dispatched agents (created via admin panel dispatch dialog)
  const dispatchedAgents = new Map<
    string,
    { readonly entry: DispatchedAgentEntry; state: ProcessState }
  >();

  const emitEvent = (event: DashboardEvent): void => {
    for (const listener of listeners) {
      listener(event);
    }
  };

  const buildSummary = (): DashboardAgentSummary => ({
    agentId: primaryAgentId,
    name: options.agentName,
    agentType: options.agentType,
    state: agentState,
    ...(options.model !== undefined ? { model: options.model } : {}),
    channels: [...options.channels],
    turns: currentTurns,
    startedAt,
    lastActivityAt: Date.now(),
  });

  const buildDetail = (): DashboardAgentDetail => ({
    ...buildSummary(),
    skills: [...options.skills],
    tokenCount: currentTokenCount,
    metadata: {},
  });

  /** Build a summary for a dispatched agent. */
  function buildDispatchedSummary(d: {
    readonly entry: DispatchedAgentEntry;
    readonly state: ProcessState;
  }): DashboardAgentSummary {
    return {
      agentId: d.entry.agentId,
      name: d.entry.name,
      agentType: d.entry.agentType,
      state: d.state,
      ...(d.entry.model !== undefined ? { model: d.entry.model } : {}),
      channels: [],
      turns: 0,
      startedAt: d.entry.startedAt,
      lastActivityAt: Date.now(),
    };
  }

  const dataSource: DashboardDataSource = {
    listAgents(): readonly DashboardAgentSummary[] {
      const dispatched = [...dispatchedAgents.values()].map(buildDispatchedSummary);
      return [buildSummary(), ...dispatched];
    },

    getAgent(id: AgentId): DashboardAgentDetail | undefined {
      if (id === primaryAgentId) return buildDetail();
      const d = dispatchedAgents.get(id);
      if (d === undefined) return undefined;
      return { ...buildDispatchedSummary(d), skills: [], tokenCount: 0, metadata: {} };
    },

    terminateAgent(id: AgentId): Result<void, KoiError> | Promise<Result<void, KoiError>> {
      // Handle dispatched agents
      const dispatched = dispatchedAgents.get(id);
      if (dispatched !== undefined) {
        if (dispatched.state === "terminated") {
          return {
            ok: false,
            error: {
              code: "CONFLICT",
              message: `Agent ${id} is already terminated`,
              retryable: false,
            },
          };
        }
        const prev = dispatched.state;
        dispatched.state = "terminated";
        emitEvent({
          kind: "agent",
          subKind: "status_changed",
          agentId: id,
          from: prev,
          to: "terminated",
          timestamp: Date.now(),
        });
        // Actually dispose the runtime if callback provided
        if (options.onTerminateAgent !== undefined) {
          const result = options.onTerminateAgent(id);
          if (result instanceof Promise) {
            return result.then(() => ({ ok: true as const, value: undefined }));
          }
        }
        return { ok: true, value: undefined };
      }

      if (id !== primaryAgentId) {
        return {
          ok: false,
          error: {
            code: "NOT_FOUND",
            message: `Agent ${id} not found`,
            retryable: false,
          },
        };
      }

      if (agentState === "terminated") {
        return {
          ok: false,
          error: {
            code: "CONFLICT",
            message: `Agent ${id} is already terminated`,
            retryable: false,
          },
        };
      }

      const previousState = agentState;
      agentState = "terminated";

      emitEvent({
        kind: "agent",
        subKind: "status_changed",
        agentId: primaryAgentId,
        from: previousState,
        to: "terminated",
        timestamp: Date.now(),
      });

      return { ok: true, value: undefined };
    },

    listChannels(): readonly DashboardChannelSummary[] {
      return options.channels.map((channelType, index) => ({
        channelId: `${channelType}:${String(index)}`,
        channelType,
        agentId: primaryAgentId,
        connected: true,
        messageCount: 0,
        connectedAt: startedAt,
      }));
    },

    listSkills(): readonly DashboardSkillSummary[] {
      return options.skills.map((name) => ({
        name,
        description: "",
        tags: [],
        agentId: primaryAgentId,
      }));
    },

    getSystemMetrics(): DashboardSystemMetrics {
      const heapUsed = process.memoryUsage().heapUsed;
      const heapTotal = process.memoryUsage().heapTotal;

      return {
        uptimeMs: Date.now() - startedAt,
        heapUsedMb: Math.round((heapUsed / 1024 / 1024) * 100) / 100,
        heapTotalMb: Math.round((heapTotal / 1024 / 1024) * 100) / 100,
        activeAgents: 1 + dispatchedAgents.size,
        totalAgents: 1 + dispatchedAgents.size,
        activeChannels: options.channels.length,
      };
    },

    subscribe(listener: (event: DashboardEvent) => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    // Data source discovery — always defined so routes return real data
    // let justified: mutable so rescan can add newly discovered sources
    listDataSources(): readonly DataSourceSummary[] {
      return currentSources;
    },
    approveDataSource(name: string): Result<void, KoiError> {
      const source = currentSources.find((s) => s.name === name);
      if (source === undefined) {
        return {
          ok: false,
          error: {
            code: "NOT_FOUND",
            message: `Data source "${name}" not found`,
            retryable: false,
          },
        };
      }
      return { ok: true, value: undefined };
    },
    getDataSourceSchema(name: string): Readonly<Record<string, unknown>> | undefined {
      const summary = currentSources.find((s) => s.name === name);
      if (summary === undefined) return undefined;
      const descriptor = currentDescriptors.find((d) => d.name === name);
      if (descriptor !== undefined) {
        return {
          name: descriptor.name,
          protocol: descriptor.protocol,
          ...(descriptor.description !== undefined ? { description: descriptor.description } : {}),
          ...(descriptor.endpoint !== undefined ? { endpoint: descriptor.endpoint } : {}),
          ...(descriptor.allowedHosts !== undefined
            ? { allowedHosts: [...descriptor.allowedHosts] }
            : {}),
          ...(descriptor.schemaProbed !== undefined
            ? { schemaProbed: descriptor.schemaProbed }
            : {}),
          ...(descriptor.auth !== undefined ? { auth: { kind: descriptor.auth.kind } } : {}),
          status: summary.status,
          source: summary.source,
        };
      }
      return {
        name: summary.name,
        protocol: summary.protocol,
        status: summary.status,
        source: summary.source,
      };
    },
    async rescanDataSources(): Promise<readonly DataSourceSummary[]> {
      try {
        const { probeEnv } = await import("@koi/data-source-discovery");
        const results = probeEnv(process.env as Readonly<Record<string, string | undefined>>, [
          "*DATABASE_URL*",
          "*_DSN",
          "*_CONNECTION_STRING",
        ]);
        const existingNames = new Set(currentSources.map((s) => s.name));
        const newSources: DataSourceSummary[] = [];
        for (const r of results) {
          if (!existingNames.has(r.descriptor.name)) {
            const summary: DataSourceSummary = {
              name: r.descriptor.name,
              protocol: r.descriptor.protocol,
              status: "approved",
              source: "env",
            };
            newSources.push(summary);
            currentSources = [...currentSources, summary];
            currentDescriptors = [...currentDescriptors, r.descriptor];
            emitEvent({
              kind: "datasource",
              subKind: "data_source_discovered",
              name: r.descriptor.name,
              protocol: r.descriptor.protocol,
              source: "env",
              timestamp: Date.now(),
            });
          }
        }
        // Emit connector_forged for each newly discovered source
        for (const s of newSources) {
          emitEvent({
            kind: "datasource",
            subKind: "connector_forged",
            name: s.name,
            protocol: s.protocol,
            timestamp: Date.now(),
          });
        }
      } catch {
        // probeEnv not available — non-fatal
      }
      return currentSources;
    },
  };

  const runtimeViews: RuntimeViewDataSource = {
    getProcessTree(): ProcessTreeSnapshot {
      return {
        roots: [
          {
            agentId: primaryAgentId,
            name: options.agentName,
            state: agentState,
            agentType: options.agentType,
            depth: 0,
            children: [],
          },
        ],
        totalAgents: 1 + dispatchedAgents.size,
        timestamp: Date.now(),
      };
    },

    getAgentProcfs(id: AgentId): AgentProcfs | undefined {
      if (id !== primaryAgentId) return undefined;

      return {
        agentId: primaryAgentId,
        name: options.agentName,
        state: agentState,
        agentType: options.agentType,
        ...(options.model !== undefined ? { model: options.model } : {}),
        channels: [...options.channels],
        turns: currentTurns,
        tokenCount: currentTokenCount,
        startedAt,
        lastActivityAt: Date.now(),
        childCount: 0,
      };
    },

    getMiddlewareChain(id: AgentId): MiddlewareChain {
      return {
        agentId: id,
        entries: [],
      };
    },

    getGatewayTopology(): GatewayTopology {
      return {
        connections: options.channels.map((channelType, index) => ({
          channelId: `${channelType}:${String(index)}`,
          channelType,
          agentId: primaryAgentId,
          connected: true,
          connectedAt: startedAt,
        })),
        nodeCount: options.channels.length,
        timestamp: Date.now(),
      };
    },

    // Phase 2 orchestration sources (pass-through from caller)
    ...(options.orchestration?.temporal !== undefined
      ? { temporal: options.orchestration.temporal }
      : {}),
    ...(options.orchestration?.scheduler !== undefined
      ? { scheduler: options.orchestration.scheduler }
      : {}),
    ...(options.orchestration?.taskBoard !== undefined
      ? { taskBoard: options.orchestration.taskBoard }
      : {}),
    ...(options.orchestration?.harness !== undefined
      ? { harness: options.orchestration.harness }
      : {}),
  };

  // Command dispatcher for the single-agent bridge.
  // Merges core agent lifecycle commands with optional orchestration commands.
  const orchCmds = options.orchestrationCommands;

  /** Wraps an async orchestration command to emit a DashboardEvent on success. */
  function withEvent<A extends unknown[]>(
    fn: (...args: A) => Promise<Result<void, KoiError>>,
    makeEvent: (...args: A) => DashboardEvent,
  ): (...args: A) => Promise<Result<void, KoiError>> {
    return async (...args: A): Promise<Result<void, KoiError>> => {
      const result = await fn(...args);
      if (result.ok) emitEvent(makeEvent(...args));
      return result;
    };
  }

  // Wrap dispatchAgent to auto-register in data source and emit SSE event
  const rawDispatch = options.dispatchAgent;
  const wrappedDispatchAgent: NonNullable<CommandDispatcher["dispatchAgent"]> | undefined =
    rawDispatch !== undefined
      ? async (request) => {
          const result = await rawDispatch(request);
          if (result.ok) {
            const resolvedType = request.agentType ?? "copilot";
            const entry: DispatchedAgentEntry = {
              agentId: result.value.agentId,
              name: result.value.name,
              agentType: resolvedType,
              startedAt: Date.now(),
            };
            dispatchedAgents.set(result.value.agentId, { entry, state: "running" });
            emitEvent({
              kind: "agent",
              subKind: "dispatched",
              agentId: result.value.agentId,
              name: result.value.name,
              agentType: resolvedType,
              timestamp: Date.now(),
            });
          }
          return result;
        }
      : undefined;

  const commands: CommandDispatcher = {
    // Agent dispatch — wrapped to auto-register + emit SSE event
    ...(wrappedDispatchAgent !== undefined ? { dispatchAgent: wrappedDispatchAgent } : {}),

    suspendAgent(id: AgentId): Result<void, KoiError> {
      if (id !== primaryAgentId) {
        return {
          ok: false,
          error: { code: "NOT_FOUND", message: `Agent ${id} not found`, retryable: false },
        };
      }
      if (agentState !== "running") {
        return {
          ok: false,
          error: { code: "CONFLICT", message: `Agent ${id} is not running`, retryable: false },
        };
      }
      const prev = agentState;
      agentState = "suspended";
      emitEvent({
        kind: "agent",
        subKind: "status_changed",
        agentId: primaryAgentId,
        from: prev,
        to: "suspended",
        timestamp: Date.now(),
      });
      return { ok: true, value: undefined };
    },

    resumeAgent(id: AgentId): Result<void, KoiError> {
      if (id !== primaryAgentId) {
        return {
          ok: false,
          error: { code: "NOT_FOUND", message: `Agent ${id} not found`, retryable: false },
        };
      }
      if (agentState !== "suspended") {
        return {
          ok: false,
          error: { code: "CONFLICT", message: `Agent ${id} is not suspended`, retryable: false },
        };
      }
      const prev = agentState;
      agentState = "running";
      emitEvent({
        kind: "agent",
        subKind: "status_changed",
        agentId: primaryAgentId,
        from: prev,
        to: "running",
        timestamp: Date.now(),
      });
      return { ok: true, value: undefined };
    },

    terminateAgent(id: AgentId): Result<void, KoiError> | Promise<Result<void, KoiError>> {
      return dataSource.terminateAgent(id);
    },

    // Phase 2 orchestration commands — wrapped to emit SSE events on success
    ...(orchCmds?.signalWorkflow !== undefined
      ? {
          signalWorkflow: withEvent(orchCmds.signalWorkflow, (id, signal) => ({
            kind: "system",
            subKind: "activity",
            message: `Workflow ${id} signaled: ${signal}`,
            timestamp: Date.now(),
          })),
        }
      : {}),
    ...(orchCmds?.terminateWorkflow !== undefined
      ? {
          terminateWorkflow: withEvent(orchCmds.terminateWorkflow, (id) => ({
            kind: "temporal",
            subKind: "workflow_completed",
            workflowId: id,
            timestamp: Date.now(),
          })),
        }
      : {}),
    ...(orchCmds?.pauseSchedule !== undefined
      ? {
          pauseSchedule: withEvent(orchCmds.pauseSchedule, (id) => ({
            kind: "system",
            subKind: "activity",
            message: `Schedule ${id} paused`,
            timestamp: Date.now(),
          })),
        }
      : {}),
    ...(orchCmds?.resumeSchedule !== undefined
      ? {
          resumeSchedule: withEvent(orchCmds.resumeSchedule, (id) => ({
            kind: "system",
            subKind: "activity",
            message: `Schedule ${id} resumed`,
            timestamp: Date.now(),
          })),
        }
      : {}),
    ...(orchCmds?.deleteSchedule !== undefined
      ? {
          deleteSchedule: withEvent(orchCmds.deleteSchedule, (id) => ({
            kind: "system",
            subKind: "activity",
            message: `Schedule ${id} deleted`,
            timestamp: Date.now(),
          })),
        }
      : {}),
    ...(orchCmds?.retrySchedulerDeadLetter !== undefined
      ? {
          retrySchedulerDeadLetter: withEvent(orchCmds.retrySchedulerDeadLetter, (id) => ({
            kind: "scheduler",
            subKind: "task_submitted",
            taskId: id,
            agentId: primaryAgentId,
            timestamp: Date.now(),
          })),
        }
      : {}),
    ...(orchCmds?.pauseHarness !== undefined
      ? {
          pauseHarness: withEvent(orchCmds.pauseHarness, () => ({
            kind: "harness",
            subKind: "phase_changed",
            from: "running",
            to: "paused",
            timestamp: Date.now(),
          })),
        }
      : {}),
    ...(orchCmds?.resumeHarness !== undefined
      ? {
          resumeHarness: withEvent(orchCmds.resumeHarness, () => ({
            kind: "harness",
            subKind: "phase_changed",
            from: "paused",
            to: "running",
            timestamp: Date.now(),
          })),
        }
      : {}),
  };

  const updateMetrics = (metrics: {
    readonly turns: number;
    readonly totalTokens: number;
  }): void => {
    currentTurns = metrics.turns;
    currentTokenCount = metrics.totalTokens;

    emitEvent({
      kind: "agent",
      subKind: "metrics_updated",
      agentId: primaryAgentId,
      turns: metrics.turns,
      tokenCount: metrics.totalTokens,
      timestamp: Date.now(),
    });
  };

  // Emit data source lifecycle events for initial sources (deferred to next tick
  // so SSE subscribers are connected before events fire)
  if (currentSources.length > 0) {
    queueMicrotask(() => {
      for (const source of currentSources) {
        emitEvent({
          kind: "datasource",
          subKind: "data_source_discovered",
          name: source.name,
          protocol: source.protocol,
          source: source.source,
          timestamp: Date.now(),
        });
        // Approved sources have their connectors forged
        if (source.status === "approved") {
          emitEvent({
            kind: "datasource",
            subKind: "connector_forged",
            name: source.name,
            protocol: source.protocol,
            timestamp: Date.now(),
          });
          emitEvent({
            kind: "datasource",
            subKind: "connector_health_update",
            name: source.name,
            healthy: true,
            timestamp: Date.now(),
          });
        }
      }
    });
  }

  return {
    agentId: primaryAgentId,
    dataSource,
    runtimeViews,
    commands,
    ...(options.fileSystem !== undefined ? { fileSystem: options.fileSystem } : {}),
    emitEvent,
    updateMetrics,
    registerDispatchedAgent: (entry: DispatchedAgentEntry): void => {
      dispatchedAgents.set(entry.agentId, { entry, state: "running" });
    },
  };
}
