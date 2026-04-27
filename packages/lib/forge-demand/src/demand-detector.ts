/**
 * Forge demand detector middleware factory.
 *
 * Passive observer: monitors `wrapToolCall` and `wrapModelCall` to detect
 * capability gaps, repeated failures, latency degradation, and user
 * corrections. Mutates internal state only — never alters tool/model
 * results, never injects messages, never side-effects the agent loop.
 */

import type {
  CapabilityFragment,
  ForgeDemandSignal,
  ForgeTrigger,
  InboundMessage,
  KoiMiddleware,
  ModelChunk,
  ModelHandler,
  ModelRequest,
  ModelResponse,
  ModelStreamHandler,
  SessionContext,
  SessionId,
  ToolHandler,
  ToolRequest,
  ToolResponse,
  TurnContext,
} from "@koi/core";
import { extractMessage, KoiRuntimeError } from "@koi/errors";
import type { DemandContext } from "./confidence.js";
import { computeDemandConfidence, DEFAULT_CONFIDENCE_WEIGHTS } from "./confidence.js";
import { validateForgeDemandConfig } from "./config.js";
import {
  DEFAULT_CAPABILITY_GAP_PATTERNS,
  DEFAULT_USER_CORRECTION_PATTERNS,
  detectLatencyDegradation,
  detectRepeatedFailure,
  detectUserCorrection,
} from "./heuristics.js";
import type { ForgeDemandConfig, ForgeDemandHandle, HeuristicThresholds } from "./types.js";

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_MAX_PENDING_SIGNALS = 10;
const MAX_FAILED_CALL_MESSAGES = 10;
/** Chars from the match index used to scope per-gap counters. */
const GAP_CONTEXT_WINDOW = 120;
/** Max successful tool calls retained for user-correction attribution. */
const RECENT_TOOL_CALL_HISTORY = 16;
/** Max (request, response) ids retained for capability-gap retry dedup. */
const RECENT_GAP_RESPONSE_CAP = 32;
/** Max correction message identities retained per session. */
const CORRECTION_ID_CAP = 256;

const DEFAULT_THRESHOLDS: HeuristicThresholds = {
  repeatedFailureCount: 3,
  capabilityGapOccurrences: 2,
  latencyDegradationAvgMs: 5_000,
  confidenceWeights: DEFAULT_CONFIDENCE_WEIGHTS,
} as const;

// ---------------------------------------------------------------------------
// Trigger key — dedup key for cooldowns
// ---------------------------------------------------------------------------

function triggerKey(trigger: ForgeTrigger): string {
  switch (trigger.kind) {
    case "repeated_failure":
      return `rf:${trigger.toolName}`;
    case "no_matching_tool":
      return `nmt:${trigger.query}`;
    case "capability_gap":
      return `cg:${trigger.requiredCapability}`;
    case "performance_degradation":
      return `pd:${trigger.toolName}`;
    case "user_correction":
      // Include the corrected tool so the same phrasing against different
      // tools does not collapse into a single cooldown bucket.
      return `uc:${trigger.correctedToolCall}|${trigger.correctionDescription.slice(0, 50)}`;
    default:
      return `other:${trigger.kind}`;
  }
}

function extractResponseText(response: ModelResponse): string {
  return typeof response.content === "string" ? response.content : "";
}

/**
 * Detect the `{ error: string; code: string }` in-band failure shape used by
 * many tools in this monorepo (read, write, edit, todo, etc.) instead of
 * throwing. Treating these as successes would silently hide real repeated
 * failures from the demand detector.
 */
function isInBandToolError(output: unknown): boolean {
  if (output === null || typeof output !== "object") return false;
  const o = output as Record<string, unknown>;
  return typeof o.error === "string" && typeof o.code === "string";
}

/**
 * Invoke an observer callback without letting it alter control flow.
 *
 * The detector is documented as a passive observer — a throwing `onDemand`
 * or `onDismiss` must not turn a successful tool/model call into a failure
 * or mask the real error in the catch path.
 */
