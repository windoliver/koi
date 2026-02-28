/**
 * Long-running harness — state manager for multi-session agent operation.
 *
 * Called at session boundaries by Node (not a middleware or engine decorator).
 * Owns the task plan, context summaries, and progress tracking.
 * Engine state lives in SessionPersistence (crash recovery).
 * Harness state lives in SnapshotChainStore<HarnessSnapshot> (semantic history).
 */

import type {
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
  Result,
  SessionCheckpoint,
  SessionContext,
  TaskBoardSnapshot,
  TaskItem,
  TaskItemId,
  TaskResult,
  ToolHandler,
  ToolRequest,
  TurnContext,
} from "@koi/core";
import { chainId, sessionId as createSessionId, validation } from "@koi/core";
import { estimateTokens } from "@koi/token-estimator";
import { computeCheckpointId, shouldSoftCheckpoint } from "./checkpoint-policy.js";
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

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a long-running harness for multi-session agent operation.
 */
export function createLongRunningHarness(config: LongRunningConfig): LongRunningHarness {
  const { harnessId, agentId, harnessStore, sessionPersistence } = config;
  const softCheckpointInterval =
    config.softCheckpointInterval ?? DEFAULT_LONG_RUNNING_CONFIG.softCheckpointInterval;
  const maxKeyArtifacts = config.maxKeyArtifacts ?? DEFAULT_LONG_RUNNING_CONFIG.maxKeyArtifacts;
  const maxContextTokens = config.maxContextTokens ?? DEFAULT_LONG_RUNNING_CONFIG.maxContextTokens;
  const artifactToolNames = config.artifactToolNames ?? [];
  const pruningPolicy = config.pruningPolicy ?? DEFAULT_LONG_RUNNING_CONFIG.pruningPolicy;
  const saveState: SaveStateCallback | undefined = config.saveState;

  const cid = chainId(harnessId);

  // Internal mutable state (references to immutable snapshots)
  let currentSnapshot: HarnessSnapshot | undefined;
  let currentNodeId: NodeId | undefined;
  let phase: HarnessPhase = "idle";
  let turnCount = 0;
  let capturedArtifacts: readonly KeyArtifact[] = [];
  let disposed = false;
  let currentSessionId: string | undefined;
  let startedAt: number | undefined;

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

    // Try to load from store if we don't have in-memory snapshot
    if (currentSnapshot === undefined) {
      const headResult = await harnessStore.head(cid);
      if (headResult.ok && headResult.value !== undefined) {
        currentSnapshot = headResult.value.data;
        currentNodeId = headResult.value.nodeId;
      }
    }

    if (currentSnapshot === undefined) {
      return {
        ok: false,
        error: validation("No snapshot available for resume"),
      };
    }

    // Try engine state recovery
    const checkpointResult = await sessionPersistence.loadLatestCheckpoint(config.agentId);

    let _engineStateRecovered = false;

    if (checkpointResult.ok && checkpointResult.value !== undefined) {
      const checkpoint = checkpointResult.value;
      _engineStateRecovered = true;

      const nextSeq = currentSnapshot.sessionSeq + 1;
      const updated: HarnessSnapshot = {
        ...currentSnapshot,
        sessionSeq: nextSeq,
        lastSessionId: sid,
        checkpointedAt: Date.now(),
      };
      await persistSnapshot(updated);
      phase = "active";

      return {
        ok: true,
        value: {
          engineInput: { kind: "resume", state: checkpoint.engineState },
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
    await persistSnapshot(updated);
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

    // Save engine state via session persistence if available
    if (sessionResult.engineState !== undefined) {
      const checkpoint: SessionCheckpoint = {
        id: computeCheckpointId(harnessId, sessionResult.sessionId, turnCount),
        agentId: config.agentId,
        sessionId: createSessionId(sessionResult.sessionId),
        engineState: sessionResult.engineState,
        processState: "running",
        generation: currentSnapshot.sessionSeq,
        metadata: {},
        createdAt: Date.now(),
      };
      await sessionPersistence.saveCheckpoint(checkpoint);
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
          // Capture real engine state if callback provided, else use placeholder
          let engineState: EngineState = { engineId: "soft-checkpoint", data: null };
          if (saveState !== undefined) {
            engineState = await saveState();
          }

          const checkpoint: SessionCheckpoint = {
            id: computeCheckpointId(harnessId, currentSessionId, turnCount),
            agentId: config.agentId,
            sessionId: createSessionId(currentSessionId),
            engineState,
            processState: "running",
            generation: currentSnapshot.sessionSeq,
            metadata: { softCheckpoint: true },
            createdAt: Date.now(),
          };
          // Fire-and-forget
          void sessionPersistence.saveCheckpoint(checkpoint);
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
