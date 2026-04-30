/**
 * ACE middleware — records trajectory, injects active playbooks, consolidates
 * stat-pipeline learnings on session end.
 *
 * Stat pipeline only. The LLM reflector / curator and the AGP promotion gate
 * land in subsequent revisions of #1715.
 */

import type {
  AggregatedStats,
  Playbook,
  PlaybookStore,
  TrajectoryEntry,
  TrajectoryStore,
} from "@koi/ace-types";
import type {
  CapabilityFragment,
  KoiMiddleware,
  ModelHandler,
  ModelRequest,
  ModelResponse,
  SessionContext,
  ToolHandler,
  ToolRequest,
  ToolResponse,
  TurnContext,
} from "@koi/core";

import type { ConsolidateFn } from "./consolidator.js";
import { createDefaultConsolidator } from "./consolidator.js";
import { formatActivePlaybooksMessage, selectPlaybooks } from "./injector.js";
import { aggregateTrajectoryStats, curateTrajectorySummary } from "./stats-aggregator.js";

const DEFAULT_MAX_INJECTED_TOKENS = 800;
const DEFAULT_MIN_SCORE = 0.05;
const DEFAULT_LAMBDA = 0.05;

/** Pluggable, mostly-optional config for the ACE middleware. */
export interface AceConfig {
  /** Persistent playbook backend. Required. */
  readonly playbookStore: PlaybookStore;
  /** Optional persistent trajectory store. When omitted, trajectories are
   *  consolidated in-memory and discarded at session end. */
  readonly trajectoryStore?: TrajectoryStore;
  /** Maximum tokens reserved for the `[Active Playbooks]` injection. Default 800. */
  readonly maxInjectedTokens?: number;
  /** Minimum curation score below which candidates are dropped. Default 0.05. */
  readonly minScore?: number;
  /** Recency-decay lambda (per day). Default 0.05. */
  readonly lambda?: number;
  /** Override the default EMA consolidator. */
  readonly consolidate?: ConsolidateFn;
  /** Timestamp source. Default `Date.now`. */
  readonly clock?: () => number;
}

/** Per-session mutable state — entries accumulate, `playbooks` is the snapshot
 *  loaded on session start (refreshed after consolidation). */
interface AceSessionState {
  entries: readonly TrajectoryEntry[];
  playbooks: readonly Playbook[];
  turnIndex: number;
}

/**
 * Create the ACE middleware. State lives in a `Map<SessionId, AceSessionState>`
 * scoped by `onSessionStart` / `onSessionEnd` so each runtime gets a clean slate.
 */
export function createAceMiddleware(config: AceConfig): KoiMiddleware {
  const maxInjectedTokens = config.maxInjectedTokens ?? DEFAULT_MAX_INJECTED_TOKENS;
  const minScore = config.minScore ?? DEFAULT_MIN_SCORE;
  const lambda = config.lambda ?? DEFAULT_LAMBDA;
  const clock = config.clock ?? Date.now;
  const consolidate = config.consolidate ?? createDefaultConsolidator({ clock });

  const sessions = new Map<string, AceSessionState>();

  function getState(ctx: SessionContext): AceSessionState | undefined {
    return sessions.get(ctx.sessionId);
  }

  function recordEntry(state: AceSessionState | undefined, entry: TrajectoryEntry): void {
    if (state === undefined) return;
    state.entries = [...state.entries, entry];
  }

  return {
    name: "ace",
    phase: "observe",
    priority: 800,

    async onSessionStart(ctx: SessionContext): Promise<void> {
      const playbooks = await config.playbookStore.list();
      sessions.set(ctx.sessionId, {
        entries: [],
        playbooks,
        turnIndex: 0,
      });
    },

    async onSessionEnd(ctx: SessionContext): Promise<void> {
      const state = sessions.get(ctx.sessionId);
      sessions.delete(ctx.sessionId);
      if (state === undefined || state.entries.length === 0) return;

      if (config.trajectoryStore !== undefined) {
        await config.trajectoryStore.append(ctx.sessionId, state.entries);
      }

      const stats = aggregateTrajectoryStats(state.entries);
      const candidates = curateTrajectorySummary(stats, 1, {
        minScore,
        nowMs: clock(),
        lambda,
      });
      const updated = consolidate(candidates, state.playbooks);
      for (const pb of updated) {
        await config.playbookStore.save(pb);
      }
    },

    async onBeforeTurn(ctx: TurnContext): Promise<void> {
      const state = getState(ctx.session);
      if (state === undefined) return;
      state.turnIndex = ctx.turnIndex;
    },

    async wrapModelCall(
      ctx: TurnContext,
      request: ModelRequest,
      next: ModelHandler,
    ): Promise<ModelResponse> {
      const state = getState(ctx.session);
      const enriched = injectPlaybooks(request, state, maxInjectedTokens);
      const startedAt = clock();
      const outcome = await runWithOutcome(() => next(enriched));
      const durationMs = clock() - startedAt;
      const identifier = enriched.model ?? "unknown-model";
      recordEntry(state, {
        turnIndex: ctx.turnIndex,
        timestamp: startedAt,
        kind: "model_call",
        identifier,
        outcome: outcome.outcome,
        durationMs,
      });
      return outcome.unwrap();
    },

    async wrapToolCall(
      ctx: TurnContext,
      request: ToolRequest,
      next: ToolHandler,
    ): Promise<ToolResponse> {
      const state = getState(ctx.session);
      const startedAt = clock();
      const outcome = await runWithOutcome(() => next(request));
      const durationMs = clock() - startedAt;
      recordEntry(state, {
        turnIndex: state?.turnIndex ?? 0,
        timestamp: startedAt,
        kind: "tool_call",
        identifier: request.toolId,
        outcome: outcome.outcome,
        durationMs,
      });
      return outcome.unwrap();
    },

    describeCapabilities(ctx: TurnContext): CapabilityFragment | undefined {
      const state = getState(ctx.session);
      const count = state?.playbooks.length ?? 0;
      return {
        label: "ace",
        description: `ACE: ${count} active playbook(s) within ${maxInjectedTokens} tokens`,
      };
    },
  };
}

/** Internal helper: discriminated outcome wrapper for model/tool handlers. */
type Outcome<T> =
  | { readonly outcome: "success"; readonly unwrap: () => T }
  | { readonly outcome: "failure"; readonly unwrap: () => never };

async function runWithOutcome<T>(fn: () => Promise<T>): Promise<Outcome<T>> {
  try {
    const value = await fn();
    return { outcome: "success", unwrap: () => value };
  } catch (err: unknown) {
    return {
      outcome: "failure",
      unwrap: (): never => {
        throw err;
      },
    };
  }
}

/** Prepend the `[Active Playbooks]` block to `systemPrompt`, never mutates. */
function injectPlaybooks(
  request: ModelRequest,
  state: AceSessionState | undefined,
  maxTokens: number,
): ModelRequest {
  if (state === undefined || state.playbooks.length === 0) return request;
  const selected = selectPlaybooks(state.playbooks, { maxTokens });
  const text = formatActivePlaybooksMessage(selected);
  if (text === "") return request;
  const systemPrompt =
    request.systemPrompt !== undefined && request.systemPrompt.length > 0
      ? `${text}\n\n${request.systemPrompt}`
      : text;
  return { ...request, systemPrompt };
}

/** Re-export aggregation helper for downstream tests/debugging. */
export type { AggregatedStats };
