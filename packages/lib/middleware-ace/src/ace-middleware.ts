/**
 * ACE middleware — records trajectory, injects active playbooks, and (optionally)
 * runs the AGP propose -> evaluate -> commit pipeline through the promotion gate
 * on session end.
 *
 * Two pipelines:
 *   - Stat pipeline (default, no LLM): aggregate identifier stats → score →
 *     EMA-blended flat playbooks via `playbookStore`.
 *   - Structured pipeline (opt-in): a `structuredPipeline` config wires a
 *     reflector + curator + evaluator with a `proposalStore` and
 *     `structuredStore`, gated by `commitPromotion`. Failures are caught and
 *     logged but never block session end.
 */

import type {
  AggregatedStats,
  CuratorOperation,
  Playbook,
  PlaybookEvaluation,
  PlaybookProposal,
  PlaybookProposalStore,
  PlaybookStore,
  ReflectionResult,
  StructuredPlaybook,
  StructuredPlaybookStore,
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
import { runTeardown } from "./teardown.js";

const DEFAULT_MAX_INJECTED_TOKENS = 800;
const DEFAULT_MIN_SCORE = 0.05;
const DEFAULT_LAMBDA = 0.05;
/** Default upper bound on how long onSessionEnd waits for in-flight wrappers. */
const DEFAULT_DRAIN_TIMEOUT_MS = 5000;

/** Reflector: LLM-backed (or stubbed) trajectory analyzer. */
export type ReflectorFn = (input: {
  readonly trajectory: readonly TrajectoryEntry[];
  readonly outcome: "success" | "failure" | "mixed";
  readonly playbook: StructuredPlaybook;
}) => Promise<ReflectionResult>;

/** Curator: produces a delta over a structured playbook from a reflection. */
export type CuratorFn = (input: {
  readonly playbook: StructuredPlaybook;
  readonly reflection: ReflectionResult;
  readonly tokenBudget: number;
}) => Promise<readonly CuratorOperation[]>;

/** Evaluator: emits a verdict for the proposed delta. */
export type EvaluatorFn = (input: {
  readonly trajectory: readonly TrajectoryEntry[];
  readonly proposal: PlaybookProposal;
  readonly playbookBefore: StructuredPlaybook;
}) => Promise<PlaybookEvaluation>;

/**
 * Opt-in AGP propose -> evaluate -> commit pipeline. Wires reflector + curator
 * + evaluator behind the promotion gate. Without this set, the middleware
 * runs only the stat pipeline (existing behavior, unchanged).
 */
export interface AceStructuredPipelineConfig {
  readonly structuredStore: StructuredPlaybookStore;
  readonly proposalStore: PlaybookProposalStore;
  /** ID of the structured playbook this pipeline updates. */
  readonly playbookId: string;
  readonly reflector: ReflectorFn;
  readonly curator: CuratorFn;
  readonly evaluator: EvaluatorFn;
  readonly thresholds: import("@koi/ace-types").PromotionThresholds;
  /** Token budget passed to the curator. Default 2000. */
  readonly tokenBudget?: number;
  /**
   * ID generator for proposal/evaluation IDs. Default uses crypto.randomUUID.
   * Tests inject deterministic IDs.
   */
  readonly idGenerator?: () => string;
  /**
   * Optional sink for pipeline errors so callers can observe/escalate without
   * blocking session end. Defaults to a no-op (pipeline failures are
   * swallowed by design).
   */
  readonly onError?: (err: unknown) => void;
  /**
   * Optional resolver invoked when an evaluator returns a `rollback` verdict.
   *
   * Returns the historical version number to roll back to (or `null` to
   * decline). The middleware itself runs `rollbackPromotion()` against that
   * target, so all gate invariants (lineage support check, base-version
   * match, idempotent retry, provenance + audit recording) are enforced on
   * the rollback path the same way as on commit. The caller does NOT mutate
   * the structured store directly.
   *
   * If unset, a rollback verdict surfaces as a `StagedPipelineError` via the
   * standard onError path so the active head stays in place AND the failure
   * is visible to operators (no silent drop).
   */
  readonly resolveRollbackTarget?: (input: {
    readonly proposal: PlaybookProposal;
    readonly evaluation: PlaybookEvaluation;
    readonly playbookBefore: StructuredPlaybook;
  }) => Promise<number | null>;
}

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
  /**
   * Opt-in AGP structured pipeline. When set, on session end the middleware
   * runs reflector → curator → evaluator → promotion gate against the
   * configured structured playbook. The stat pipeline still runs alongside
   * (they target different stores).
   */
  readonly structuredPipeline?: AceStructuredPipelineConfig;
  /**
   * Maximum time `onSessionEnd` waits for in-flight model/tool wrappers to
   * settle before sealing the session and proceeding with a partial
   * trajectory. Default: 5000 ms. Pass `Number.POSITIVE_INFINITY` to
   * disable the bound (not recommended in production).
   */
  readonly drainTimeoutMs?: number;
}

