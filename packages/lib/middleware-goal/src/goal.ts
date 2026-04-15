/**
 * Goal middleware — keeps agents focused on objectives via adaptive reminders
 * and heuristic completion detection.
 *
 * Dual middleware: wrapModelCall (inject goals, detect completions) +
 * wrapToolCall (track tool activity for drift detection).
 */

import type {
  CapabilityFragment,
  InboundMessage,
  KoiMiddleware,
  ModelChunk,
  ModelRequest,
  ModelResponse,
  ModelStreamHandler,
  SessionId,
  TurnContext,
} from "@koi/core";
import { KoiRuntimeError } from "@koi/errors";

import {
  invokeDetectCompletionsCallback,
  invokeIsDriftingCallback,
  sanitizeUserMessages,
} from "./callbacks.js";
import {
  DEFAULT_BASE_INTERVAL,
  DEFAULT_CALLBACK_TIMEOUT_MS,
  DEFAULT_GOAL_HEADER,
  DEFAULT_MAX_INTERVAL,
  type DriftUserMessage,
  type GoalController,
  type GoalItemWithId,
  type GoalMiddlewareConfig,
  type GoalMiddlewareWithController,
  validateGoalConfig,
} from "./config.js";
import {
  computeNextInterval,
  detectCompletions,
  extractKeywords,
  isDrifting,
  renderGoalBlock,
  userMessageContainsKeywords,
} from "./goal-helpers.js";

// Re-export pure helpers for public API
export {
  computeNextInterval,
  detectCompletions,
  extractKeywords,
  isDrifting,
  normalizeText,
  renderGoalBlock,
} from "./goal-helpers.js";

// ---------------------------------------------------------------------------
// Session state
// ---------------------------------------------------------------------------

/** Max user messages buffered across turns for the isDrifting callback. */
const MESSAGE_BUFFER_SIZE = 10;

/** Safety bound for per-turn state Map to prevent unbounded growth on crash. */
const MAX_CONCURRENT_TURNS = 5;

/**
 * State scoped to a single turn. Keyed by `ctx.turnId` so that overlapping
 * turns for the same session (possible when `onAfterTurn` awaits a
 * long-running callback up to `callbackTimeoutMs`) cannot corrupt each
 * other's injection flags or response buffers.
 */
interface PerTurnState {
  readonly turnIndex: number;
  /** Whether to inject goals on the next model call this turn. Set by onBeforeTurn, consumed by first model call. */
  shouldInject: boolean;
  /** Whether injection was performed this turn (for onAfterTurn interval update). */
  injectedThisTurn: boolean;
  /** Per-turn response texts (one per wrapModelCall / wrapModelStream). */
  responseBuffer: string[];
  /** Immutable snapshot of the rolling user-messages buffer at turn start.
   *  Used as drift-callback input so turn N cannot observe turn N+1's
   *  appended messages under overlap. */
  userMessagesSnapshot: readonly DriftUserMessage[];
  /** Previous `lastReminderTurn` value at turn start. Used to roll back
   * the reminder advance if this turn is stop-gate vetoed, so the retry
   * turn still sees the original cadence. */
  previousLastReminderTurn: number;
}