function safeInvoke<T>(cb: ((value: T) => void) | undefined, value: T): void {
  if (cb === undefined) return;
  try {
    cb(value);
  } catch (e: unknown) {
    // Last-resort isolation: callback errors are swallowed here so the
    // wrapped call is never altered. Surface via console.error so they
    // stay visible without affecting agent-loop semantics.
    console.error("[forge-demand] observer callback threw:", e);
  }
}

function mergeThresholds(overrides: Partial<HeuristicThresholds> | undefined): HeuristicThresholds {
  return {
    ...DEFAULT_THRESHOLDS,
    ...overrides,
    confidenceWeights: {
      ...DEFAULT_CONFIDENCE_WEIGHTS,
      ...overrides?.confidenceWeights,
    },
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a forge demand detector middleware.
 *
 * Returns a `ForgeDemandHandle` bundling the middleware and the signal
 * query API. The middleware is passive — it never mutates requests or
 * responses; consumers query `getSignals()` and `dismiss()` externally.
 *
 * Throws synchronously when `config` is malformed (missing/invalid budget,
 * negative thresholds, etc.). Validation runs at factory time so an
 * untyped JS caller or deserialized-config caller fails fast at startup
 * instead of crashing on the first tool/model event with a `Cannot read
 * properties of undefined` from a missing `budget.cooldownMs`.
 */
export function createForgeDemandDetector(rawConfig: ForgeDemandConfig): ForgeDemandHandle {
  const validated = validateForgeDemandConfig(rawConfig);
  if (!validated.ok) {
    throw new Error(
      `Invalid forgeDemand config: ${validated.error.message}` +
        (validated.error.context !== undefined
          ? ` (${JSON.stringify(validated.error.context)})`
          : ""),
    );
  }
  // Use the validated/normalized object so all downstream reads
  // (budget fields, default-merged heuristics) come from the safe shape.
  const config = validated.value;
  const clock = config.clock ?? Date.now;
  const maxPending = config.maxPendingSignals ?? DEFAULT_MAX_PENDING_SIGNALS;
  const patterns = config.capabilityGapPatterns ?? DEFAULT_CAPABILITY_GAP_PATTERNS;
  const correctionPatterns = config.userCorrectionPatterns ?? DEFAULT_USER_CORRECTION_PATTERNS;
  const thresholds = mergeThresholds(config.heuristics);

  // Per-session mutable state. Sharing this across sessions would let one
  // tenant's failures bleed into another's cooldowns/signals/budget, so
  // the runtime keys every counter by `ctx.session.sessionId` and
  // `onSessionEnd(ctx)` clears only that session's entry.
  type RecentToolCall = {
    readonly toolId: string;
    readonly startedAt: number;
    completedAt: number;
  };
  type SessionState = {
    readonly signals: ForgeDemandSignal[];
    readonly cooldowns: Map<string, number>;
    readonly consecutiveFailures: Map<string, number>;
    readonly failedToolCalls: Map<string, string[]>;
    readonly capabilityGapCounts: Map<string, number>;
    readonly noMatchingToolCounts: Map<string, number>;
    readonly recentToolCalls: RecentToolCall[];
    readonly emittedCorrectionIds: Set<string>;
    readonly scannedCorrectionIds: Set<string>;
    readonly recentGapResponseIds: Set<string>;
    lastProcessedUserTimestamp: number;
    sessionEmitCount: number;
  };

  const sessions = new Map<SessionId, SessionState>();
  // Handle-level counter so signal ids are unique across sessions —
  // otherwise two concurrent tenants would both produce `demand-1` and
  // `dismiss()` could clear the wrong session's signal.
  let globalSignalCounter = 0;

  function newSessionState(): SessionState {
    return {
      signals: [],
      cooldowns: new Map(),
      consecutiveFailures: new Map(),
      failedToolCalls: new Map(),
      capabilityGapCounts: new Map(),
      noMatchingToolCounts: new Map(),
      recentToolCalls: [],
      emittedCorrectionIds: new Set(),
      scannedCorrectionIds: new Set(),
      recentGapResponseIds: new Set(),
      lastProcessedUserTimestamp: -1,
      sessionEmitCount: 0,
    };
  }

  /**
   * FIFO add: insert into the set, evicting the oldest entry once `cap`
   * is exceeded. Bounds long-lived sessions so correction-id sets cannot
   * grow without limit. Sets in V8/Bun preserve insertion order, so the
   * first key from `values()` is the oldest.
   */
  function addBoundedId(set: Set<string>, id: string, cap: number = CORRECTION_ID_CAP): void {
    set.add(id);
    while (set.size > cap) {
      const oldest = set.values().next().value;
      if (oldest === undefined) break;
      set.delete(oldest);
    }
  }

  function getOrCreate(sessionId: SessionId): SessionState {
    let state = sessions.get(sessionId);
    if (state === undefined) {
      state = newSessionState();
      sessions.set(sessionId, state);
    }
    return state;
  }

  function isOnCooldown(state: SessionState, key: string): boolean {
    const lastEmitted = state.cooldowns.get(key);
    if (lastEmitted === undefined) return false;
    return clock() - lastEmitted < config.budget.cooldownMs;
  }

  function emitSignal(state: SessionState, trigger: ForgeTrigger, context: DemandContext): boolean {
    const key = triggerKey(trigger);
    if (isOnCooldown(state, key)) return false;

    // Confidence + cooldown gates run BEFORE budget bookkeeping so a
    // sub-threshold probe never consumes the session budget window.
    const confidence = computeDemandConfidence(trigger, thresholds.confidenceWeights, context);
    if (confidence < config.budget.demandThreshold) return false;

    // Count-based session cap only. computeTimeBudgetMs is forge-pipeline
    // compute, not detector wall-clock.
    if (state.sessionEmitCount >= config.budget.maxForgesPerSession) return false;

    globalSignalCounter += 1;
    // Snapshot failedToolCalls — callers must never see, and onDemand
    // observers must never be able to mutate, the live state array.
    const signal = cloneSignal({
      id: `demand-${String(globalSignalCounter)}`,
      kind: "forge_demand",
      trigger,
      confidence,
      suggestedBrickKind: "tool",
      context: {
        failureCount: context.failureCount,
        failedToolCalls: state.failedToolCalls.get(key) ?? [],
      },
      emittedAt: clock(),
    });

    if (state.signals.length >= maxPending) {
      const evicted = state.signals.shift();
      if (evicted !== undefined) state.cooldowns.delete(triggerKey(evicted.trigger));
    }
    state.signals.push(signal);
    state.cooldowns.set(key, clock());
    state.sessionEmitCount += 1;
    safeInvoke(config.onDemand, signal);
    return true;
  }

  function resetTriggerState(state: SessionState, trigger: ForgeTrigger): void {
    switch (trigger.kind) {
      case "repeated_failure":
        state.consecutiveFailures.delete(trigger.toolName);
        state.failedToolCalls.delete(`rf:${trigger.toolName}`);
        return;
      case "no_matching_tool":
        state.noMatchingToolCounts.delete(trigger.query);
        return;
      case "capability_gap": {
        const suffix = `|${trigger.requiredCapability}`;
        for (const k of state.capabilityGapCounts.keys()) {
          if (k.endsWith(suffix)) state.capabilityGapCounts.delete(k);
        }
        return;
      }
      default:
        return;
    }
  }

  /**
   * Dismiss a signal by id within a specific session. Cross-session
   * dismissal is forbidden so one tenant cannot acknowledge or clear
   * another tenant's demand state even with knowledge of an id.
   */
  function dismiss(sessionId: SessionId, signalId: string): void {
    const state = sessions.get(sessionId);
    if (state === undefined) return;
    const idx = state.signals.findIndex((s) => s.id === signalId);
    if (idx === -1) return;
    const signal = state.signals[idx];
    if (signal !== undefined) {
      state.cooldowns.delete(triggerKey(signal.trigger));
      resetTriggerState(state, signal.trigger);
    }
    state.signals.splice(idx, 1);
    safeInvoke(config.onDismiss, signalId);
  }

  function checkLatencyDegradation(
    state: SessionState,
    sessionId: SessionId,
    toolId: string,
  ): void {
    if (config.healthTracker === undefined) return;
    const snapshot = config.healthTracker.getSnapshot(sessionId, toolId);
    const trigger = detectLatencyDegradation(toolId, snapshot, thresholds.latencyDegradationAvgMs);
    if (trigger !== undefined) {
      emitSignal(state, trigger, {
        failureCount: snapshot?.metrics.avgLatencyMs ?? 0,
        threshold: thresholds.latencyDegradationAvgMs,
      });
    }
  }

  function checkCapabilityGaps(
    state: SessionState,
    responseText: string,
    fingerprint: string,
  ): void {
    if (patterns.length === 0 || responseText.length === 0) return;
    // Hash the full response — earlier 128-char prefix would let two long
    // distinct refusals share a bucket and silently dedupe each other.
    const responseId = `${fingerprint}|${String(responseText.length)}|${fnv1a(responseText)}`;
    if (state.recentGapResponseIds.has(responseId)) return;
    state.recentGapResponseIds.add(responseId);
    if (state.recentGapResponseIds.size > RECENT_GAP_RESPONSE_CAP) {
      const oldest = state.recentGapResponseIds.values().next().value;
      if (oldest !== undefined) state.recentGapResponseIds.delete(oldest);
    }
    for (const pattern of patterns) {
      pattern.lastIndex = 0;
      const match = pattern.exec(responseText);
      if (match === null) continue;
      const matchStart = match.index;
      const windowText = responseText
        .slice(matchStart, matchStart + GAP_CONTEXT_WINDOW)
        .toLowerCase()
        .replace(/\s+/g, " ")
        .trim();
      const key = `${pattern.source}|${windowText}`;
      const count = (state.capabilityGapCounts.get(key) ?? 0) + 1;
      state.capabilityGapCounts.set(key, count);
      if (count < thresholds.capabilityGapOccurrences) continue;
      emitSignal(
        state,
        { kind: "capability_gap", requiredCapability: windowText },
        { failureCount: count, threshold: thresholds.capabilityGapOccurrences },
      );
    }
  }

  /**
   * Scan request.messages for user corrections WITHOUT emitting yet. Returns
   * the new high-water timestamp + the buffered triggers. The caller emits
   * and commits the watermark only after the wrapped model call succeeds
   * so a transient model failure + retry cannot:
   *   - drop the correction signal (watermark advanced before next), or
   *   - duplicate the correction signal (emit fired before next throws,
   *     then retry re-scans the same transcript and emits again).
   */
  function requestFingerprint(ctx: TurnContext, request: ModelRequest): string {
    // Content-based identity: turnId + FULL-message-stack hash. Earlier
    // versions truncated to the first 512 chars and lost discrimination
    // on long transcripts (a refinement loop with a 600-char prefix
    // shared between attempts would collapse to one bucket). Hashing the
    // entire concatenation eliminates that class of collision.
    let body = "";
    let total = 0;
    for (const msg of request.messages) {
      body += `${messageIdentity(msg)};`;
      total += 1;
    }
    return `${String(ctx.turnId)}|n=${String(total)}|${fnv1a(body)}`;
  }

  /**
   * 32-bit FNV-1a hash. Cheap, deterministic, no allocations per char.
   * Sufficient for in-process dedup keys (we accept astronomically rare
   * collisions in exchange for bounded-size identity strings — content
   * is also length-prefixed so collisions require both equal length AND
   * equal hash).
   */
  function fnv1a(s: string): string {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i += 1) {
      h ^= s.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return h.toString(36);
  }

  function messageIdentity(msg: InboundMessage): string {
    // Per-message identity: senderId + timestamp + length + FULL-content
    // hash. Truncating content to a prefix (as before) lets two distinct
    // long messages with the same prefix collide and silently dedupe each
    // other — see F51. Hashing the entire concatenated text avoids that.
    // Both timestamp AND content are required: timestamp distinguishes
    // distinct messages with identical content (different tool turns),
    // content distinguishes distinct messages that happen to share a
    // millisecond timestamp.
    let textFingerprint = "";
    let len = 0;
    for (const block of msg.content) {
      if (block.kind === "text") {
        textFingerprint += block.text;
        len += block.text.length;
      }
    }
    return `${msg.senderId}|${String(msg.timestamp)}|${String(len)}|${fnv1a(textFingerprint)}`;
  }

  function hasAnyCompletedTool(state: SessionState): boolean {
    for (const call of state.recentToolCalls) {
      if (call.completedAt >= 0) return true;
    }
    return false;
  }

  type PendingCorrection = {
    readonly id: string;
    readonly trigger: ForgeTrigger;
  };

  /**
   * Detect (but do not emit) user corrections present in the request. The
   * caller commits the result with `commitCorrections()` only after the
   * wrapped model call succeeds — otherwise a transient transport/validator
   * failure would consume the session forge budget and lock the cooldown
   * for a response that never reached the user. Pre-tool-completion replay
   * IS marked scanned here so it cannot resurrect after a later tool runs.
   */
  function detectPendingCorrections(
    state: SessionState,
    request: ModelRequest,
  ): readonly PendingCorrection[] {
    if (correctionPatterns.length === 0) return [];
    const pending: PendingCorrection[] = [];
    // Track the previous user-message TURN timestamp seen in THIS transcript
    // scan. Adjacency uses transcript order, not the per-session watermark
    // (the watermark advances on scan and would equal the current
    // timestamp on retry replays — defeating the check). Multiple user
    // messages sharing one timestamp are treated as a single turn so
    // adjacency does not collapse against same-ms peers.
    let prevUserTurnTs = -1;
    let currentUserTurnTs = -1;
    for (const msg of request.messages) {
      if (msg.senderId !== "user") continue;
      if (msg.timestamp !== currentUserTurnTs) {
        prevUserTurnTs = currentUserTurnTs;
        currentUserTurnTs = msg.timestamp;
      }
      const id = messageIdentity(msg);
      if (state.emittedCorrectionIds.has(id) || state.scannedCorrectionIds.has(id)) continue;
      const toolsCompletedAtScan = hasAnyCompletedTool(state);
      if (!toolsCompletedAtScan) {
        addBoundedId(state.scannedCorrectionIds, id);
        continue;
      }
      if (msg.timestamp > state.lastProcessedUserTimestamp) {
        state.lastProcessedUserTimestamp = msg.timestamp;
      }
      const correctedToolId = resolveCorrectedToolId(state, msg.timestamp, prevUserTurnTs);
      if (correctedToolId === "") continue;
      for (const block of msg.content) {
        if (block.kind !== "text") continue;
        const trigger = detectUserCorrection(block.text, correctionPatterns, correctedToolId);
        if (trigger !== undefined) pending.push({ id, trigger });
      }
    }
    return pending;
  }

  function commitCorrections(state: SessionState, pending: readonly PendingCorrection[]): void {
    for (const p of pending) {
      if (state.emittedCorrectionIds.has(p.id)) continue;
      // Only mark emitted when emitSignal actually emitted. A correction
      // suppressed by cooldown/threshold/maxForges must remain eligible
      // for the next retry/replay, otherwise raising demandThreshold
      // would silently blacklist every correction for the session.
      const emitted = emitSignal(state, p.trigger, { failureCount: 1, threshold: 1 });
      if (emitted) addBoundedId(state.emittedCorrectionIds, p.id);
    }
  }

  /**
   * Attribute a user-correction to a tool call ONLY when that tool ran in
   * the assistant turn the user is correcting — i.e., between the previous
   * user message and this one. Without this adjacency check, a user
   * correcting a pure-model answer in a session that earlier used tools
   * would falsely blame an unrelated tool and burn the session forge
   * budget on noise.
   */
  function resolveCorrectedToolId(
    state: SessionState,
    userMessageTimestamp: number,
    previousUserTimestamp: number,
  ): string {
    for (let i = state.recentToolCalls.length - 1; i >= 0; i -= 1) {
      const call = state.recentToolCalls[i];
      if (
        call !== undefined &&
        call.completedAt >= 0 &&
        call.completedAt > previousUserTimestamp &&
        call.completedAt <= userMessageTimestamp
      ) {
        return call.toolId;
      }
    }
    // userMessageTimestamp === 0 is the deterministic / mock-clock sentinel
    // (no real timestamp ordering available). In that mode there is no
    // adjacency signal to use, so fall back to "most recent completed tool"
    // — the original behavior. Real-time messages always have non-zero
    // timestamps and skip this fallback.
    if (userMessageTimestamp !== 0) return "";
    for (let i = state.recentToolCalls.length - 1; i >= 0; i -= 1) {
      const call = state.recentToolCalls[i];
      if (call !== undefined && call.completedAt >= 0) return call.toolId;
    }
    return "";
  }

  function recordToolCall(state: SessionState, toolId: string): RecentToolCall {
    const entry: RecentToolCall = { toolId, startedAt: clock(), completedAt: -1 };
    state.recentToolCalls.push(entry);
    while (state.recentToolCalls.length > RECENT_TOOL_CALL_HISTORY) {
      let evictIdx = -1;
      for (let i = 0; i < state.recentToolCalls.length; i += 1) {
        const c = state.recentToolCalls[i];
        if (c !== undefined && c.completedAt >= 0) {
          evictIdx = i;
          break;
        }
      }
      if (evictIdx === -1) evictIdx = 0;
      state.recentToolCalls.splice(evictIdx, 1);
    }
    return entry;
  }

  function markToolCallCompleted(entry: RecentToolCall): void {
    entry.completedAt = clock();
  }

  function recordFailure(state: SessionState, toolId: string, e: unknown): number {
    const count = (state.consecutiveFailures.get(toolId) ?? 0) + 1;
    state.consecutiveFailures.set(toolId, count);
    const key = `rf:${toolId}`;
    const calls = state.failedToolCalls.get(key) ?? [];
    calls.push(extractMessage(e));
    if (calls.length > MAX_FAILED_CALL_MESSAGES) {
      calls.splice(0, calls.length - MAX_FAILED_CALL_MESSAGES);
    }
    state.failedToolCalls.set(key, calls);
    return count;
  }

  // ---------------------------------------------------------------------------
  // Middleware
  // ---------------------------------------------------------------------------

  const middleware: KoiMiddleware = {
    name: "forge-demand-detector",
    // Outer layer relative to feedback-loop (priority 450) — lower priority
    // runs first / wraps later layers. This ordering matters:
    //   - Latency check: feedback-loop records tool-health AFTER `next()`,
    //     so the detector must observe AFTER feedback-loop has committed
    //     the latest call's metrics to read a non-stale snapshot.
    //   - Capability-gap check: feedback-loop runs validators + `runWithRetry`
    //     around model calls. If the detector ran inside, it would emit
    //     signals from rejected attempts the user never sees and burn the
    //     session forge budget on noise.
    priority: 445,

    async wrapToolCall(
      ctx: TurnContext,
      request: ToolRequest,
      next: ToolHandler,
    ): Promise<ToolResponse> {
      const state = getOrCreate(ctx.session.sessionId);
      const { toolId } = request;
      const callEntry = recordToolCall(state, toolId);
      try {
        const response = await next(request);
        markToolCallCompleted(callEntry);
        if (isInBandToolError(response.output)) {
          const inBand = new Error((response.output as { readonly error: string }).error);
          const count = recordFailure(state, toolId, inBand);
          const repeated = detectRepeatedFailure(toolId, count, thresholds.repeatedFailureCount);
          if (repeated !== undefined) {
            emitSignal(state, repeated, {
              failureCount: count,
              threshold: thresholds.repeatedFailureCount,
            });
          }
          checkLatencyDegradation(state, ctx.session.sessionId, toolId);
          return response;
        }
        state.consecutiveFailures.set(toolId, 0);
        checkLatencyDegradation(state, ctx.session.sessionId, toolId);
        return response;
      } catch (e: unknown) {
        markToolCallCompleted(callEntry);
        if (e instanceof KoiRuntimeError && e.code === "NOT_FOUND") {
          const attempts = (state.noMatchingToolCounts.get(toolId) ?? 0) + 1;
          state.noMatchingToolCounts.set(toolId, attempts);
          emitSignal(
            state,
            { kind: "no_matching_tool", query: toolId, attempts },
            { failureCount: attempts, threshold: 1 },
          );
          checkLatencyDegradation(state, ctx.session.sessionId, toolId);
          throw e;
        }

        const count = recordFailure(state, toolId, e);
        const repeated = detectRepeatedFailure(toolId, count, thresholds.repeatedFailureCount);
        if (repeated !== undefined) {
          emitSignal(state, repeated, {
            failureCount: count,
            threshold: thresholds.repeatedFailureCount,
          });
        }
        checkLatencyDegradation(state, ctx.session.sessionId, toolId);
        throw e;
      }
    },

    async wrapModelCall(
      ctx: TurnContext,
      request: ModelRequest,
      next: ModelHandler,
    ): Promise<ModelResponse> {
      const state = getOrCreate(ctx.session.sessionId);
      // Detect corrections eagerly but defer emission — a transient
      // transport/validator failure must not consume forge budget for a
      // response the user never sees.
      const pending = detectPendingCorrections(state, request);
      const fp = requestFingerprint(ctx, request);
      const response = await next(request);
      commitCorrections(state, pending);
      checkCapabilityGaps(state, extractResponseText(response), fp);
      return response;
    },

    wrapModelStream(
      ctx: TurnContext,
      request: ModelRequest,
      next: ModelStreamHandler,
    ): AsyncIterable<ModelChunk> {
      const state = getOrCreate(ctx.session.sessionId);
      const pending = detectPendingCorrections(state, request);
      const fp = requestFingerprint(ctx, request);
      const upstream = next(request);
      return (async function* relay() {
        let buffer = "";
        for await (const chunk of upstream) {
          if (chunk.kind === "text_delta") {
            buffer += chunk.delta;
          } else if (chunk.kind === "done") {
            // Commit BEFORE yielding the terminal chunk so a consumer that
            // breaks/returns immediately after receiving `done` cannot
            // silently drop committed signals. The `done` chunk itself is
            // the commit-point — once seen, the model output is committed
            // regardless of how the consumer drains the iterator.
            const text = extractResponseText(chunk.response) || buffer;
            if (text.length > 0) checkCapabilityGaps(state, text, fp);
            commitCorrections(state, pending);
          }
          yield chunk;
        }
        // Aborted streams (no `done` chunk delivered, transport threw, or
        // consumer stopped before the terminal chunk) commit nothing —
        // partial text is uncommitted output and can flip-flop on retry.
      })();
    },

    async onSessionEnd(ctx: SessionContext): Promise<void> {
      // Drop only this session's state — never touch other live sessions.
      sessions.delete(ctx.sessionId);
    },

    describeCapabilities(ctx: TurnContext): CapabilityFragment | undefined {
      const state = sessions.get(ctx.session.sessionId);
      if (state === undefined || state.signals.length === 0) return undefined;
      const plural = state.signals.length === 1 ? "" : "s";
      return {
        label: "forge-demand",
        description: `Forge demand: ${String(state.signals.length)} capability gap${plural} detected`,
      };
    },
  };

  /**
   * Deep-clone + freeze a signal so external consumers cannot mutate
   * detector-owned state through shared references. `dismiss()` and
   * cooldown cleanup rely on the internal copy being authoritative —
   * letting callers mutate `id` or `trigger` on the returned object
   * would corrupt those code paths.
   */
  function cloneSignal(s: ForgeDemandSignal): ForgeDemandSignal {
    return Object.freeze({
      ...s,
      trigger: Object.freeze({ ...s.trigger }) as ForgeTrigger,
      context: Object.freeze({
        failureCount: s.context.failureCount,
        failedToolCalls: Object.freeze([...s.context.failedToolCalls]),
      }),
    });
  }

  return {
    middleware,
    forSession: (session: SessionContext) => ({
      getSignals: (): readonly ForgeDemandSignal[] => {
        const state = sessions.get(session.sessionId);
        return state === undefined ? [] : state.signals.map(cloneSignal);
      },
      dismiss: (signalId: string): void => dismiss(session.sessionId, signalId),
      getActiveSignalCount: (): number => {
        const state = sessions.get(session.sessionId);
        return state === undefined ? 0 : state.signals.length;
      },
    }),
  };
}