/** Per-session mutable state — entries accumulate, `playbooks` is the snapshot
 *  loaded on session start (refreshed after consolidation). */
export interface AceSessionState {
  /**
   * Lifecycle nonce: pinned at onSessionStart and re-checked by every
   * wrapper before mutating state. Prevents delayed callbacks from a
   * prior lifecycle (host reused sessionId) from contaminating a fresh
   * session's entries/turnIndex via the shared sessions map.
   */
  readonly lifecycleId: string;
  entries: readonly TrajectoryEntry[];
  playbooks: readonly Playbook[];
  turnIndex: number;
  /**
   * Once teardown begins, the in-flight promise is stored here so concurrent
   * `onSessionEnd` calls for the same lifecycle dedupe onto it. Storing on
   * the state (not a sessionId-keyed map) means a recycled session id with
   * a fresh `onSessionStart` gets its own teardownPromise — it cannot be
   * shadowed by a still-running teardown of the prior lifecycle.
   */
  teardownPromise?: Promise<void>;
  /**
   * Set true the moment onSessionEnd begins — REJECTS new wrappers from
   * starting (see wrapModelCall/wrapToolCall). Bounds the drain window so
   * teardown cannot wait forever for caller-induced new work.
   */
  closing?: boolean;
  /**
   * Set true after the drain completes. recordEntry() ignores writes after
   * this flips. (Wrappers registered before `closing` flipped finish
   * normally during the drain.)
   */
  closed?: boolean;
  /**
   * Tracks model/tool wrappers that have started but not yet appended their
   * trajectory entry. onSessionEnd awaits all of these before sealing the
   * session so end-of-session model/tool work is included in the trajectory
   * append + structured pipeline (no silent drop of in-flight results).
   */
  inFlight: Set<Promise<unknown>>;
  /**
   * Tracks model/tool wrappers that started AFTER `closing` flipped but
   * before `teardownPromise` resolved. They are not added to the trajectory
   * (would extend it past session end), but `teardownPromise` does not
   * resolve until they settle so that lifecycle barrier remains valid for
   * session-id reuse — no straggler from lifecycle N can overlap N+1.
   */
  shutdownInFlight: Set<Promise<unknown>>;
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

  /**
   * Lifecycle-aware state lookup. `runId` pins a single onSessionStart →
   * onSessionEnd lifecycle. If the slot has been replaced by a fresh
   * lifecycle (same sessionId, new runId), refuse the lookup so a delayed
   * wrapper from the old lifecycle cannot leak entries into the new one.
   */
  function getState(ctx: SessionContext): AceSessionState | undefined {
    const slot = sessions.get(ctx.sessionId);
    if (slot === undefined) return undefined;
    if (slot.lifecycleId !== ctx.runId) return undefined;
    return slot;
  }

  function recordEntry(state: AceSessionState | undefined, entry: TrajectoryEntry): void {
    if (state === undefined) return;
    // Drop late events after onSessionEnd has fully drained — preserves the
    // snapshotted entries seen by trajectory append + structured pipeline.
    if (state.closed === true) return;
    state.entries = [...state.entries, entry];
  }

  /**
   * Register an in-flight model/tool wrapper so onSessionEnd can drain it
   * before sealing the session. The promise auto-removes itself from the
   * tracking set on settle (success or failure) so it cannot leak.
   */
  function trackInFlight<T>(state: AceSessionState | undefined, promise: Promise<T>): Promise<T> {
    if (state === undefined) return promise;
    const set = state.closing === true ? state.shutdownInFlight : state.inFlight;
    const tracked = promise.finally(() => {
      set.delete(tracked);
    });
    set.add(tracked);
    return tracked as Promise<T>;
  }

