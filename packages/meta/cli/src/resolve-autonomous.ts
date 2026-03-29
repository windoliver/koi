/**
 * resolveAutonomousOrWarn — conditionally bootstrap autonomous agent mode.
 *
 * When the manifest declares `autonomous.enabled: true`, lazily loads
 * @koi/autonomous and its dependencies, creates stores (Nexus-backed when
 * a connection is provided, in-memory otherwise), resolves manifest-declared
 * agents as named spawn targets, and returns the autonomous agent with its
 * harness for orchestration wiring.
 *
 * The harness is wrapped as a HarnessAdminClientLike so the orchestration
 * resolver can create dashboard views. Pause/resume are not exposed through
 * the admin client (they require session context that the admin panel lacks).
 */

import type {
  AgentId,
  ComponentProvider,
  EngineAdapter,
  EngineMetrics,
  HarnessSnapshot,
  HarnessStatus,
  KoiError,
  KoiMiddleware,
  MailboxComponent,
  ManifestAgentEntry,
  Result,
  SpawnFn,
} from "@koi/core";
import { agentId, harnessId } from "@koi/core";
import type { HarnessAdminClientLike } from "@koi/dashboard-api";
import type { StackContribution } from "./contribution-graph.js";
import { createInMemorySessionPersistence } from "./in-memory-session-persistence.js";
import type { ResolvedNexusConnectionLike } from "./resolve-nexus.js";

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

export interface AutonomousResult {
  /** Harness wrapped for admin panel consumption. */
  readonly harness: HarnessAdminClientLike;
  /** Middleware to inject into createForgeConfiguredKoi (harness + checkpoint + inbox). */
  readonly middleware: readonly KoiMiddleware[];
  /** Component providers to inject into createForgeConfiguredKoi. */
  readonly providers: readonly ComponentProvider[];
  /** Dispose autonomous agent (scheduler first, then harness). */
  readonly dispose: () => Promise<void>;
  /**
   * Bind the notification target after agent assembly. Once bound, the harness
   * sends a push notification to the initiator's inbox on completion or failure.
   * Call this after createForgeConfiguredKoi() when the mailbox is available.
   */
  readonly bindNotification: (initiatorId: AgentId, mailbox: MailboxComponent) => void;
  /**
   * Pause the harness after a session completes. Transitions active → suspended
   * so the scheduler can resume the next session.
   */
  readonly pauseHarness: (sessionResult: {
    readonly sessionId: string;
    readonly metrics: EngineMetrics;
    readonly summary?: string | undefined;
  }) => Promise<Result<void, KoiError>>;
  /**
   * Bind a session runner callback. Called by the scheduler after resume()
   * to run the engine sub-session. Deferred because the runtime is created
   * after the scheduler.
   */
  readonly bindSessionRunner: (runner: (resumeResult: unknown) => Promise<void>) => void;
  /**
   * Bind a spawn function for delegation bridge dispatch. Once bound, tasks
   * with `delegation: "spawn"` are auto-dispatched to worker agents.
   * Deferred because SpawnFn requires engine runtime context.
   */
  readonly bindSpawn: (spawn: SpawnFn) => void;
  /**
   * Bind a dashboard event callback for real-time TUI task board updates.
   * When bound, task status changes push events via SSE to the TUI.
   * Deferred because the dashboard bridge is created after the autonomous agent.
   */
  readonly bindDashboardEvent: (
    emitter: (event: {
      readonly kind: "taskboard";
      readonly subKind: "task_status_changed";
      readonly taskId: string;
      readonly status: string;
      readonly timestamp: number;
    }) => void,
  ) => void;
}

/** Autonomous resolution result bundled with contribution metadata. */
export interface AutonomousResolutionWithContribution {
  readonly result: AutonomousResult | undefined;
  readonly contribution: StackContribution;
}

// ---------------------------------------------------------------------------
// Manifest detection
// ---------------------------------------------------------------------------

/** Check if the manifest declares autonomous mode via extension field. */
function isAutonomousEnabled(manifest: { readonly autonomous?: unknown }): boolean {
  const autonomous = manifest.autonomous;
  if (autonomous === null || autonomous === undefined || typeof autonomous !== "object") {
    return false;
  }
  const obj = autonomous as Record<string, unknown>;
  return obj.enabled === true;
}

// ---------------------------------------------------------------------------
// Harness → Admin client wrapper
// ---------------------------------------------------------------------------

