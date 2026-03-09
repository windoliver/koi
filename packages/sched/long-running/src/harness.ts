/**
 * Long-running harness — state manager for multi-session agent operation.
 *
 * Called at session boundaries by Node (not a middleware or engine decorator).
 * Owns the task plan, context summaries, and progress tracking.
 * Engine state lives in SessionPersistence (crash recovery).
 * Harness state lives in SnapshotChainStore<HarnessSnapshot> (semantic history).
 */

import type {
  AgentManifest,
  AgentStatus,
  ContextSummary,
  EngineState,
  HarnessMetrics,
  HarnessPhase,
  HarnessSnapshot,
  HarnessStatus,
  KeyArtifact,
  KoiError,
  KoiMiddleware,
  NodeId,
  ProcessState,
  RegistryEntry,
  Result,
  SessionContext,
  SessionRecord,
  TaskBoardSnapshot,
  TaskItem,
  TaskItemId,
  TaskResult,
  ToolHandler,
  ToolRequest,
  TransitionReason,
  TurnContext,
} from "@koi/core";
import { chainId, sessionId as createSessionId, validation } from "@koi/core";
import { estimateTokens } from "@koi/token-estimator";
import { shouldSoftCheckpoint } from "./checkpoint-policy.js";
import { buildInitialPrompt, buildResumeContext } from "./context-bridge.js";
import type {
  LongRunningConfig,
  LongRunningHarness,
  ResumeResult,
  SaveStateCallback,
  SessionResult,
  StartResult,
} from "./types.js";
import { DEFAULT_LONG_RUNNING_CONFIG } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const EMPTY_METRICS: HarnessMetrics = {
  totalSessions: 0,
  totalTurns: 0,
  totalInputTokens: 0,
  totalOutputTokens: 0,
  completedTaskCount: 0,
  pendingTaskCount: 0,
  elapsedMs: 0,
};

function mergeMetrics(base: HarnessMetrics, session: SessionResult): HarnessMetrics {
  return {
    totalSessions: base.totalSessions + 1,
    totalTurns: base.totalTurns + session.metrics.turns,
    totalInputTokens: base.totalInputTokens + session.metrics.inputTokens,
    totalOutputTokens: base.totalOutputTokens + session.metrics.outputTokens,
    completedTaskCount: base.completedTaskCount,
    pendingTaskCount: base.pendingTaskCount,
    elapsedMs: base.elapsedMs + session.metrics.durationMs,
  };
}

function generateSessionId(): string {
  return `session-${crypto.randomUUID()}`;
}

function countByStatus(board: TaskBoardSnapshot, status: string): number {
  return board.items.filter((i: TaskItem) => i.status === status).length;
}

function updateTaskInBoard(
  board: TaskBoardSnapshot,
  taskId: TaskItemId,
  result: TaskResult,
): TaskBoardSnapshot {
  const updatedItems: readonly TaskItem[] = board.items.map((item: TaskItem) =>
    item.id === taskId ? { ...item, status: "completed" as const } : item,
  );
  return {
    items: updatedItems,
    results: [...board.results, result],
  };
}

function allTasksCompleted(board: TaskBoardSnapshot): boolean {
  return board.items.every(
    (item: TaskItem) => item.status === "completed" || item.status === "failed",
  );
}

/**
 * Map a ProcessState + optional reason to HarnessPhase for snapshot serialization.
 *
 * Mapping: created→idle, running→active, waiting→active,
 * suspended→suspended, terminated(completed)→completed, terminated(error)→failed.
 */
