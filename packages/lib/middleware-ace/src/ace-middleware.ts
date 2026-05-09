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
  TrajectoryRange,
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
import { commitPromotion, rollbackPromotion } from "./promotion-gate.js";
import { aggregateTrajectoryStats, curateTrajectorySummary } from "./stats-aggregator.js";

const DEFAULT_MAX_INJECTED_TOKENS = 800;
const DEFAULT_MIN_SCORE = 0.05;
const DEFAULT_LAMBDA = 0.05;
const DEFAULT_STRUCTURED_TOKEN_BUDGET = 2000;
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
interface AceSessionState {
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
      let drainTimedOut = false;
      const promise = (async (): Promise<void> => {
        // Yield one microtask before sampling pending sets. Without this,
        // wrappers invoked synchronously after `mw.onSessionEnd?.(ctx)` (a
        // common host pattern: kick off teardown then issue a final tool
        // call in the same sync frame) would not yet be registered in
        // shutdownInFlight when the loop's first hasPending() check runs,
        // so the loop would exit immediately and seal them out. The yield
        // is harmless in steady state — the drain semantics below are
        // unchanged.
        await Promise.resolve();
        // Unified drain: loop until BOTH inFlight (started before closing)
        // and shutdownInFlight (started after closing) are empty under an
        // absolute deadline. Late wrappers are recorded into state.entries
        // because closed=true is not flipped until after this loop —
        // closing the audit hole where post-close work executed silently.
        // Bounded by drainTimeoutMs so a single stuck call cannot wedge
        // teardown (caller can opt out via Number.POSITIVE_INFINITY).
        const drainStart = Date.now();
        const hasPending = (): boolean =>
          state.inFlight.size > 0 || state.shutdownInFlight.size > 0;
        if (hasPending()) {
          if (drainTimeoutMs === Number.POSITIVE_INFINITY) {
            while (hasPending()) {
              const snapshot = [
                ...Array.from(state.inFlight),
                ...Array.from(state.shutdownInFlight),
              ];
              await Promise.allSettled(snapshot);
            }
          } else {
            const deadline = drainStart + drainTimeoutMs;
            while (hasPending()) {
              const remaining = deadline - Date.now();
              if (remaining <= 0) {
                drainTimedOut = true;
                break;
              }
              const snapshot = [
                ...Array.from(state.inFlight),
                ...Array.from(state.shutdownInFlight),
              ];
              const timeout = new Promise<"timeout">((resolve) => {
                setTimeout(() => resolve("timeout"), remaining).unref?.();
              });
              const outcome = await Promise.race([
                Promise.allSettled(snapshot).then(() => "ok" as const),
                timeout,
              ]);
              if (outcome === "timeout") {
                drainTimedOut = true;
                break;
              }
            }
            if (drainTimedOut) {
              try {
                console.error(
                  `[ace] session teardown drain timed out after ${drainTimeoutMs}ms (sessionId=${ctx.sessionId}, in-flight=${state.inFlight.size}, shutdown-pending=${state.shutdownInFlight.size}); persisting completed trajectory prefix only — skipping promotion pipeline to avoid baking conclusions from incomplete session`,
                );
              } catch {
                // never block teardown on log failures
              }
            }
          }
        }
        // Persistence runs while closed=false so any wrappers that arrive
        // during the (potentially slow) trajectoryStore.append + promotion
        // pipeline still go through the normal recordEntry path. After
        // persistence finishes, we drain once more to catch wrappers that
        // started during it, then append the delta to trajectoryStore and
        // ONLY THEN seal closed=true. This eliminates the "post-drain,
        // pre-persist" audit window where late calls executed untracked.
        try {
          if (state.entries.length === 0) return;
          // Bounded extra drain we can use multiple times to chase late
          // entries that arrive between phases. Each call refreshes the
          // remaining budget so persistence + pipelines + delta drain are
          // never individually unbounded. Returns true on timeout so the
          // caller can fold that into drainTimedOut and skip the learning
          // pipelines — the same safety contract as the initial drain.
          const drainOnce = async (): Promise<boolean> => {
            const deadline =
              drainTimeoutMs === Number.POSITIVE_INFINITY
                ? Number.POSITIVE_INFINITY
                : Date.now() + drainTimeoutMs;
            while (state.shutdownInFlight.size > 0 || state.inFlight.size > 0) {
              const remaining =
                deadline === Number.POSITIVE_INFINITY
                  ? Number.POSITIVE_INFINITY
                  : deadline - Date.now();
              if (remaining !== Number.POSITIVE_INFINITY && remaining <= 0) return true;
              const snap = [...state.inFlight, ...state.shutdownInFlight];
              if (remaining === Number.POSITIVE_INFINITY) {
                await Promise.allSettled(snap);
              } else {
                const t = new Promise<"timeout">((resolve) => {
                  setTimeout(() => resolve("timeout"), remaining).unref?.();
                });
                const o = await Promise.race([
                  Promise.allSettled(snap).then(() => "ok" as const),
                  t,
                ]);
                if (o === "timeout") return true;
              }
            }
            return false;
          };
          const logDrainTimeout = (phase: string): void => {
            try {
              console.error(
                `[ace] session ${phase} drain timed out after ${drainTimeoutMs}ms (sessionId=${ctx.sessionId}, in-flight=${state.inFlight.size}, shutdown-pending=${state.shutdownInFlight.size}); skipping promotion pipeline to avoid baking conclusions from incomplete session`,
              );
            } catch {
              // never block teardown on log failures
            }
          };
          // Phase 1: persist the trajectory we have so durable observability
          // captures everything seen so far. Tracks how much has been
          // appended so each later phase only persists its delta — append
          // is non-idempotent by contract, so we must not double-write.
          let appendedLength = state.entries.length;
          if (config.trajectoryStore !== undefined) {
            await config.trajectoryStore.append(
              ctx.sessionId,
              state.entries.slice(0, appendedLength),
            );
          }
          // Phase 2: stabilize state.entries before the pipelines run by
          // looping drain → re-check until the entry count holds steady
          // for a full drain cycle. Bounded by both drainTimeoutMs (per
          // call) and a hard iteration cap to prevent unbounded recursion
          // if external callers keep firing wrappers. If we cannot
          // stabilize, treat as drain timeout so pipelines are skipped —
          // committing learning from a session that never settles risks
          // baking in conclusions from an incomplete suffix.
          const STABILIZE_MAX_ITERATIONS = 5;
          let prevLen = -1;
          let stabilizeIters = 0;
          while (state.entries.length !== prevLen && stabilizeIters < STABILIZE_MAX_ITERATIONS) {
            prevLen = state.entries.length;
            if (await drainOnce()) {
              drainTimedOut = true;
              logDrainTimeout("post-append");
              break;
            }
            stabilizeIters++;
          }
          if (
            !drainTimedOut &&
            state.entries.length !== prevLen &&
            stabilizeIters >= STABILIZE_MAX_ITERATIONS
          ) {
            // Could not stabilize within the iteration cap — host is
            // firing wrappers faster than we can drain them. Skip
            // pipelines so they cannot promote from an incomplete snapshot.
            drainTimedOut = true;
            logDrainTimeout("stabilize");
          }
          if (config.trajectoryStore !== undefined && state.entries.length > appendedLength) {
            await config.trajectoryStore.append(ctx.sessionId, state.entries.slice(appendedLength));
            appendedLength = state.entries.length;
          }
          // Phase 3: run the learning pipelines on the now-stable snapshot.
          // Skip downstream curation/consolidation/promotion on drain timeout:
          // those derive learnings from what is presumed to be a complete
          // session. Promoting playbooks from an incomplete trajectory risks
          // baking in conclusions that the dropped suffix would have changed.
          if (!drainTimedOut) {
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
            if (config.structuredPipeline !== undefined) {
              try {
                await runStructuredPipeline(
                  ctx.sessionId,
                  state.entries,
                  config.structuredPipeline,
                  clock,
                );
              } catch (err: unknown) {
                const failureCtx: FailureContext = {
                  stage: extractStageSafe(err),
                  playbookId: config.structuredPipeline.playbookId,
                  sessionId: ctx.sessionId,
                };
                logFailureSafe(err, undefined, failureCtx);
                if (config.structuredPipeline.onError !== undefined) {
                  invokeOnErrorDetached(config.structuredPipeline.onError, err, failureCtx);
                }
              }
            }
          }
          // Phase 4: drain any wrappers that arrived during the pipelines
          // and append their delta. We do not re-run the pipelines on this
          // delta — pipeline output reflects the post-drain snapshot at the
          // start of phase 3, which is the strongest "stable" guarantee
          // bounded teardown can give without unbounded recursion.
          if (await drainOnce()) {
            // Phase 4 timing out doesn't affect pipelines (they already
            // ran), but we still log so operators see the wedged wrapper.
            logDrainTimeout("post-pipeline");
          }
          if (config.trajectoryStore !== undefined && state.entries.length > appendedLength) {
            await config.trajectoryStore.append(ctx.sessionId, state.entries.slice(appendedLength));
          }
        } finally {
          // Now seal: late wrappers from this point on hard-reject without
          // tracking or recording, and the slot is removed.
          state.closed = true;
          // Only drop the slot if it still references US — a fresh
          // onSessionStart with the same sessionId may have replaced it.
          if (sessions.get(ctx.sessionId) === state) {
            sessions.delete(ctx.sessionId);
          }
        }
      })();
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
      const inner = (async (): Promise<ToolResponse> => {
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

/** Default UUID-based ID generator. */
function defaultIdGenerator(): string {
  return crypto.randomUUID();
}

/**
 * Coerce arbitrary thrown values to a string without invoking attacker code.
 * Never uses `instanceof` (proxy `getPrototypeOf` traps can throw) or property
 * access on objects (proxy `get` traps can throw); only inspects primitive
 * types and falls back to a constant marker for any object/function/symbol.
 */
function safeString(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  const t = typeof value;
  if (t === "string" || t === "number" || t === "boolean" || t === "bigint") {
    return String(value);
  }
  return `[${t}]`;
}

/**
 * Log a structured-pipeline failure without ever rethrowing.
 * `pipelineErr` is the original failure; `handlerErr` is set when a wired
 * onError itself threw. All console.error invocations are wrapped because the
 * console implementation can throw (custom hooks, hostile arguments, etc.).
 */
/**
 * Extract ONLY the error class/typeof from a thrown value.
 *
 * Reflector/curator/evaluator/store errors commonly embed prompt fragments,
 * tool I/O, SQL text, or provider response bodies in `err.message`. The
 * default failure path therefore emits NO message content — only stable,
 * non-sensitive metadata. Callers who want rich error visibility must wire
 * `structuredPipeline.onError` explicitly (an opt-in trust-boundary cross).
 */
function errorClassName(value: unknown): string {
  if (value === null || value === undefined) return safeString(value);
  const t = typeof value;
  if (t !== "object" && t !== "function") return `[${t}]`;

  try {
    const obj = value as { name?: unknown; constructor?: { name?: unknown } };
    const nameRaw = obj.name;
    if (typeof nameRaw === "string" && nameRaw.length > 0 && nameRaw.length <= 64) {
      return nameRaw;
    }
    const ctorNameRaw = obj.constructor?.name;
    if (typeof ctorNameRaw === "string" && ctorNameRaw.length > 0 && ctorNameRaw.length <= 64) {
      return ctorNameRaw;
    }
    return "Error";
  } catch {
    return "[error]";
  }
}

/**
 * Stable identifiers describing where in the pipeline a failure surfaced.
 * Logging the stage code (instead of a free-form message) keeps the default
 * log diagnosable without leaking per-session payloads.
 */
type FailureContext = {
  readonly stage: string;
  readonly playbookId?: string;
  readonly sessionId?: string;
};

/**
 * Log a structured-pipeline failure as non-sensitive metadata only.
 * Emits stage + class + (optional) playbookId/sessionId, so operators can
 * locate and triage the failure without leaking per-session payloads.
 * Detailed diagnostics require an explicit `onError` handler.
 */
function logFailureSafe(pipelineErr: unknown, handlerErr?: unknown, ctx?: FailureContext): void {
  try {
    const primary = errorClassName(pipelineErr);
    const tags: string[] = [`class=${primary}`];
    if (ctx?.stage !== undefined) tags.push(`stage=${ctx.stage}`);
    if (ctx?.playbookId !== undefined) tags.push(`playbookId=${ctx.playbookId}`);
    if (ctx?.sessionId !== undefined) tags.push(`sessionId=${ctx.sessionId}`);
    const tagStr = tags.join(" ");
    if (handlerErr !== undefined) {
      const secondary = errorClassName(handlerErr);
      console.error(
        `[ace] structured pipeline failure (${tagStr}); onError handler also failed (class=${secondary}); wire structuredPipeline.onError for details`,
      );
    } else {
      console.error(
        `[ace] structured pipeline failure (${tagStr}); wire structuredPipeline.onError for details`,
      );
    }
  } catch {
    // Last resort: swallow to honor the never-block-session-end contract.
  }
}

/**
 * Invoke `onError(err)` without blocking session teardown. Synchronous throws
 * AND promise rejections are caught and routed back through `logFailureSafe`.
 *
 * Hostile-handler safe: any failure while probing `result.then` (e.g. a
 * throwing getter on the return value) is also captured.
 */
function invokeOnErrorDetached(
  onError: (err: unknown) => void | Promise<void>,
  err: unknown,
  ctx?: FailureContext,
): void {
  let result: void | Promise<void>;
  try {
    result = onError(err);
  } catch (handlerErr: unknown) {
    logFailureSafe(err, handlerErr, ctx);
    return;
  }
  // Promise.resolve coerces a thenable safely; if `then` access or invocation
  // throws synchronously, we wrap the whole probe in try/catch.
  let coerced: Promise<void>;
  try {
    coerced = Promise.resolve(result as void | Promise<void>);
  } catch (handlerErr: unknown) {
    logFailureSafe(err, handlerErr, ctx);
    return;
  }
  void coerced.catch((handlerErr: unknown) => {
    logFailureSafe(err, handlerErr, ctx);
  });
}

/** Determine an aggregate outcome label from compact trajectory entries. */
function summarizeOutcome(entries: readonly TrajectoryEntry[]): "success" | "failure" | "mixed" {
  let any = false;
  let allSuccess = true;
  let allFailure = true;
  for (const e of entries) {
    any = true;
    if (e.outcome === "success") allFailure = false;
    else if (e.outcome === "failure") allSuccess = false;
    else {
      allSuccess = false;
      allFailure = false;
    }
  }
  if (!any) return "mixed";
  if (allSuccess) return "success";
  if (allFailure) return "failure";
  return "mixed";
}

/**
 * Run the AGP propose -> evaluate -> commit pipeline for one session window.
 *
 * Failure modes are surfaced as thrown errors so the caller can route them to
 * `onError` without blocking session end. Successful execution returns void;
 * the promote/reject decision is encoded in the structured store + audit log.
 */
/** Identifies which pipeline stage produced a failure (for default logging). */
type PipelineStage =
  | "load-playbook"
  | "reflect"
  | "curate"
  | "record-proposal"
  | "evaluate"
  | "resolve-rollback-target"
  | "rollback-decline"
  | "rollback-commit"
  | "commit";

/** Internal error wrapper carrying the pipeline stage for diagnostic logging. */
class StagedPipelineError extends Error {
  readonly stage: PipelineStage;
  override readonly cause: unknown;
  constructor(stage: PipelineStage, cause: unknown) {
    // Embed the root-cause message so downstream handlers using `err.message`
    // or `String(err)` still see the actionable text (provider errors, SQL,
    // rollback misuse) instead of just the wrapper boilerplate.
    super(`ACE structured pipeline failed at stage=${stage}: ${causeMessage(cause)}`);
    this.name = "StagedPipelineError";
    this.stage = stage;
    this.cause = cause;
  }
}

/** Extract the cause's message safely (no instanceof, no proxy traps). */
function causeMessage(cause: unknown): string {
  if (cause === null || cause === undefined) return safeString(cause);
  const t = typeof cause;
  if (t !== "object" && t !== "function") return safeString(cause);
  try {
    const m = (cause as { message?: unknown }).message;
    if (typeof m === "string" && m.length > 0) return m;
    return errorClassName(cause);
  } catch {
    return "[error]";
  }
}

/** Known stage names; used to validate the `stage` field on a wrapped error. */
const KNOWN_STAGES: readonly PipelineStage[] = [
  "load-playbook",
  "reflect",
  "curate",
  "record-proposal",
  "evaluate",
  "resolve-rollback-target",
  "rollback-decline",
  "rollback-commit",
  "commit",
];

/**
 * Read the `stage` field from a thrown value WITHOUT using `instanceof`
 * (which would invoke `getPrototypeOf` on a proxy and could throw). Returns
 * "unknown" for any value that isn't a normal object exposing a known stage.
 */
function extractStageSafe(value: unknown): string {
  if (value === null || value === undefined) return "unknown";
  const t = typeof value;
  if (t !== "object" && t !== "function") return "unknown";
  try {
    const stageRaw = (value as { stage?: unknown }).stage;
    if (typeof stageRaw === "string" && KNOWN_STAGES.includes(stageRaw as PipelineStage)) {
      return stageRaw;
    }
    return "unknown";
  } catch {
    return "unknown";
  }
}

async function runStage<T>(stage: PipelineStage, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (cause: unknown) {
    throw new StagedPipelineError(stage, cause);
  }
}

async function runStructuredPipeline(
  sessionId: string,
  entries: readonly TrajectoryEntry[],
  pipe: AceStructuredPipelineConfig,
  clock: () => number,
): Promise<void> {
  // Defense-in-depth: never reflect/curate/commit on an empty trajectory.
  // The caller (onSessionEnd) already guards on entries.length === 0, but a
  // permissive reflector + curator could otherwise mutate a playbook from a
  // zero-evidence window if that guard ever moved.
  if (entries.length === 0) return;

  const playbook = await runStage("load-playbook", () => pipe.structuredStore.get(pipe.playbookId));
  if (playbook === undefined) {
    throw new StagedPipelineError(
      "load-playbook",
      new Error(`playbook ${pipe.playbookId} not found in structuredStore`),
    );
  }

  const outcome = summarizeOutcome(entries);
  const reflection = await runStage("reflect", () =>
    pipe.reflector({ trajectory: entries, outcome, playbook }),
  );

  const tokenBudget = pipe.tokenBudget ?? DEFAULT_STRUCTURED_TOKEN_BUDGET;
  const operations = await runStage("curate", () =>
    pipe.curator({ playbook, reflection, tokenBudget }),
  );

  // No-op curation: nothing to commit. Skip the gate entirely.
  if (operations.length === 0) return;

  const idGen = pipe.idGenerator ?? defaultIdGenerator;
  const now = clock();
  // Derive range from actual step coordinates (turnIndex), not array length.
  // entries.length conflates physical row count with logical step indexing,
  // which would let watermarks advance past real steps for sessions with
  // multiple entries per turn.
  let minTurn = entries[0]!.turnIndex;
  let maxTurn = minTurn;
  for (const e of entries) {
    if (e.turnIndex < minTurn) minTurn = e.turnIndex;
    if (e.turnIndex > maxTurn) maxTurn = e.turnIndex;
  }
  const sourceTrajectoryRange: TrajectoryRange = {
    sessionId,
    fromStepIndex: minTurn,
    toStepIndex: maxTurn + 1,
  };

  const proposal: PlaybookProposal = {
    id: idGen(),
    playbookId: pipe.playbookId,
    baseVersion: playbook.version,
    operations,
    sourceTrajectoryRange,
    reflection,
    createdAt: now,
  };

  // Pre-record per the gate's contract: real proposal stores enforce a
  // baseVersion-FK on fresh inserts, so the proposal must be persisted while
  // baseVersion still equals the live head. Idempotent on retry.
  await runStage("record-proposal", () => pipe.proposalStore.recordProposal(proposal));

  const evaluation = await runStage("evaluate", () =>
    pipe.evaluator({
      trajectory: entries,
      proposal,
      playbookBefore: playbook,
    }),
  );

  // The gate handles promote / reject end-to-end (audit-first ordering, head
  // advance only on promote). Rollback verdicts are routed elsewhere — they
  // are not produced by the consolidation pipeline; an explicit rollback
  // operator drives those through rollbackPromotion() directly.
  if (evaluation.verdict === "rollback") {
    const resolveRollbackTarget = pipe.resolveRollbackTarget;
    if (resolveRollbackTarget === undefined) {
      // No handler wired: declined-by-config. Persist the evaluation BEFORE
      // surfacing the decline so the audit trail records what the evaluator
      // decided — losing this evidence on a rollback verdict (the most
      // safety-critical outcome) would let retries regenerate the same
      // proposal with no stored explanation of the prior decision.
      // Idempotent on byte-identical retry by the proposal-store contract.
      await runStage("rollback-decline", () => pipe.proposalStore.recordEvaluation(evaluation));
      throw new StagedPipelineError(
        "rollback-decline",
        new Error(
          "evaluator returned 'rollback' verdict but no resolveRollbackTarget handler is configured; head is unchanged.",
        ),
      );
    }
    const targetVersion = await runStage("resolve-rollback-target", () =>
      resolveRollbackTarget({ proposal, evaluation, playbookBefore: playbook }),
    );
    if (targetVersion === null) {
      // Handler ran and explicitly declined. Same audit-trail rationale —
      // record the evaluation before surfacing the decline.
      await runStage("rollback-decline", () => pipe.proposalStore.recordEvaluation(evaluation));
      throw new StagedPipelineError(
        "rollback-decline",
        new Error("resolveRollbackTarget returned null; head unchanged"),
      );
    }
    // Real rollback commit — failures here are operational outages
    // (missing lineage support, missing target version, save conflicts),
    // distinct from a benign decline.
    await runStage("rollback-commit", () =>
      rollbackPromotion(
        {
          structuredStore: pipe.structuredStore,
          proposalStore: pipe.proposalStore,
          clock,
        },
        proposal,
        targetVersion,
        evaluation,
      ),
    );
    return;
  }

  await runStage("commit", () =>
    commitPromotion(
      {
        structuredStore: pipe.structuredStore,
        proposalStore: pipe.proposalStore,
        clock,
      },
      proposal,
      evaluation,
      pipe.thresholds,
    ),
  );
}