/**
 * Wrap a LongRunningHarness as HarnessAdminClientLike for the admin panel.
 *
 * Status is forwarded directly (structurally compatible). Pause/resume are
 * NOT exposed — they require session context that the admin panel lacks.
 * The dashboard adapter will show "not supported" for those actions.
 */
function mapHarnessToAdminClient(harness: {
  readonly status: () => unknown;
}): HarnessAdminClientLike {
  // HarnessStatus from core is structurally compatible with HarnessStatusLike.
  // Cast through unknown because the branded types don't directly overlap.
  return {
    status: () => harness.status() as ReturnType<HarnessAdminClientLike["status"]>,
  };
}

// ---------------------------------------------------------------------------
// Manifest agent → EngineAdapter resolution
// ---------------------------------------------------------------------------

/**
 * Lazily resolve a ManifestAgentEntry to an EngineAdapter.
 *
 * Only CLI transport is currently supported:
 * - protocol: "acp" → @koi/engine-acp (AcpAdapter for Claude Code, etc.)
 * - protocol: "stdio" or undefined → @koi/engine-external (single-shot CLI)
 *
 * Returns undefined for unsupported transports (mcp, a2a) so callers
 * can log a warning instead of silently routing through the wrong runtime.
 */
async function resolveAdapterForEntry(
  entry: ManifestAgentEntry,
): Promise<EngineAdapter | undefined> {
  if (entry.command === undefined) return undefined;

  // Only CLI transport is supported for adapter resolution.
  // MCP and A2A require their own adapter implementations (future work).
  if (entry.transport !== "cli") return undefined;

  if (entry.protocol === "acp") {
    const { createAcpAdapter } = await import("@koi/engine-acp");
    return createAcpAdapter({ command: entry.command });
  }

  const { createExternalAdapter } = await import("@koi/engine-external");
  return createExternalAdapter({
    command: entry.command,
    mode: "single-shot",
  });
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export async function resolveAutonomousOrWarn(
  manifest: {
    readonly autonomous?: unknown;
    readonly name: string;
    readonly agents?: readonly ManifestAgentEntry[] | undefined;
  },
  verbose?: boolean,
  nexus?: ResolvedNexusConnectionLike | undefined,
): Promise<AutonomousResolutionWithContribution> {
  if (!isAutonomousEnabled(manifest)) {
    return {
      result: undefined,
      contribution: {
        id: "autonomous",
        label: "Autonomous",
        enabled: false,
        source: "runtime",
        status: "skipped",
        reason: "autonomous.enabled not set",
        packages: [],
      },
    };
  }

  try {
    // Lazy imports — only loaded when autonomous mode is enabled.
    // Nexus imports are conditional on nexus config presence (Decision #16A).
    const hasManifestAgents = manifest.agents !== undefined && manifest.agents.length > 0;
    const [
      { createAutonomousAgent, createCompletionNotifier },
      { createLongRunningHarness },
      { createHarnessScheduler },
      { createInMemorySnapshotChainStore, createThreadStore },
      nexusStoreModule,
      nexusRegistryModule,
      { withRetry },
      adapterSpawnerModule,
    ] = await Promise.all([
      import("@koi/autonomous"),
      import("@koi/long-running"),
      import("@koi/harness-scheduler"),
      import("@koi/snapshot-chain-store"),
      nexus !== undefined ? import("@koi/nexus-store") : Promise.resolve(undefined),
      nexus !== undefined ? import("@koi/registry-nexus") : Promise.resolve(undefined),
      import("@koi/errors"),
      hasManifestAgents ? import("@koi/agent-spawner") : Promise.resolve(undefined),
    ]);

    const hId = harnessId(`${manifest.name}-harness`);
    const aId = agentId(`${manifest.name}-agent`);

    // --- Store initialization: Nexus-backed (persistent) or in-memory (ephemeral) ---
    let harnessStore: import("@koi/core").SnapshotChainStore<HarnessSnapshot>;
    let sessionPersistence: import("@koi/core").SessionPersistence;
    let registry:
      | Awaited<ReturnType<typeof import("@koi/registry-nexus").createNexusRegistry>>
      | undefined;
    const useNexus =
      nexus !== undefined && nexusStoreModule !== undefined && nexusRegistryModule !== undefined;

    if (useNexus) {
      // Single withRetry wrapping all Nexus init (Decisions #2C, #13A)
      const nexusStores = await withRetry(
        async () => {
          const store = nexusStoreModule.createNexusSnapshotStore<HarnessSnapshot>({
            ...nexus,
            basePath: "harness-snapshots",
          });
          const session = nexusStoreModule.createNexusSessionStore({
            ...nexus,
            basePath: "harness-sessions",
          });
          const reg = await nexusRegistryModule.createNexusRegistry({
            ...nexus,
            pollIntervalMs: 30_000, // Decision #15B
          });
          return { store, session, reg };
        },
        {
          maxRetries: 3,
          initialDelayMs: 2_000,
          maxBackoffMs: 10_000,
          backoffMultiplier: 2,
          jitter: true,
          jitterStrategy: "full" as const,
        },
      );
      harnessStore = nexusStores.store;
      sessionPersistence = nexusStores.session;
      registry = nexusStores.reg;
    } else {
      harnessStore = createInMemorySnapshotChainStore<HarnessSnapshot>();
      sessionPersistence = createInMemorySessionPersistence();
      registry = undefined;
    }

    const threadSnapshotStore =
      createInMemorySnapshotChainStore<import("@koi/core").ThreadSnapshot>();
    const threadStore = createThreadStore({ store: threadSnapshotStore });

    // --- Manifest agent adapters: build namedSpawns map for routing ---
    const namedSpawns = new Map<string, SpawnFn>();
    const adapterDisposables: EngineAdapter[] = [];

    if (hasManifestAgents && adapterSpawnerModule !== undefined && manifest.agents !== undefined) {
      const { validateManifestAgents, createAdapterSpawnFn } = adapterSpawnerModule;
      // Log validation warnings but continue per-entry (don't let one bad entry disable all)
      const validation = validateManifestAgents(manifest.agents);
      if (!validation.ok) {
        process.stderr.write(`[autonomous] warn: ${validation.error.message}\n`);
      }

      for (const entry of manifest.agents) {
        if (entry.command === undefined) continue;
        if (entry.transport === "cli" && entry.command.length === 0) continue;
        // Resolve adapter — returns undefined for unsupported transports (mcp, a2a)
        const adapter = await resolveAdapterForEntry(entry);
        if (adapter === undefined) {
          if (entry.transport !== "cli") {
            process.stderr.write(
              `[autonomous] warn: agent '${entry.name}' uses unsupported transport '${entry.transport}' — skipping\n`,
            );
          }
          continue;
        }
        adapterDisposables.push(adapter);
        namedSpawns.set(entry.name, createAdapterSpawnFn(adapter));
      }
    }

    // Deferred notification target — set after agent assembly via bindNotification().
    // let justified: mutable refs populated post-assembly when mailbox is available.
    let notifyMailbox: MailboxComponent | undefined;
    let notifyInitiatorId: AgentId | undefined;

    // Deferred spawn function — set after runtime assembly via bindSpawn().
    // let justified: mutable ref populated post-assembly when engine spawn is available.
    let boundSpawn: SpawnFn | undefined;
    // let justified: deferred dashboard event emitter, bound after bridge is created
    type TaskBoardEventEmitter = Parameters<AutonomousResult["bindDashboardEvent"]>[0];
    let boundDashboardEmitter: TaskBoardEventEmitter | undefined;

    // DRY helper: get notifier if notification target is bound (Decision #5A)
    const getNotifier = () => {
      if (notifyMailbox === undefined || notifyInitiatorId === undefined) return undefined;
      return createCompletionNotifier({
        initiatorId: notifyInitiatorId,
        agentId: aId,
        mailbox: notifyMailbox,
      });
    };

    const harness = createLongRunningHarness({
      harnessId: hId,
      agentId: aId,
      harnessStore,
      sessionPersistence,
      registry, // Sub-task #5: workers registered in Nexus for IPC
      onCompleted: async (status: HarnessStatus) => {
        await getNotifier()?.onCompleted(status);
        const { completedTaskCount, pendingTaskCount } = status.metrics;
        const total = completedTaskCount + pendingTaskCount;
        process.stderr.write(
          `[autonomous] ✓ Autonomous plan completed. ${String(completedTaskCount)}/${String(total)} tasks done.\n`,
        );
      },
      onFailed: async (status: HarnessStatus, error: KoiError) => {
        await getNotifier()?.onFailed(status, error);
        const { completedTaskCount, pendingTaskCount } = status.metrics;
        const total = completedTaskCount + pendingTaskCount;
        process.stderr.write(
          `[autonomous] ✗ Autonomous plan failed: ${error.message}. ${String(completedTaskCount)}/${String(total)} tasks completed.\n`,
        );
      },
    });

    // Deferred session runner — set after runtime assembly via bindSessionRunner().
    // let justified: mutable ref populated post-assembly when runtime is available.
    let boundSessionRunner: ((resumeResult: unknown) => Promise<void>) | undefined;

    const scheduler = createHarnessScheduler({
      harness,
      onResumed: async (resumeResult: unknown) => {
        if (boundSessionRunner === undefined) {
          process.stderr.write(
            "[autonomous] warn: scheduler resumed but session runner not bound — skipping\n",
          );
          return;
        }
        process.stderr.write("[autonomous] scheduler driving sub-session...\n");
        await boundSessionRunner(resumeResult);
      },
    });

    const agent = createAutonomousAgent({
      harness,
      scheduler,
      getSpawn: () => boundSpawn,
      threadStore,
      taskBoardGoalStack: true,
      onTaskBoardEvent: (event) => boundDashboardEmitter?.(event),
    });

    const storeLabel = useNexus ? "Nexus-backed stores" : "in-memory stores";
    if (verbose) {
      process.stderr.write(`Autonomous mode: enabled (${storeLabel})\n`);
    }

    const autonomousResult: AutonomousResult = {
      harness: mapHarnessToAdminClient(harness),
      middleware: agent.middleware(),
      providers: agent.providers(),
      dispose: async () => {
        // Dispose in reverse-creation order (Decision #4A)
        await agent.dispose();
        for (const adapter of adapterDisposables) {
          await adapter.dispose?.();
        }
        if (registry !== undefined) {
          await registry[Symbol.asyncDispose]();
        }
        sessionPersistence.close();
      },
      bindNotification: (initiatorId: AgentId, mailbox: MailboxComponent) => {
        notifyInitiatorId = initiatorId;
        notifyMailbox = mailbox;
      },
      pauseHarness: (sessionResult) => harness.pause(sessionResult),
      bindSessionRunner: (runner) => {
        boundSessionRunner = runner;
      },
      bindSpawn: (spawn: SpawnFn) => {
        // Compose with named spawns from manifest.agents[] if available
        if (namedSpawns.size > 0) {
          boundSpawn = async (request) => {
            const named = namedSpawns.get(request.agentName);
            if (named !== undefined) return named(request);
            return spawn(request);
          };
        } else {
          boundSpawn = spawn;
        }
      },
      bindDashboardEvent: (emitter) => {
        boundDashboardEmitter = emitter;
      },
    };

    const packages: StackContribution["packages"][number][] = [];
    if (autonomousResult.middleware.length > 0) {
      packages.push({
        id: "@koi/autonomous",
        kind: "middleware",
        source: "static",
        middlewareNames: autonomousResult.middleware.map((m) => m.name),
      });
    }
    if (autonomousResult.providers.length > 0) {
      packages.push({
        id: "@koi/autonomous",
        kind: "provider",
        source: "static",
        providerNames: autonomousResult.providers.map((p) => p.name),
      });
    }
    // Sub-packages
    packages.push(
      {
        id: "@koi/long-running",
        kind: "subsystem",
        source: "static",
        notes: ["harness lifecycle"],
      },
      {
        id: "@koi/harness-scheduler",
        kind: "subsystem",
        source: "static",
        notes: ["task scheduling"],
      },
      {
        id: useNexus ? "@koi/nexus-store" : "@koi/snapshot-chain-store",
        kind: "subsystem",
        source: "static",
        notes: [useNexus ? "Nexus-backed persistence" : "in-memory persistence"],
      },
    );
    if (useNexus) {
      packages.push({
        id: "@koi/registry-nexus",
        kind: "subsystem",
        source: "static",
        notes: ["Nexus agent registry"],
      });
    }
    if (namedSpawns.size > 0) {
      packages.push({
        id: "@koi/agent-spawner",
        kind: "subsystem",
        source: "static",
        notes: [`${String(namedSpawns.size)} manifest agent(s)`],
      });
    }

    return {
      result: autonomousResult,
      contribution: {
        id: "autonomous",
        label: "Autonomous",
        enabled: true,
        source: "runtime",
        status: "active",
        packages,
      },
    };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(`warn: autonomous mode failed to initialize: ${msg}\n`);
    return {
      result: undefined,
      contribution: {
        id: "autonomous",
        label: "Autonomous",
        enabled: false,
        source: "runtime",
        status: "failed",
        reason: msg,
        packages: [
          { id: "@koi/autonomous", kind: "subsystem", source: "static", notes: ["not available"] },
        ],
      },
    };
  }
}