interface GoalSessionState {
  readonly items: readonly GoalItemWithId[];
  /** Pre-computed keywords per goal item text (memoized at session start). */
  readonly keywordsPerItem: ReadonlyMap<string, ReadonlySet<string>>;
  readonly currentInterval: number;
  readonly lastReminderTurn: number;
  /** Rolling buffer of user-facing messages (sanitized). Used by isDrifting callback. */
  userMessageBuffer: DriftUserMessage[];
  /** Active per-turn state, keyed by `ctx.turnId`. Entries are created at
   * onBeforeTurn and removed at onAfterTurn (or implicitly on session end). */
  turns: Map<string, PerTurnState>;
  /**
   * Per-session promise chain for deferred callback processing. Next
   * turn's onBeforeTurn awaits this so the injected goal block reflects
   * the latest completion decisions from the previous turn's
   * detectCompletions callback. Serializes callback work per session.
   */
  pendingWork: Promise<void>;
  /**
   * Count of in-flight isDrifting callbacks for this session.
   * While > 0, `onBeforeTurn` computes reminder cadence against
   * `baseInterval` instead of `currentInterval` — a fail-safe so slow
   * drift judges cannot suppress reminders for many turns by holding
   * a stale large interval.
   */
  pendingDrift: number;
  /**
   * When `true`, the next `onBeforeTurn` forces goal injection
   * regardless of cadence. Set after a stop-gate blocked turn so the
   * retry turn (whatever its index) still injects the goal block,
   * OR after drift is detected on any turn (Issue 1 fix).
   */
  forceInjectNextTurn: boolean;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

function buildGoalMessage(text: string): InboundMessage {
  return {
    senderId: "system:goal",
    timestamp: Date.now(),
    content: [{ kind: "text", text }],
  };
}

export function createGoalMiddleware(config: GoalMiddlewareConfig): GoalMiddlewareWithController {
  const result = validateGoalConfig(config);
  if (!result.ok) {
    throw KoiRuntimeError.from(result.error.code, result.error.message);
  }

  const header = config.header ?? DEFAULT_GOAL_HEADER;
  const baseInterval = config.baseInterval ?? DEFAULT_BASE_INTERVAL;
  const maxInterval = config.maxInterval ?? DEFAULT_MAX_INTERVAL;
  const callbackTimeoutMs = config.callbackTimeoutMs ?? DEFAULT_CALLBACK_TIMEOUT_MS;
  // Mutable: updated by GoalController.add/remove/clear
  let allKeywords = extractKeywords(config.objectives);
  let nextGoalIndex = config.objectives.length;
  const sessions = new Map<SessionId, GoalSessionState>();
  // Goals added via controller before any session starts (pre-session buffer).
  // Merged into the session on onSessionStart, then cleared.
  const pendingItems: GoalItemWithId[] = config.objectives.map((text, index) => ({
    id: `goal-${String(index)}`,
    text,
    completed: false,
  }));
  const deferCompletions = config.detectCompletions !== undefined;
  // Buffer response text when either callback is configured. isDrifting
  // needs recent responses in its DriftJudgeInput; detectCompletions
  // consumes them at turn end. Default (no callbacks) does NOT buffer —
  // heuristic completion runs inline per model call to preserve the
  // synchronous onComplete contract.
  const bufferResponses = deferCompletions || config.isDrifting !== undefined;

  // ---------------------------------------------------------------------------
  // Issue 6: Centralized session state update helper
  // ---------------------------------------------------------------------------

  /** Read-modify-write session state atomically. Returns the updated state or undefined if session missing. */
  function updateSession(
    sid: SessionId,
    updater: (state: GoalSessionState) => Partial<GoalSessionState>,
  ): GoalSessionState | undefined {
    const current = sessions.get(sid);
    if (!current) return undefined;
    const updated = { ...current, ...updater(current) };
    sessions.set(sid, updated);
    return updated;
  }

  // ---------------------------------------------------------------------------
  // Completion detection helpers
  // ---------------------------------------------------------------------------

  /**
   * Apply heuristic completion detection to a single response text.
   * Monotonic: completed objectives never revert to pending.
   * Persists state BEFORE invoking `onComplete` callbacks so callback
   * failures cannot leave stale state.
   */
  function applyHeuristicCompletions(sid: SessionId, text: string): void {
    const current = sessions.get(sid);
    if (!current) return;

    const detected = detectCompletions(text, current.items, current.keywordsPerItem);
    const merged = mergeByPosition(current.items, detected);

    updateSession(sid, () => ({ items: merged }));
    fireOnCompleteForTransitions(current.items, merged);
  }

  /** Apply heuristic completion detection to a per-turn buffer of
   * response texts in sequence, merging monotonically. Called from
   * onAfterTurn in heuristic (non-callback) mode so stop-gate rollback
   * can exclude the vetoed final response. */
  function processHeuristicCompletions(sid: SessionId, entries: readonly string[]): void {
    const current = sessions.get(sid);
    if (!current) return;
    const next = applyHeuristicFallback(current.items, entries, current.keywordsPerItem);
    updateSession(sid, () => ({ items: next }));
    fireOnCompleteForTransitions(current.items, next);
  }

  /** Merge monotonically (position-based — only for heuristic path where items preserve order). */
  function mergeByPosition(
    prev: readonly GoalItemWithId[],
    detected: readonly GoalItemWithId[],
  ): readonly GoalItemWithId[] {
    return prev.map((item, i) => {
      const det = detected[i];
      if (item.completed) return item;
      if (det?.completed) return det;
      return item;
    });
  }

  /** Merge callback result (IDs of newly-completed items) monotonically into items. */
  function mergeByIds(
    prev: readonly GoalItemWithId[],
    completedIds: readonly string[],
  ): readonly GoalItemWithId[] {
    const completedSet = new Set(completedIds);
    return prev.map((item) => {
      if (item.completed) return item;
      if (completedSet.has(item.id)) return { ...item, completed: true };
      return item;
    });
  }

  /** Fire onComplete for items that transitioned from pending → completed. */
  function fireOnCompleteForTransitions(
    prev: readonly GoalItemWithId[],
    next: readonly GoalItemWithId[],
  ): void {
    if (!config.onComplete) return;
    for (let i = 0; i < next.length; i++) {
      const p = prev[i];
      const n = next[i];
      if (p && n && !p.completed && n.completed) {
        try {
          config.onComplete(n.text);
        } catch {
          // Observability must not fail the turn
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Drift detection helpers
  // ---------------------------------------------------------------------------

  /**
   * Atomically adjust `pendingDrift` on the current session-state entry.
   * Always reads the latest value via `sessions.get` and writes via
   * `updateSession` so callers can't decrement against a stale snapshot.
   */
  function adjustPendingDrift(sid: SessionId, delta: number): void {
    updateSession(sid, (s) => ({ pendingDrift: Math.max(0, s.pendingDrift + delta) }));
  }

  /**
   * Evaluate drift for this turn, using the callback if configured.
   * On callback error/timeout, fail-safe to drifting=true so reminders
   * fire more aggressively. On upstream abort, returns undefined to
   * signal the caller to skip interval updates entirely.
   */
  async function resolveDrift(
    state: GoalSessionState,
    turn: PerTurnState,
    ctx: TurnContext,
  ): Promise<boolean | undefined> {
    const sid = ctx.session.sessionId;
    if (config.isDrifting) {
      adjustPendingDrift(sid, 1);
      try {
        const outcome = await invokeIsDriftingCallback(
          config.isDrifting,
          {
            userMessages: cloneMessages(turn.userMessagesSnapshot),
            responseTexts: turn.responseBuffer.slice(),
            items: cloneItems(state.items),
          },
          { timeoutMs: callbackTimeoutMs, ctx, onError: config.onCallbackError },
        );
        if (outcome.ok) return outcome.value;
        if (outcome.reason === "aborted") return undefined;
        return true; // fail-safe on timeout/error
      } finally {
        adjustPendingDrift(sid, -1);
      }
    }
    return isDrifting(ctx.messages, allKeywords);
  }

  /**
   * Invoke the user's detectCompletions callback with the turn's buffered
   * response texts. On error/timeout, fall back to heuristic. Merges
   * results by ID and fires onComplete for transitions.
   */
  async function processDeferredCompletions(
    state: GoalSessionState,
    entries: readonly string[],
    ctx: TurnContext,
  ): Promise<void> {
    if (!config.detectCompletions || entries.length === 0) return;
    const sid = ctx.session.sessionId;

    const current = sessions.get(sid) ?? state;
    const outcome = await invokeDetectCompletionsCallback(
      config.detectCompletions,
      entries.slice(),
      cloneItems(current.items),
      { timeoutMs: callbackTimeoutMs, ctx, onError: config.onCallbackError },
    );

    if (!outcome.ok && outcome.reason === "aborted") return;

    const latest = sessions.get(sid);
    if (!latest) return;

    const next = outcome.ok
      ? mergeByIds(latest.items, outcome.value)
      : applyHeuristicFallback(latest.items, entries, latest.keywordsPerItem);

    updateSession(sid, () => ({ items: next }));
    fireOnCompleteForTransitions(latest.items, next);
  }

  /** Fallback heuristic: run detectCompletions on each entry, merge monotonically. */
  function applyHeuristicFallback(
    items: readonly GoalItemWithId[],
    entries: readonly string[],
    keywordsPerItem?: ReadonlyMap<string, ReadonlySet<string>>,
  ): readonly GoalItemWithId[] {
    let acc = items;
    for (const text of entries) {
      const detected = detectCompletions(text, acc, keywordsPerItem);
      acc = mergeByPosition(acc, detected);
    }
    return acc;
  }

  // ---------------------------------------------------------------------------
  // Defensive cloning for callback trust boundary
  // ---------------------------------------------------------------------------

  function cloneItems(items: readonly GoalItemWithId[]): readonly GoalItemWithId[] {
    return items.map((i) => ({ id: i.id, text: i.text, completed: i.completed }));
  }

  function cloneMessages(messages: readonly DriftUserMessage[]): readonly DriftUserMessage[] {
    return messages.map((m) => ({ senderId: m.senderId, timestamp: m.timestamp, text: m.text }));
  }

  // ---------------------------------------------------------------------------
  // Issue 5: Shared injection logic (DRY wrapModelCall / wrapModelStream)
  // ---------------------------------------------------------------------------

  /** Prepare injection: consume flag, render goal block, build enriched request, report decision. */
  function prepareInjection(
    sid: SessionId,
    state: GoalSessionState,
    ctx: TurnContext,
    request: ModelRequest,
  ): { readonly enrichedRequest: ModelRequest; readonly goalBlock: string | undefined } {
    const turnKey = String(ctx.turnId);
    const inject = consumeInjection(sid, turnKey, ctx.turnIndex);
    const goalBlock = inject ? renderGoalBlock(state.items, header) : undefined;

    if (goalBlock !== undefined) {
      ctx.reportDecision?.({
        turnIndex: ctx.turnIndex,
        objectives: state.items.map((i) => ({ text: i.text, completed: i.completed })),
        completedCount: state.items.filter((i) => i.completed).length,
        totalCount: state.items.length,
        messageCount: request.messages.length,
        goalBlock,
      });
    }

    const enrichedRequest =
      goalBlock !== undefined
        ? { ...request, messages: [buildGoalMessage(goalBlock), ...request.messages] }
        : request;

    return { enrichedRequest, goalBlock };
  }

  // ---------------------------------------------------------------------------
  // Turn callback processing
  // ---------------------------------------------------------------------------

  /**
   * Core callback-processing body — runs serialized via `state.pendingWork`.
   * Handles deferred completions + drift + interval update for one turn.
   *
   * Issue 1 fix: drift is evaluated on EVERY turn (not just injection turns)
   * so that off-topic drift is detected promptly and forceInjectNextTurn
   * is set for the following turn.
   */
  async function processTurnCallbacks(
    state: GoalSessionState,
    turn: PerTurnState,
    ctx: TurnContext,
  ): Promise<void> {
    const sid = ctx.session.sessionId;
    const blocked = ctx.stopBlocked === true;

    // Stop-gate vetoed turn: roll back the synchronous lastReminderTurn
    // advance AND set forceInjectNextTurn so the retry turn still injects.
    if (blocked && turn.injectedThisTurn) {
      updateSession(sid, (s) => ({
        lastReminderTurn:
          s.lastReminderTurn === ctx.turnIndex ? turn.previousLastReminderTurn : s.lastReminderTurn,
        forceInjectNextTurn: true,
      }));
    }

    // Process buffered response texts. Blocked turns drop the last entry.
    if (bufferResponses) {
      const entries = blocked ? turn.responseBuffer.slice(0, -1) : turn.responseBuffer.slice();
      if (deferCompletions) {
        await processDeferredCompletions(state, entries, ctx);
      } else if (entries.length > 0) {
        processHeuristicCompletions(sid, entries);
      }
    }

    if (blocked) return;

    // Issue 1 fix: evaluate drift on EVERY turn, not just injection turns.
    // When drift is detected, set forceInjectNextTurn so goals are re-injected
    // on the very next turn regardless of interval cadence.
    const refreshed = sessions.get(sid) ?? state;
    const drifting = await resolveDrift(refreshed, turn, ctx);
    if (drifting === undefined) return; // upstream abort: skip update

    const nextInterval = computeNextInterval(
      refreshed.currentInterval,
      drifting,
      baseInterval,
      maxInterval,
    );

    updateSession(sid, () => ({
      currentInterval: nextInterval,
      // Force injection on next turn when drifting (Issue 1 core fix)
      ...(drifting ? { forceInjectNextTurn: true } : {}),
    }));
  }

  /**
   * Consume shouldInject on first model call in a turn. Returns whether to inject.
   *
   * Advances `lastReminderTurn` synchronously (CAS: never decreases) so
   * the next turn's `onBeforeTurn` sees the injection immediately.
   */
  function consumeInjection(sid: SessionId, turnIdStr: string, turnIndex: number): boolean {
    const state = sessions.get(sid);
    const turn = state?.turns.get(turnIdStr);
    if (!state || !turn?.shouldInject) return false;
    turn.shouldInject = false;
    turn.injectedThisTurn = true;
    if (turnIndex > state.lastReminderTurn) {
      updateSession(sid, () => ({ lastReminderTurn: turnIndex }));
    }
    return true;
  }

  // ---------------------------------------------------------------------------
  // GoalController — mid-session goal management
  // ---------------------------------------------------------------------------

  /** Recompute allKeywords from all items across all sessions. */
  function recomputeKeywords(items: readonly GoalItemWithId[]): void {
    allKeywords = extractKeywords(items.map((i) => i.text));
  }

  const controller: GoalController = {
    add(text: string): string | undefined {
      const trimmed = text.trim();
      if (trimmed.length === 0) return undefined;

      const id = `goal-${String(nextGoalIndex)}`;
      const newItem: GoalItemWithId = { id, text: trimmed, completed: false };

      // Update active sessions if any exist
      let updated = false;
      for (const [sid, state] of sessions) {
        if (state.items.some((i) => i.text === trimmed)) return undefined;
        nextGoalIndex += 1;
        const newItems = [...state.items, newItem];
        const newKeywords = new Map(state.keywordsPerItem);
        newKeywords.set(trimmed, extractKeywords([trimmed]));
        updateSession(sid, () => ({
          items: newItems,
          keywordsPerItem: newKeywords,
          forceInjectNextTurn: true,
        }));
        recomputeKeywords(newItems);
        updated = true;
      }

      // No active session — buffer for next onSessionStart
      if (!updated) {
        if (pendingItems.some((i) => i.text === trimmed)) return undefined;
        nextGoalIndex += 1;
        pendingItems.push(newItem);
        recomputeKeywords(pendingItems);
      }

      return id;
    },

    remove(text: string): boolean {
      const trimmed = text.trim();
      let found = false;

      // Remove from active sessions
      for (const [sid, state] of sessions) {
        const idx = state.items.findIndex((i) => i.text === trimmed);
        if (idx === -1) continue;
        found = true;
        const newItems = state.items.filter((_, i) => i !== idx);
        const newKeywords = new Map(state.keywordsPerItem);
        newKeywords.delete(trimmed);
        updateSession(sid, () => ({
          items: newItems,
          keywordsPerItem: newKeywords,
          forceInjectNextTurn: true,
        }));
        recomputeKeywords(newItems);
      }

      // Also remove from pending buffer
      const pendingIdx = pendingItems.findIndex((i) => i.text === trimmed);
      if (pendingIdx !== -1) {
        pendingItems.splice(pendingIdx, 1);
        found = true;
        if (sessions.size === 0) recomputeKeywords(pendingItems);
      }

      return found;
    },

    list(): readonly GoalItemWithId[] {
      // Return from active session if exists, otherwise from pending buffer
      for (const state of sessions.values()) {
        return state.items;
      }
      return pendingItems;
    },

    clear(): void {
      for (const [sid] of sessions) {
        updateSession(sid, () => ({
          items: [],
          keywordsPerItem: new Map(),
          forceInjectNextTurn: false,
        }));
      }
      pendingItems.splice(0);
      allKeywords = new Set();
    },
  };

  // ---------------------------------------------------------------------------
  // KoiMiddleware implementation
  // ---------------------------------------------------------------------------

  const middleware: KoiMiddleware = {
    name: "goal",
    priority: 340,

    describeCapabilities(ctx: TurnContext): CapabilityFragment | undefined {
      const sid = ctx.session.sessionId;
      const state = sessions.get(sid);
      if (!state) return undefined;
      const completed = state.items.filter((i) => i.completed).length;
      return {
        label: "goals",
        description: `${String(completed)}/${String(state.items.length)} objectives completed`,
      };
    },

    async onSessionStart(ctx) {
      const sid = ctx.sessionId;
      // Merge pending items (added via controller before session start)
      // with any remaining config objectives not already in pending.
      const items: readonly GoalItemWithId[] = [...pendingItems];
      const keywordsPerItem = new Map<string, ReadonlySet<string>>();
      for (const item of items) {
        keywordsPerItem.set(item.text, extractKeywords([item.text]));
      }
      // Clear pending buffer — items now owned by the session
      pendingItems.splice(0);
      allKeywords = extractKeywords(items.map((i) => i.text));
      sessions.set(sid, {
        items,
        keywordsPerItem,
        currentInterval: baseInterval,
        lastReminderTurn: -1,
        userMessageBuffer: [],
        turns: new Map(),
        pendingWork: Promise.resolve(),
        pendingDrift: 0,
        forceInjectNextTurn: items.length > 0,
      });
    },

    async onBeforeTurn(ctx) {
      const sid = ctx.session.sessionId;
      const state = sessions.get(sid);
      if (!state) return;

      // Only block on prior turns when `detectCompletions` is configured
      if (deferCompletions) await state.pendingWork;

      // Append sanitized user-authored text messages into rolling buffer
      const sanitized = sanitizeUserMessages(ctx.messages);
      for (const m of sanitized) state.userMessageBuffer.push(m);
      const excess = state.userMessageBuffer.length - MESSAGE_BUFFER_SIZE;
      if (excess > 0) state.userMessageBuffer.splice(0, excess);

      // Issue 15: evict stale per-turn entries if over safety bound
      if (state.turns.size >= MAX_CONCURRENT_TURNS) {
        const oldest = state.turns.keys().next().value;
        if (oldest !== undefined) state.turns.delete(oldest);
      }

      const turnsSinceReminder = ctx.turnIndex - state.lastReminderTurn;
      const effectiveInterval = state.pendingDrift > 0 ? baseInterval : state.currentInterval;
      const force = state.forceInjectNextTurn;
      if (force) {
        updateSession(sid, () => ({ forceInjectNextTurn: false }));
      }

      // Issue 3: force-inject when user message contains goal keywords
      const userMentionsGoals = userMessageContainsKeywords(ctx.messages, allKeywords);

      const turn: PerTurnState = {
        turnIndex: ctx.turnIndex,
        shouldInject:
          force ||
          userMentionsGoals ||
          turnsSinceReminder >= effectiveInterval ||
          ctx.turnIndex === 0,
        injectedThisTurn: false,
        responseBuffer: [],
        userMessagesSnapshot: cloneMessages(state.userMessageBuffer),
        previousLastReminderTurn: state.lastReminderTurn,
      };
      state.turns.set(String(ctx.turnId), turn);
    },

    async onAfterTurn(ctx) {
      const sid = ctx.session.sessionId;
      const state = sessions.get(sid);
      if (!state) return;
      const turnKey = String(ctx.turnId);
      const turn = state.turns.get(turnKey);
      if (!turn) return;

      // Always remove per-turn state before any await
      state.turns.delete(turnKey);

      const work = state.pendingWork.then(() => processTurnCallbacks(state, turn, ctx));
      state.pendingWork = work.catch(() => {
        // Swallow: errors already routed through onCallbackError hook.
      });
      return work;
    },

    async wrapModelCall(ctx, request, next) {
      const sid = ctx.session.sessionId;
      const state = sessions.get(sid);
      if (!state) return next(request);

      // Issue 5: shared injection logic
      const { enrichedRequest } = prepareInjection(sid, state, ctx, request);
      const response: ModelResponse = await next(enrichedRequest);

      if (bufferResponses) {
        const turnKey = String(ctx.turnId);
        const currentTurn = state.turns.get(turnKey);
        if (currentTurn) currentTurn.responseBuffer.push(response.content);
      }
      if (!deferCompletions && !bufferResponses) {
        applyHeuristicCompletions(sid, response.content);
      }

      return response;
    },

    async *wrapModelStream(
      ctx: TurnContext,
      request: ModelRequest,
      next: ModelStreamHandler,
    ): AsyncIterable<ModelChunk> {
      const sid = ctx.session.sessionId;
      const state = sessions.get(sid);
      if (!state) {
        yield* next(request);
        return;
      }

      // Issue 5: shared injection logic
      const { enrichedRequest } = prepareInjection(sid, state, ctx, request);
      const turnKey = String(ctx.turnId);

      // Buffer streamed text for completion detection.
      // Flush eagerly on the terminal `done` chunk BEFORE yielding it —
      // `consumeModelStream` calls iterator.return() after processing `done`,
      // which aborts this generator before the `for await` loop can exit
      // naturally (#1530).
      let bufferedText = "";
      for await (const chunk of next(enrichedRequest)) {
        if (chunk.kind === "text_delta") {
          bufferedText += chunk.delta;
        } else if (chunk.kind === "done") {
          const stopReason = chunk.response.stopReason;
          const isErrorClass =
            stopReason === "length" || stopReason === "hook_blocked" || stopReason === "error";
          if (!isErrorClass) {
            if (bufferedText.length === 0) {
              bufferedText = chunk.response.content;
            }
            if (bufferResponses) {
              const turn = state.turns.get(turnKey);
              if (turn) turn.responseBuffer.push(bufferedText);
            }
            if (!deferCompletions && !bufferResponses) {
              applyHeuristicCompletions(sid, bufferedText);
            }
          }
        }
        yield chunk;
      }
    },

    async wrapToolCall(_ctx, request, next) {
      return next(request);
    },

    async onSessionEnd(ctx) {
      sessions.delete(ctx.sessionId);
    },
  };

  return { middleware, controller };
}
