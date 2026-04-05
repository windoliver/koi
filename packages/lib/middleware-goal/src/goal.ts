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
  type GoalItem,
  type GoalItemWithId,
  type GoalMiddlewareConfig,
  validateGoalConfig,
} from "./config.js";

// ---------------------------------------------------------------------------
// Session state
// ---------------------------------------------------------------------------

/** Max user messages buffered across turns for the isDrifting callback. */
const MESSAGE_BUFFER_SIZE = 10;

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
}

interface GoalSessionState {
  readonly items: readonly GoalItemWithId[];
  readonly currentInterval: number;
  readonly lastReminderTurn: number;
  /** Rolling buffer of user-facing messages (sanitized). Used by isDrifting callback. */
  userMessageBuffer: InboundMessage[];
  /** Active per-turn state, keyed by `ctx.turnId`. Entries are created at
   * onBeforeTurn and removed at onAfterTurn (or implicitly on session end). */
  turns: Map<string, PerTurnState>;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Normalize text for keyword extraction and matching.
 *
 * Splits identifier boundaries so that short acronyms participate in
 * matching when they appear as distinct segments:
 *
 * - camelCase boundary (lower→upper) becomes a space: `fixCiPipeline`
 *   → `fix ci pipeline`.
 * - Common separators `_`, `-`, `/` become spaces: `fix_ci_pipeline`,
 *   `fix-ci-pipeline`, `src/fix/ci/runner.ts` all tokenize their parts.
 * - `.` is preserved (stripped, not split) so dotted versions like
 *   `Release v1.2.3` keep `v123` as a distinguishing token instead of
 *   collapsing to a bare `release` keyword.
 *
 * Remaining punctuation is stripped, then lowercased.
 */
export function normalizeText(text: string): string {
  return text
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_\-/]/g, " ")
    .replace(/[^a-zA-Z0-9\s]/g, "")
    .toLowerCase();
}

/**
 * Extract keywords from objective text for matching.
 *
 * All non-empty tokens are kept, including short acronyms and numerals.
 * Short tokens would previously be dropped when a long word was present
 * in the same objective, but that erases distinguishing segments of
 * compound objectives like "iOS support" or "CI/CD pipeline" — leaving
 * only "support"/"pipeline" as generic keywords that false-trigger on
 * unrelated completion text. Keeping every token raises the majority
 * threshold and preserves acronyms as distinguishing signals.
 *
 * Match-time strictness is handled in matchesToken (exact for <=2,
 * prefix+bounded-suffix for 3, substring for >=4) so short tokens
 * cannot silently match inside longer words.
 */
export function extractKeywords(objectives: readonly string[]): ReadonlySet<string> {
  const result = new Set<string>();
  for (const obj of objectives) {
    for (const word of normalizeText(obj).split(/\s+/)) {
      if (word.length > 0) result.add(word);
    }
  }
  return result;
}

/** Tokenize normalized text into a set of words for token-based matching. */
function tokenizeNormalized(normalized: string): ReadonlySet<string> {
  const tokens = new Set<string>();
  for (const t of normalized.split(/\s+/)) {
    if (t.length > 0) tokens.add(t);
  }
  return tokens;
}

/**
 * Check whether a keyword matches within a set of tokens.
 *
 * Three-tier rule balances inflection tolerance against false-positive
 * risk as keyword length shrinks:
 *
 * - len <= 2 (e.g. "ci", "ui", "7"): exact token equality — prevents
 *   "ci" matching inside "cinema".
 * - len === 3 (e.g. "fix", "add", "api"): exact OR token-prefix with a
 *   bounded inflection suffix (<=3 chars). "fix" satisfies "fixing"
 *   (+ing), "fixed" (+ed), "fixups" (+ups), but not "additional" (+7)
 *   or "addressing" (+7). This handles common inflection without
 *   letting short verb roots swallow unrelated long words.
 * - len >= 4 (e.g. "write", "trajectory"): substring within any token —
 *   handles inflections and camelCase identifiers like
 *   "recordedTrajectoryPath" that don't get split by normalization.
 */
const MAX_INFLECTION_SUFFIX = 3;
function matchesToken(keyword: string, tokens: ReadonlySet<string>): boolean {
  if (keyword.length <= 2) {
    return tokens.has(keyword);
  }
  if (keyword.length === 3) {
    for (const t of tokens) {
      if (t === keyword) return true;
      if (t.startsWith(keyword) && t.length - keyword.length <= MAX_INFLECTION_SUFFIX) {
        return true;
      }
    }
    return false;
  }
  for (const t of tokens) {
    if (t.includes(keyword)) return true;
  }
  return false;
}

