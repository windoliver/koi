import type { Playbook, PlaybookStore, TrajectoryStore } from "@koi/ace-types";
import type { SessionContext } from "@koi/core";

import type { AceStructuredPipelineConfig as _Pipe, AceSessionState } from "./ace-middleware.js";
import type { ConsolidateFn } from "./consolidator.js";
import {
  extractStageSafe,
  type FailureContext,
  invokeOnErrorDetached,
  logFailureSafe,
  runStructuredPipeline,
} from "./pipeline-helpers.js";
import { aggregateTrajectoryStats, curateTrajectorySummary } from "./stats-aggregator.js";

export interface TeardownDeps {
  readonly state: AceSessionState;
  readonly ctx: SessionContext;
  readonly sessions: Map<string, AceSessionState>;
  readonly drainTimeoutMs: number;
  readonly trajectoryStore: TrajectoryStore | undefined;
  readonly structuredPipeline: _Pipe | undefined;
  readonly playbookStore: PlaybookStore;
  readonly consolidate: ConsolidateFn;
  readonly clock: () => number;
  readonly minScore: number;
  readonly lambda: number;
}

/**
 * Run the full session-end teardown: initial drain → persist → stabilize →
 * pipeline-rerun loop → seal. Extracted from the inline IIFE in
 * createAceMiddleware to keep that function under the complexity ratchet.
 */
export function runTeardown(deps: TeardownDeps): Promise<void> {
  return (async (): Promise<void> => {
    const { state, ctx, sessions, drainTimeoutMs } = deps;
    let drainTimedOut = false;
    await Promise.resolve();
    const drainStart = Date.now();
    const hasPending = (): boolean => state.inFlight.size > 0 || state.shutdownInFlight.size > 0;
    if (hasPending()) {
      drainTimedOut = await initialDrain(state, drainStart, drainTimeoutMs);
      if (drainTimedOut) logTeardownTimeout(ctx.sessionId, state, drainTimeoutMs);
    }
    try {
      if (state.entries.length === 0) return;
      const drainOnce = makeDrainOnce(state, drainTimeoutMs);
      const logTimeout = (phase: string): void =>
        logPhaseTimeout(phase, ctx.sessionId, state, drainTimeoutMs);
      let appendedLength = state.entries.length;
      if (deps.trajectoryStore !== undefined) {
        await deps.trajectoryStore.append(ctx.sessionId, state.entries.slice(0, appendedLength));
      }
      drainTimedOut = drainTimedOut || (await stabilize(state, drainOnce, logTimeout));
      if (deps.trajectoryStore !== undefined && state.entries.length > appendedLength) {
        await deps.trajectoryStore.append(ctx.sessionId, state.entries.slice(appendedLength));
        appendedLength = state.entries.length;
      }
      const pipelineResult = await runPipelineLoop(deps, drainTimedOut, drainOnce, logTimeout);
      drainTimedOut = drainTimedOut || pipelineResult;
      if (deps.trajectoryStore !== undefined && state.entries.length > appendedLength) {
        await deps.trajectoryStore.append(ctx.sessionId, state.entries.slice(appendedLength));
      }
    } finally {
      state.closed = true;
      if (sessions.get(ctx.sessionId) === state) sessions.delete(ctx.sessionId);
    }
  })();
}

async function initialDrain(
  state: AceSessionState,
  drainStart: number,
  drainTimeoutMs: number,
): Promise<boolean> {
  const hasPending = (): boolean => state.inFlight.size > 0 || state.shutdownInFlight.size > 0;
  if (drainTimeoutMs === Number.POSITIVE_INFINITY) {
    while (hasPending()) {
      await Promise.allSettled([...state.inFlight, ...state.shutdownInFlight]);
    }
    return false;
  }
  const deadline = drainStart + drainTimeoutMs;
  while (hasPending()) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return true;
    const snap = [...state.inFlight, ...state.shutdownInFlight];
    const t = new Promise<"timeout">((resolve) => {
      setTimeout(() => resolve("timeout"), remaining).unref?.();
    });
    const o = await Promise.race([Promise.allSettled(snap).then(() => "ok" as const), t]);
    if (o === "timeout") return true;
  }
  return false;
}