  return {
    name: "ace",
    phase: "observe",
    priority: 800,

    async onSessionStart(ctx: SessionContext): Promise<void> {
      // Serialize per-id lifecycles: if a prior lifecycle for this sessionId
      // is still tearing down, wait for it before replacing the state. This
      // prevents stale callbacks from the prior lifecycle from mutating the
      // new one's entries / turnIndex when the host runtime reuses ids.
      const existing = sessions.get(ctx.sessionId);
      if (existing?.teardownPromise !== undefined) {
        await existing.teardownPromise;
      }
      const playbooks = await config.playbookStore.list();
      sessions.set(ctx.sessionId, {
        // Pin this lifecycle: any wrapper / onSessionEnd from a prior
        // lifecycle (same sessionId, different runId) will fail the
        // identity check and become a no-op rather than mutating us.
        lifecycleId: ctx.runId,
        entries: [],
        playbooks,
        turnIndex: 0,
        inFlight: new Set(),
        shutdownInFlight: new Set(),
      });
    },

    async onSessionEnd(ctx: SessionContext): Promise<void> {
      // onSessionEnd is contractually one-shot per lifecycle: callers must not
      // retry after a failure because trajectoryStore.append() is documented
      // as non-idempotent. Concurrent / duplicate calls dedupe via a promise
      // stored on the state object itself — keying dedupe by `sessionId`
      // alone would let a still-running teardown shadow a fresh lifecycle
      // (same id, new onSessionStart) and silently drop the new session.
      const slot = sessions.get(ctx.sessionId);
      if (slot === undefined) return;
      // Lifecycle identity check: a stale onSessionEnd from a prior
      // lifecycle must NOT trigger teardown of a fresh state with the
      // same sessionId. If runId mismatches, this end belongs to a dead
      // lifecycle whose state was already replaced.
      if (slot.lifecycleId !== ctx.runId) return;
      const state = slot;
      if (state.teardownPromise !== undefined) return state.teardownPromise;
      // Mark closing IMMEDIATELY (synchronously). Wrappers that arrive
      // after this flip route to shutdownInFlight and are still drained
      // (and recorded) below — they remain visible to trajectory and
      // promotion so post-closing side-effects do not leak past the audit.
      state.closing = true;
      const drainTimeoutMs = config.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS;
      const promise = runTeardown({
        state,
        ctx,
        sessions,
        drainTimeoutMs,
        trajectoryStore: config.trajectoryStore,
        structuredPipeline: config.structuredPipeline,
        playbookStore: config.playbookStore,
        consolidate,
        clock,
        minScore,
        lambda,
      });
      state.teardownPromise = promise;
      return promise;
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
      // Hard-reject calls that arrive after the session is fully sealed
      // (closed=true). At that point persistence has run and the slot is
      // about to be deleted — there is nothing to drain or record onto.
      if (state?.closed === true) {
        return next(request);
      }
      const enriched = injectPlaybooks(request, state, maxInjectedTokens);
      const startedAt = clock();
      const inner = (async (): Promise<ModelResponse> => {
        const outcome = await runWithOutcome(() => next(enriched));
        const durationMs = clock() - startedAt;
        const identifier = enriched.model ?? "unknown-model";
        // Wrappers in the closing window also reach here: trackInFlight
        // routes them to shutdownInFlight, the unified drain waits on
        // them under drainTimeoutMs, and recordEntry runs while
        // closed=false so the entry is captured before persistence.
        recordEntry(state, {
          turnIndex: ctx.turnIndex,
          timestamp: startedAt,
          kind: "model_call",
          identifier,
          outcome: outcome.outcome,
          durationMs,
        });
        return outcome.unwrap();
      })();
      return trackInFlight(state, inner);
    },

    async wrapToolCall(
      ctx: TurnContext,
      request: ToolRequest,
      next: ToolHandler,
    ): Promise<ToolResponse> {
      const state = getState(ctx.session);
      if (state?.closed === true) {
        return next(request);
      }
      const startedAt = clock();
      // Snapshot turnIndex from the immutable ctx at invocation time. Reading
      // state.turnIndex when the tool resolves would attribute a tool that
      // started on turn N but completed after onBeforeTurn for turn N+1 to
      // the wrong (newer) turn, advancing the reflection watermark past
      // work that was never part of any evaluated window.
      const callTurnIndex = ctx.turnIndex;
      const inner = (async (): Promise<ToolResponse> => {
        const outcome = await runWithOutcome(() => next(request));
        const durationMs = clock() - startedAt;
        recordEntry(state, {
          turnIndex: callTurnIndex,
          timestamp: startedAt,
          kind: "tool_call",
          identifier: request.toolId,
          outcome: outcome.outcome,
          durationMs,
        });
        return outcome.unwrap();
      })();
      return trackInFlight(state, inner);
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