/** Render a markdown todo block from goal items. */
export function renderGoalBlock(items: readonly GoalItem[], header: string): string {
  const lines = [header, ""];
  for (const item of items) {
    const mark = item.completed ? "x" : " ";
    lines.push(`- [${mark}] ${item.text}`);
  }
  return lines.join("\n");
}

const COMPLETION_SIGNALS = /\b(?:completed|done|finished|accomplished)\b|\[x\]|✓|✅/i;

/**
 * Detect which objectives were completed based on response text.
 *
 * Requires a completion signal AND a majority of the objective's keywords
 * (>= 50%, minimum 2 if the objective has 2+ keywords) to match. This
 * prevents false positives from single generic words like "write" or
 * "integration" appearing in unrelated completion text.
 */
export function detectCompletions<T extends GoalItem>(
  responseText: string,
  items: readonly T[],
): readonly T[] {
  if (!COMPLETION_SIGNALS.test(responseText)) {
    return items;
  }

  const textTokens = tokenizeNormalized(normalizeText(responseText));
  return items.map((item) => {
    if (item.completed) return item;
    const keywords = extractKeywords([item.text]);
    if (keywords.size === 0) return item;

    // Word-boundary match: exact for short keywords, prefix for >=3-char keywords.
    const matchCount = [...keywords].filter((kw) => matchesToken(kw, textTokens)).length;
    // Require majority match: at least half the keywords, minimum 2 if available
    const threshold = keywords.size === 1 ? 1 : Math.max(2, Math.ceil(keywords.size / 2));
    if (matchCount >= threshold) {
      return { ...item, completed: true };
    }
    return item;
  });
}

/** Check if the agent is drifting from goals based on recent messages. */
export function isDrifting(
  messages: readonly InboundMessage[],
  keywords: ReadonlySet<string>,
): boolean {
  if (keywords.size === 0) return false;
  const recent = messages.slice(-3);
  const textTokens = tokenizeNormalized(
    normalizeText(
      recent
        .map((m) =>
          m.content
            .filter((b): b is { readonly kind: "text"; readonly text: string } => b.kind === "text")
            .map((b) => b.text)
            .join(" "),
        )
        .join(" "),
    ),
  );

  // Word-boundary match: exact for short keywords, prefix for >=3-char keywords.
  return ![...keywords].some((kw) => matchesToken(kw, textTokens));
}