function makeDrainOnce(state: AceSessionState, drainTimeoutMs: number): () => Promise<boolean> {
  return async (): Promise<boolean> => {
    const deadline =
      drainTimeoutMs === Number.POSITIVE_INFINITY
        ? Number.POSITIVE_INFINITY
        : Date.now() + drainTimeoutMs;
    while (state.shutdownInFlight.size > 0 || state.inFlight.size > 0) {
      const remaining =
        deadline === Number.POSITIVE_INFINITY ? Number.POSITIVE_INFINITY : deadline - Date.now();
      if (remaining !== Number.POSITIVE_INFINITY && remaining <= 0) return true;
      const snap = [...state.inFlight, ...state.shutdownInFlight];
      if (remaining === Number.POSITIVE_INFINITY) {
        await Promise.allSettled(snap);
      } else {
        const t = new Promise<"timeout">((resolve) => {
          setTimeout(() => resolve("timeout"), remaining).unref?.();
        });
        const o = await Promise.race([Promise.allSettled(snap).then(() => "ok" as const), t]);
        if (o === "timeout") return true;
      }
    }
    return false;
  };
}

async function stabilize(
  state: AceSessionState,
  drainOnce: () => Promise<boolean>,
  logTimeout: (phase: string) => void,
): Promise<boolean> {
  const STABILIZE_MAX_ITERATIONS = 5;
  let prevLen = -1;
  let iters = 0;
  while (state.entries.length !== prevLen && iters < STABILIZE_MAX_ITERATIONS) {
    prevLen = state.entries.length;
    if (await drainOnce()) {
      logTimeout("post-append");
      return true;
    }
    iters++;
  }
  if (state.entries.length !== prevLen && iters >= STABILIZE_MAX_ITERATIONS) {
    logTimeout("stabilize");
    return true;
  }
  return false;
}

async function runPipelineLoop(
  deps: TeardownDeps,
  drainTimedOut: boolean,
  drainOnce: () => Promise<boolean>,
  logTimeout: (phase: string) => void,
): Promise<boolean> {
  if (drainTimedOut) return false;
  const PIPELINE_MAX_ITERATIONS = 3;
  const { state, ctx } = deps;
  let iters = 0;
  while (iters < PIPELINE_MAX_ITERATIONS) {
    const snapshotLen = state.entries.length;
    const stats = aggregateTrajectoryStats(state.entries);
    const candidates = curateTrajectorySummary(stats, 1, {
      minScore: deps.minScore,
      nowMs: deps.clock(),
      lambda: deps.lambda,
    });
    const updated = deps.consolidate(candidates, state.playbooks as readonly Playbook[]);
    for (const pb of updated) await deps.playbookStore.save(pb);
    if (deps.structuredPipeline !== undefined) {
      try {
        await runStructuredPipeline(
          ctx.sessionId,
          state.entries,
          deps.structuredPipeline,
          deps.clock,
        );
      } catch (err: unknown) {
        const failureCtx: FailureContext = {
          stage: extractStageSafe(err),
          playbookId: deps.structuredPipeline.playbookId,
          sessionId: ctx.sessionId,
        };
        logFailureSafe(err, undefined, failureCtx);
        if (deps.structuredPipeline.onError !== undefined) {
          invokeOnErrorDetached(deps.structuredPipeline.onError, err, failureCtx);
        }
      }
    }
    if (await drainOnce()) {
      logTimeout("post-pipeline");
      return true;
    }
    if (state.entries.length === snapshotLen) return false;
    iters++;
  }
  if (state.entries.length > 0) logTimeout("pipeline-cap");
  return false;
}

function logTeardownTimeout(
  sessionId: string,
  state: AceSessionState,
  drainTimeoutMs: number,
): void {
  try {
    console.error(
      `[ace] session teardown drain timed out after ${drainTimeoutMs}ms (sessionId=${sessionId}, in-flight=${state.inFlight.size}, shutdown-pending=${state.shutdownInFlight.size}); persisting completed trajectory prefix only — skipping promotion pipeline to avoid baking conclusions from incomplete session`,
    );
  } catch {
    // never block teardown on log failures
  }
}

function logPhaseTimeout(
  phase: string,
  sessionId: string,
  state: AceSessionState,
  drainTimeoutMs: number,
): void {
  try {
    console.error(
      `[ace] session ${phase} drain timed out after ${drainTimeoutMs}ms (sessionId=${sessionId}, in-flight=${state.inFlight.size}, shutdown-pending=${state.shutdownInFlight.size}); skipping promotion pipeline to avoid baking conclusions from incomplete session`,
    );
  } catch {
    // never block teardown on log failures
  }
}