export function mapProcessStateToHarnessPhase(
  processState: ProcessState,
  reason?: TransitionReason,
): HarnessPhase {
  switch (processState) {
    case "created":
      return "idle";
    case "running":
    case "waiting":
      return "active";
    case "suspended":
      return "suspended";
    case "idle":
      return "idle";
    case "terminated":
      return reason?.kind === "completed" ? "completed" : "failed";
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a long-running harness for multi-session agent operation.
 */
export function createLongRunningHarness(config: LongRunningConfig): LongRunningHarness {
  const { harnessId, agentId, harnessStore, sessionPersistence, registry } = config;
  const softCheckpointInterval =
    config.softCheckpointInterval ?? DEFAULT_LONG_RUNNING_CONFIG.softCheckpointInterval;
  const maxKeyArtifacts = config.maxKeyArtifacts ?? DEFAULT_LONG_RUNNING_CONFIG.maxKeyArtifacts;
  const maxContextTokens = config.maxContextTokens ?? DEFAULT_LONG_RUNNING_CONFIG.maxContextTokens;
  const artifactToolNames = config.artifactToolNames ?? [];
  const pruningPolicy = config.pruningPolicy ?? DEFAULT_LONG_RUNNING_CONFIG.pruningPolicy;
  const saveState: SaveStateCallback | undefined = config.saveState;

  const cid = chainId(harnessId);

  // Minimal manifest snapshot for session records (harness-internal)
  const harnessManifest: AgentManifest = {
    name: `harness-${harnessId}`,
    version: "0.0.0",
  } as AgentManifest;

  // Internal mutable state (references to immutable snapshots)
  let currentSnapshot: HarnessSnapshot | undefined;
  let currentNodeId: NodeId | undefined;
  let phase: HarnessPhase = "idle"; // let: local cache; updated after each transition
  let turnCount = 0;
  let capturedArtifacts: readonly KeyArtifact[] = [];
  let disposed = false;
  let currentSessionId: string | undefined;
  let startedAt: number | undefined;
  let registryGeneration = 0; // let: CAS generation counter for registry transitions

  // -------------------------------------------------------------------------
  // Snapshot persistence
  // -------------------------------------------------------------------------

  async function persistSnapshot(snapshot: HarnessSnapshot): Promise<Result<void, KoiError>> {
    const parentIds = currentNodeId !== undefined ? [currentNodeId] : [];
    const putResult = await harnessStore.put(cid, snapshot, parentIds);
    if (!putResult.ok) return putResult;
    if (putResult.value !== undefined) {
      currentNodeId = putResult.value.nodeId;
    }
    currentSnapshot = snapshot;
    return { ok: true, value: undefined };
  }

  // -------------------------------------------------------------------------
  // Session record helpers
  // -------------------------------------------------------------------------

  function buildSessionRecord(sid: string, engineState?: EngineState | undefined): SessionRecord {
    const now = Date.now();
    const base: SessionRecord = {
      sessionId: createSessionId(sid),
      agentId: config.agentId,
      manifestSnapshot: harnessManifest,
      seq: 0,
      remoteSeq: 0,
      connectedAt: startedAt ?? now,
      lastPersistedAt: now,
      metadata: { harnessId },
    };
    if (engineState !== undefined) {
      return { ...base, lastEngineState: engineState };
    }
    return base;
  }

  // -------------------------------------------------------------------------
  // Guard helpers
  // -------------------------------------------------------------------------

  function guardDisposed(): Result<void, KoiError> {
    if (disposed) {
      return { ok: false, error: validation("Harness has been disposed") };
    }
    return { ok: true, value: undefined };
  }

  function guardPhase(...allowed: readonly HarnessPhase[]): Result<void, KoiError> {
    if (!allowed.includes(phase)) {
      return {
        ok: false,
        error: validation(`Invalid phase: expected one of [${allowed.join(", ")}], got "${phase}"`),
      };
    }
    return { ok: true, value: undefined };
  }

  // -------------------------------------------------------------------------
  // Registry integration helpers
  // -------------------------------------------------------------------------

  /**
   * Register the agent in the registry at "created" phase.
   * No-op when registry is not provided.
   */
  async function registryRegister(now: number): Promise<void> {
    if (registry === undefined) return;
    const status: AgentStatus = {
      phase: "created",
      generation: 0,
      conditions: [],
      lastTransitionAt: now,
    };
    const entry: RegistryEntry = {
      agentId,
      status,
      agentType: "worker",
      metadata: { harnessId },
      registeredAt: now,
      priority: 10,
    };
    const registered = await registry.register(entry);
    registryGeneration = registered.status.generation;
  }

  /**
   * Perform a CAS state transition in the registry.
   * No-op when registry is not provided. Updates local generation on success.
   */
  async function registryTransition(
    targetPhase: ProcessState,
    reason: TransitionReason,
  ): Promise<Result<void, KoiError>> {
    if (registry === undefined) return { ok: true, value: undefined };
    const result = await registry.transition(agentId, targetPhase, registryGeneration, reason);
    if (!result.ok) return result;
    registryGeneration = result.value.status.generation;
    return { ok: true, value: undefined };
  }

  // -------------------------------------------------------------------------
  // start()
  // -------------------------------------------------------------------------

  const start = async (taskPlan: TaskBoardSnapshot): Promise<Result<StartResult, KoiError>> => {
    const dg = guardDisposed();
    if (!dg.ok) return dg;
    const pg = guardPhase("idle");
    if (!pg.ok) return pg;

    if (taskPlan.items.length === 0) {
      return { ok: false, error: validation("Task plan must have at least one task") };
    }

    const now = Date.now();
    const sid = generateSessionId();
    startedAt = now;
    currentSessionId = sid;

    const snapshot: HarnessSnapshot = {
      harnessId,
      phase: "active",
      sessionSeq: 1,
      taskBoard: taskPlan,
      summaries: [],
      keyArtifacts: [],
      lastSessionId: sid,
      agentId,
      metrics: {
        ...EMPTY_METRICS,
        pendingTaskCount: taskPlan.items.length,
      },
      startedAt: now,
      checkpointedAt: now,
    };

    const persistResult = await persistSnapshot(snapshot);
    if (!persistResult.ok) return persistResult;

    // Register in registry at "created", then transition to "running"
    await registryRegister(now);
    const transResult = await registryTransition("running", { kind: "assembly_complete" });
    if (!transResult.ok) return transResult;

    phase = "active";
    turnCount = 0;
    capturedArtifacts = [];

    const promptText = buildInitialPrompt(taskPlan);

    return {
      ok: true,
      value: {
        engineInput: { kind: "text", text: promptText },
        sessionId: sid,
      },
    };
  };

  // -------------------------------------------------------------------------
  // resume()
  // -------------------------------------------------------------------------

  const resume = async (): Promise<Result<ResumeResult, KoiError>> => {
    const dg = guardDisposed();
    if (!dg.ok) return dg;
    const pg = guardPhase("suspended");
    if (!pg.ok) return pg;

    const sid = generateSessionId();
    currentSessionId = sid;
    turnCount = 0;
    capturedArtifacts = [];

    // Parallelize I/O: snapshot head load + session recovery (Decision 14A)
    const needsHead = currentSnapshot === undefined;
    const lastSidForLoad = currentSnapshot?.lastSessionId;

    const [headResult, sessionResult] = await Promise.all([
      needsHead ? harnessStore.head(cid) : undefined,
      lastSidForLoad !== undefined ? sessionPersistence.loadSession(lastSidForLoad) : undefined,
    ]);

    if (needsHead && headResult !== undefined && headResult.ok && headResult.value !== undefined) {
      currentSnapshot = headResult.value.data;
      currentNodeId = headResult.value.nodeId;
    }

    if (currentSnapshot === undefined) {
      return {
        ok: false,
        error: validation("No snapshot available for resume"),
      };
    }

    // If we didn't have lastSid before loading head, try again with the loaded snapshot
    let resolvedSessionResult = sessionResult;
    if (lastSidForLoad === undefined && currentSnapshot.lastSessionId !== undefined) {
      resolvedSessionResult = await sessionPersistence.loadSession(currentSnapshot.lastSessionId);
    }

    const lastEngineState = resolvedSessionResult?.ok
      ? resolvedSessionResult.value.lastEngineState
      : undefined;

    if (lastEngineState !== undefined) {
      const nextSeq = currentSnapshot.sessionSeq + 1;
      const updated: HarnessSnapshot = {
        ...currentSnapshot,
        sessionSeq: nextSeq,
        lastSessionId: sid,
        checkpointedAt: Date.now(),
      };
      const persistResult = await persistSnapshot(updated);
      if (!persistResult.ok) return persistResult;

      // Transition from suspended → running
      const transResult = await registryTransition("running", { kind: "signal_cont" });
      if (!transResult.ok) return transResult;
      phase = "active";

      return {
        ok: true,
        value: {
          engineInput: { kind: "resume", state: lastEngineState },
          sessionId: sid,
          engineStateRecovered: true,
        },
      };
    }

    // Fallback: build resume context from summaries
    const contextResult = buildResumeContext(currentSnapshot, { maxContextTokens });
    if (!contextResult.ok) return contextResult;

    const nextSeq = currentSnapshot.sessionSeq + 1;
    const updated: HarnessSnapshot = {
      ...currentSnapshot,
      sessionSeq: nextSeq,
      lastSessionId: sid,
      checkpointedAt: Date.now(),
    };
    const persistResult = await persistSnapshot(updated);
    if (!persistResult.ok) return persistResult;

    // Transition from suspended → running
    const transResult = await registryTransition("running", { kind: "signal_cont" });
    if (!transResult.ok) return transResult;
    phase = "active";

    return {
      ok: true,
      value: {
        engineInput: { kind: "messages", messages: contextResult.value },
        sessionId: sid,
        engineStateRecovered: false,
      },
    };
  };

  // -------------------------------------------------------------------------
  // pause()
  // -------------------------------------------------------------------------

  const pause = async (sessionResult: SessionResult): Promise<Result<void, KoiError>> => {
    const dg = guardDisposed();
    if (!dg.ok) return dg;
    const pg = guardPhase("active");
    if (!pg.ok) return pg;

    if (currentSnapshot === undefined) {
      return { ok: false, error: validation("No active snapshot to pause") };
    }

    // Merge metrics
    const mergedMetrics = mergeMetrics(currentSnapshot.metrics, sessionResult);
    const updatedMetrics: HarnessMetrics = {
      ...mergedMetrics,
      completedTaskCount: countByStatus(currentSnapshot.taskBoard, "completed"),
      pendingTaskCount: countByStatus(currentSnapshot.taskBoard, "pending"),
    };

    // Build summary if provided
    const newSummaries: readonly ContextSummary[] =
      sessionResult.summary !== undefined
        ? [
            ...currentSnapshot.summaries,
            {
              narrative: sessionResult.summary,
              sessionSeq: currentSnapshot.sessionSeq,
              completedTaskIds: currentSnapshot.taskBoard.results.map((r: TaskResult) => r.taskId),
              estimatedTokens: estimateTokens(sessionResult.summary),
              generatedAt: Date.now(),
            },
          ]
        : currentSnapshot.summaries;

    // Persist engine state in session record for fast recovery
    if (currentSessionId !== undefined) {
      const record = buildSessionRecord(currentSessionId, sessionResult.engineState);
      await sessionPersistence.saveSession(record);
    }

    // Limit artifacts
    const allArtifacts = [...currentSnapshot.keyArtifacts, ...capturedArtifacts];
    const limitedArtifacts = allArtifacts.slice(-maxKeyArtifacts);

    // Hard checkpoint
    const now = Date.now();
    const snapshot: HarnessSnapshot = {
      ...currentSnapshot,
      phase: "suspended",
      summaries: newSummaries,
      keyArtifacts: limitedArtifacts,
      metrics: updatedMetrics,
      checkpointedAt: now,
    };

    const persistResult = await persistSnapshot(snapshot);
    if (!persistResult.ok) return persistResult;

    // Transition from running → suspended
    const transResult = await registryTransition("suspended", { kind: "signal_stop" });
    if (!transResult.ok) return transResult;
    phase = "suspended";
    capturedArtifacts = [];

    // Fire-and-forget pruning
    void harnessStore.prune(cid, pruningPolicy);

    return { ok: true, value: undefined };
  };

  // -------------------------------------------------------------------------
  // completeTask()
  // -------------------------------------------------------------------------

  const completeTask = async (
    taskId: TaskItemId,
    result: TaskResult,
  ): Promise<Result<void, KoiError>> => {
    const dg = guardDisposed();
    if (!dg.ok) return dg;
    const pg = guardPhase("active", "suspended");
    if (!pg.ok) return pg;

    if (currentSnapshot === undefined) {
      return { ok: false, error: validation("No active snapshot") };
    }

    // Verify task exists
    const task = currentSnapshot.taskBoard.items.find((i: TaskItem) => i.id === taskId);
    if (task === undefined) {
      return {
        ok: false,
        error: {
          code: "NOT_FOUND",
          message: `Task not found: ${taskId}`,
          retryable: false,
        },
      };
    }

    // Verify task is in "assigned" status before completing
    if (task.status !== "assigned") {
      return {
        ok: false,
        error: validation(
          `Cannot complete task ${taskId}: expected status "assigned", got "${task.status}"`,
        ),
      };
    }

    const updatedBoard = updateTaskInBoard(currentSnapshot.taskBoard, taskId, result);

    const updatedMetrics: HarnessMetrics = {
      ...currentSnapshot.metrics,
      completedTaskCount: countByStatus(updatedBoard, "completed"),
      pendingTaskCount: countByStatus(updatedBoard, "pending"),
    };

    const allDone = allTasksCompleted(updatedBoard);
    const nextPhase: HarnessPhase = allDone ? "completed" : phase;

    const snapshot: HarnessSnapshot = {
      ...currentSnapshot,
      phase: nextPhase,
      taskBoard: updatedBoard,
      metrics: updatedMetrics,
      checkpointedAt: Date.now(),
    };

    const persistResult = await persistSnapshot(snapshot);
    if (!persistResult.ok) return persistResult;

    if (allDone) {
      // Transition to terminated with success outcome
      const transResult = await registryTransition("terminated", { kind: "completed" });
      if (!transResult.ok) return transResult;
      phase = "completed";
    }

    return { ok: true, value: undefined };
  };

  // -------------------------------------------------------------------------
  // fail()
  // -------------------------------------------------------------------------

  let failureReason: string | undefined;

  const fail = async (error: KoiError): Promise<Result<void, KoiError>> => {
    const dg = guardDisposed();
    if (!dg.ok) return dg;
    const pg = guardPhase("active", "suspended");
    if (!pg.ok) return pg;

    if (currentSnapshot === undefined) {
      return { ok: false, error: validation("No active snapshot to fail") };
    }

    failureReason = error.message;

    const snapshot: HarnessSnapshot = {
      ...currentSnapshot,
      phase: "failed",
      failureReason: error.message,
      checkpointedAt: Date.now(),
    };

    const persistResult = await persistSnapshot(snapshot);
    if (!persistResult.ok) return persistResult;

    // Transition to terminated with error outcome
    const transResult = await registryTransition("terminated", {
      kind: "error",
      cause: error.message,
    });
    if (!transResult.ok) return transResult;
    phase = "failed";
    return { ok: true, value: undefined };
  };

  // -------------------------------------------------------------------------
  // status()
  // -------------------------------------------------------------------------

  const status = (): HarnessStatus => {
    const snap = currentSnapshot;
    const board: TaskBoardSnapshot = snap?.taskBoard ?? { items: [], results: [] };
    const metrics: HarnessMetrics = snap?.metrics ?? EMPTY_METRICS;

    return {
      harnessId,
      phase,
      currentSessionSeq: snap?.sessionSeq ?? 0,
      taskBoard: board,
      metrics,
      lastSessionEndedAt: snap?.checkpointedAt,
      startedAt,
      failureReason,
    };
  };

  // -------------------------------------------------------------------------
  // createMiddleware()
  // -------------------------------------------------------------------------

  const createMiddleware = (): KoiMiddleware => {
    const artifactSet = new Set(artifactToolNames);

    return {
      name: "long-running-harness",
      describeCapabilities: () => undefined,
      priority: 50,

      async onAfterTurn(_ctx: TurnContext): Promise<void> {
        turnCount += 1;

        if (
          shouldSoftCheckpoint(turnCount, softCheckpointInterval) &&
          currentSnapshot !== undefined &&
          currentSessionId !== undefined
        ) {
          // Capture real engine state if callback provided
          const engineState = saveState !== undefined ? await saveState() : undefined;
          // Persist engine state in session record (fire-and-forget)
          const record = buildSessionRecord(currentSessionId, engineState);
          void sessionPersistence.saveSession(record);
        }
      },

      async onSessionEnd(_ctx: SessionContext): Promise<void> {
        // Flush any remaining captured artifacts into the snapshot
        if (capturedArtifacts.length > 0 && currentSnapshot !== undefined) {
          const allArtifacts = [...currentSnapshot.keyArtifacts, ...capturedArtifacts];
          const limitedArtifacts = allArtifacts.slice(-maxKeyArtifacts);
          const updated: HarnessSnapshot = {
            ...currentSnapshot,
            keyArtifacts: limitedArtifacts,
            checkpointedAt: Date.now(),
          };
          await persistSnapshot(updated);
          capturedArtifacts = [];
        }
      },

      async wrapToolCall(ctx: TurnContext, request: ToolRequest, next: ToolHandler) {
        const response = await next(request);

        if (artifactSet.has(request.toolId) && response.output !== undefined) {
          const content =
            typeof response.output === "string" ? response.output : JSON.stringify(response.output);

          const artifact: KeyArtifact = {
            toolName: request.toolId,
            content: content.slice(0, 2000), // Limit artifact size
            turnIndex: ctx.turnIndex,
            capturedAt: Date.now(),
          };
          capturedArtifacts = [...capturedArtifacts, artifact];
        }

        return response;
      },
    };
  };

  // -------------------------------------------------------------------------
  // dispose()
  // -------------------------------------------------------------------------

  const dispose = async (): Promise<void> => {
    disposed = true;
    if (registry !== undefined) {
      await registry.deregister(agentId);
    }
  };

  // -------------------------------------------------------------------------
  // Return harness
  // -------------------------------------------------------------------------

  return {
    harnessId,
    start,
    resume,
    pause,
    fail,
    completeTask,
    status,
    createMiddleware,
    dispose,
  };
}