/** Compute next interval based on drift. */
export function computeNextInterval(
  currentInterval: number,
  drifting: boolean,
  baseInterval: number,
  maxInterval: number,
): number {
  if (drifting) return baseInterval;
  return Math.min(currentInterval * 2, maxInterval);
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

export function createGoalMiddleware(config: GoalMiddlewareConfig): KoiMiddleware {
  const result = validateGoalConfig(config);
  if (!result.ok) {
    throw KoiRuntimeError.from(result.error.code, result.error.message);
  }

  const header = config.header ?? DEFAULT_GOAL_HEADER;
  const baseInterval = config.baseInterval ?? DEFAULT_BASE_INTERVAL;
  const maxInterval = config.maxInterval ?? DEFAULT_MAX_INTERVAL;
  const callbackTimeoutMs = config.callbackTimeoutMs ?? DEFAULT_CALLBACK_TIMEOUT_MS;
  const allKeywords = extractKeywords(config.objectives);
  const sessions = new Map<SessionId, GoalSessionState>();
  const deferCompletions = config.detectCompletions !== undefined;
  // Buffer response text whenever EITHER callback is configured — isDrifting
  // callback needs recent assistant responses even when detectCompletions
  // is not deferred.
  const bufferResponses = deferCompletions || config.isDrifting !== undefined;

  /**
   * Apply heuristic completion detection to a single response text.
   * Monotonic: completed objectives never revert to pending.
   * Persists state BEFORE invoking `onComplete` callbacks so callback
   * failures cannot leave stale state.
   */
  function applyHeuristicCompletions(sid: SessionId, text: string): void {
    // Always read the latest state from the map to avoid stale snapshots
    const current = sessions.get(sid);
    if (!current) return;

    const detected = detectCompletions(text, current.items);
    const merged = mergeByPosition(current.items, detected);

    // Persist state BEFORE invoking callbacks
    sessions.set(sid, { ...current, items: merged });
    fireOnCompleteForTransitions(current.items, merged);
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

  /**
   * Evaluate drift for this turn, using the callback if configured.
   * On callback error/timeout, fail-safe to drifting=true so reminders
   * fire more aggressively (v1 semantics). On upstream abort, returns
   * undefined to signal the caller to skip interval updates entirely.
   */
  async function resolveDrift(
    state: GoalSessionState,
    turn: PerTurnState,
    ctx: TurnContext,
  ): Promise<boolean | undefined> {
    if (config.isDrifting) {
      const outcome = await invokeIsDriftingCallback(
        config.isDrifting,
        {
          userMessages: cloneMessages(state.userMessageBuffer),
          responseTexts: turn.responseBuffer.slice(),
          items: cloneItems(state.items),
        },
        { timeoutMs: callbackTimeoutMs, ctx, onError: config.onCallbackError },
      );
      if (outcome.ok) return outcome.value;
      if (outcome.reason === "aborted") return undefined; // skip interval update
      return true; // fail-safe on timeout/error
    }
    // Heuristic default: unchanged from pre-callback behavior — uses
    // ctx.messages exactly as before. Callers needing richer context
    // should provide an `isDrifting` callback.
    return isDrifting(ctx.messages, allKeywords);
  }

  /**
   * Invoke the user's detectCompletions callback with the turn's buffered
   * response texts. On error/timeout, fall back to heuristic (monotonic,
   * safer to miss a completion than falsely complete). Merges results by
   * ID and fires onComplete for transitions.
   */
  async function processDeferredCompletions(
    state: GoalSessionState,
    entries: readonly string[],
    ctx: TurnContext,
  ): Promise<void> {
    if (!config.detectCompletions || entries.length === 0) return;

    const outcome = await invokeDetectCompletionsCallback(
      config.detectCompletions,
      entries.slice(),
      cloneItems(state.items),
      { timeoutMs: callbackTimeoutMs, ctx, onError: config.onCallbackError },
    );

    // Upstream abort: the run was cancelled — do not mutate goal state or
    // fire onComplete side effects. The documented cancellation contract
    // is that completions from the aborted turn are lost.
    if (!outcome.ok && outcome.reason === "aborted") return;

    // Re-read session state after the await: another turn for the same
    // session may have run during the callback (up to callbackTimeoutMs),
    // and we must not roll back its buffer/flag fields.
    const latest = sessions.get(ctx.session.sessionId);
    if (!latest) return;

    const next = outcome.ok
      ? mergeByIds(latest.items, outcome.value)
      : applyHeuristicFallback(latest.items, entries);

    sessions.set(ctx.session.sessionId, { ...latest, items: next });
    fireOnCompleteForTransitions(latest.items, next);
  }

  /** Fallback heuristic: run detectCompletions on each entry, merge monotonically. */
  function applyHeuristicFallback(
    items: readonly GoalItemWithId[],
    entries: readonly string[],
  ): readonly GoalItemWithId[] {
    let acc = items;
    for (const text of entries) {
      const detected = detectCompletions(text, acc);
      acc = mergeByPosition(acc, detected);
    }
    return acc;
  }

  /**
   * Defensive clone of session items before exposing to user callbacks.
   * Readonly is only enforced at type level; without cloning, a buggy or
   * malicious callback could mutate session state in place.
   */
  function cloneItems(items: readonly GoalItemWithId[]): readonly GoalItemWithId[] {
    return items.map((i) => ({ id: i.id, text: i.text, completed: i.completed }));
  }

  /**
   * Defensive deep-clone of user-messages buffer before exposing to
   * callbacks. Prevents callback-side mutation from poisoning the
   * session-state buffer for subsequent turns.
   */
  function cloneMessages(messages: readonly InboundMessage[]): readonly InboundMessage[] {
    return messages.map((m) => ({
      senderId: m.senderId,
      timestamp: m.timestamp,
      content: m.content.map((b) =>
        b.kind === "text" ? { kind: "text" as const, text: b.text } : { ...b },
      ),
    }));
  }

  /** Consume shouldInject on first model call in a turn. Returns whether to inject. */
  function consumeInjection(sid: SessionId, turnIdStr: string): boolean {
    const state = sessions.get(sid);
    const turn = state?.turns.get(turnIdStr);
    if (!turn?.shouldInject) return false;
    turn.shouldInject = false;
    turn.injectedThisTurn = true;
    return true;
  }

  return {
    name: "goal",
    priority: 340,

    describeCapabilities(ctx: TurnContext): CapabilityFragment | undefined {
      const state = sessions.get(ctx.session.sessionId);
      if (!state) return undefined;
      const completed = state.items.filter((i) => i.completed).length;
      return {
        label: "goals",
        description: `${String(completed)}/${String(state.items.length)} objectives completed`,
      };
    },

    async onSessionStart(ctx) {
      const items: readonly GoalItemWithId[] = config.objectives.map((text, index) => ({
        id: `goal-${String(index)}`,
        text,
        completed: false,
      }));
      sessions.set(ctx.sessionId, {
        items,
        currentInterval: baseInterval,
        lastReminderTurn: -1,
        userMessageBuffer: [],
        turns: new Map(),
      });
    },

    async onBeforeTurn(ctx) {
      const state = sessions.get(ctx.session.sessionId);
      if (!state) return;

      const turnsSinceReminder = ctx.turnIndex - state.lastReminderTurn;
      const turn: PerTurnState = {
        turnIndex: ctx.turnIndex,
        shouldInject: turnsSinceReminder >= state.currentInterval || ctx.turnIndex === 0,
        injectedThisTurn: false,
        responseBuffer: [],
      };
      state.turns.set(String(ctx.turnId), turn);

      // Append sanitized user-authored text messages into rolling buffer.
      const sanitized = sanitizeUserMessages(ctx.messages);
      for (const m of sanitized) state.userMessageBuffer.push(m);
      const excess = state.userMessageBuffer.length - MESSAGE_BUFFER_SIZE;
      if (excess > 0) state.userMessageBuffer.splice(0, excess);
    },

    async onAfterTurn(ctx) {
      const state = sessions.get(ctx.session.sessionId);
      if (!state) return;
      const turnKey = String(ctx.turnId);
      const turn = state.turns.get(turnKey);
      if (!turn) return;

      // Always remove our per-turn state before any await so a sibling
      // turn cannot observe it.
      state.turns.delete(turnKey);

      // stop-gate vetoed turns: process completions from accepted earlier model
      // calls (all but last entry), skip drift update entirely.
      const blocked = ctx.stopBlocked === true;

      if (deferCompletions) {
        const entries = blocked ? turn.responseBuffer.slice(0, -1) : turn.responseBuffer.slice();
        await processDeferredCompletions(state, entries, ctx);
      }

      if (blocked) return;

      if (turn.injectedThisTurn) {
        // Re-read session state so drift evaluation sees the post-deferred-
        // completions item status, not the stale snapshot from turn start.
        const refreshed = sessions.get(ctx.session.sessionId) ?? state;
        const drifting = await resolveDrift(refreshed, turn, ctx);
        if (drifting === undefined) return; // upstream abort: skip interval update

        const nextInterval = computeNextInterval(
          refreshed.currentInterval,
          drifting,
          baseInterval,
          maxInterval,
        );
        const latest = sessions.get(ctx.session.sessionId) ?? refreshed;
        // Compare-and-swap: never move lastReminderTurn backwards. A
        // newer turn may have already advanced it while this turn's
        // callback was awaiting.
        if (ctx.turnIndex < latest.lastReminderTurn) return;
        sessions.set(ctx.session.sessionId, {
          ...latest,
          currentInterval: nextInterval,
          lastReminderTurn: ctx.turnIndex,
        });
      }
    },

    async wrapModelCall(ctx, request, next) {
      const state = sessions.get(ctx.session.sessionId);
      if (!state) return next(request);
      const turnKey = String(ctx.turnId);

      const inject = consumeInjection(ctx.session.sessionId, turnKey);
      const enrichedRequest = inject
        ? {
            ...request,
            messages: [buildGoalMessage(renderGoalBlock(state.items, header)), ...request.messages],
          }
        : request;

      const response: ModelResponse = await next(enrichedRequest);

      if (bufferResponses) {
        const turn = state.turns.get(turnKey);
        if (turn) turn.responseBuffer.push(response.content);
      }
      if (!deferCompletions) applyHeuristicCompletions(ctx.session.sessionId, response.content);

      return response;
    },

    async *wrapModelStream(
      ctx: TurnContext,
      request: ModelRequest,
      next: ModelStreamHandler,
    ): AsyncIterable<ModelChunk> {
      const state = sessions.get(ctx.session.sessionId);
      if (!state) {
        yield* next(request);
        return;
      }

      const turnKey = String(ctx.turnId);
      const inject = consumeInjection(ctx.session.sessionId, turnKey);
      const enrichedRequest = inject
        ? {
            ...request,
            messages: [buildGoalMessage(renderGoalBlock(state.items, header)), ...request.messages],
          }
        : request;

      // Buffer streamed text for completion detection — only on success
      let bufferedText = "";
      let succeeded = false;
      try {
        for await (const chunk of next(enrichedRequest)) {
          if (chunk.kind === "text_delta") {
            bufferedText += chunk.delta;
          } else if (chunk.kind === "done" && bufferedText.length === 0) {
            // Fallback: some adapters only emit done.response.content with no text_delta
            bufferedText = chunk.response.content;
          }
          yield chunk;
        }
        succeeded = true;
      } finally {
        // Only update state if stream completed successfully
        if (succeeded) {
          if (bufferResponses) {
            const turn = state.turns.get(turnKey);
            if (turn) turn.responseBuffer.push(bufferedText);
          }
          if (!deferCompletions) applyHeuristicCompletions(ctx.session.sessionId, bufferedText);
        }
      }
    },

    async wrapToolCall(_ctx, request, next) {
      return next(request);
    },

    async onSessionEnd(ctx) {
      sessions.delete(ctx.sessionId);
    },
  };
}
