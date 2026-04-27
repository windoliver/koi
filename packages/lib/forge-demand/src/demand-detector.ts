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
 */
export function createForgeDemandDetector(config: ForgeDemandConfig): ForgeDemandHandle {
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

  function emitSignal(state: SessionState, trigger: ForgeTrigger, context: DemandContext): void {
    const key = triggerKey(trigger);
    if (isOnCooldown(state, key)) return;

    // Confidence + cooldown gates run BEFORE budget bookkeeping so a
    // sub-threshold probe never consumes the session budget window.
    const confidence = computeDemandConfidence(trigger, thresholds.confidenceWeights, context);
    if (confidence < config.budget.demandThreshold) return;

    // Count-based session cap only. computeTimeBudgetMs is forge-pipeline
    // compute, not detector wall-clock.
    if (state.sessionEmitCount >= config.budget.maxForgesPerSession) return;

    globalSignalCounter += 1;
    const signal: ForgeDemandSignal = {
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
    };

    if (state.signals.length >= maxPending) {
      const evicted = state.signals.shift();
      if (evicted !== undefined) state.cooldowns.delete(triggerKey(evicted.trigger));
    }
    state.signals.push(signal);
    state.cooldowns.set(key, clock());
    state.sessionEmitCount += 1;
    safeInvoke(config.onDemand, signal);
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

  function checkLatencyDegradation(state: SessionState, toolId: string): void {
    if (config.healthTracker === undefined) return;
    const snapshot = config.healthTracker.getSnapshot(toolId);
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
    const responseId = `${fingerprint}|${responseText.slice(0, 128)}`;
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
    // Per-call identity used to dedup capability-gap counts across
    // retries/replays. Anchors on `turnId` so retries WITHIN a turn share
    // identity, while a new turn is treated as a fresh observation. Adds
    // last-user-message identity as a secondary discriminator so a single
    // turn issuing multiple model calls (refinement loops) doesn't collapse
    // them into one bucket. Falls back to message count for the rare case
    // of empty/system-only requests in tests.
    let secondary = `len:${String(request.messages.length)}`;
    for (let i = request.messages.length - 1; i >= 0; i -= 1) {
      const msg = request.messages[i];
      if (msg !== undefined && msg.senderId === "user") {
        secondary = messageIdentity(msg);
        break;
      }
    }
    return `${String(ctx.turnId)}|${secondary}`;
  }

  function messageIdentity(msg: InboundMessage): string {
    // Per-message identity: senderId + timestamp + content fingerprint.
    // Both timestamp AND content are required:
    //   - Two distinct corrections with the SAME text targeting different
    //     tools (different turns of the conversation) must not collapse
    //     to one signal — content alone fails that case.
    //   - Two messages with the same timestamp but different content must
    //     not collapse — timestamp alone fails that.
    // The koi transport contract treats `msg.timestamp` as stable for a
    // given inbound message, so retries replay the same identity (no
    // restamping in the runtime). Imports that rewrite timestamps are
    // out of scope — they are a logically new transcript.
    let textFingerprint = "";
    let len = 0;
    for (const block of msg.content) {
      if (block.kind === "text") {
        textFingerprint += block.text;
        len += block.text.length;
      }
    }
    const head = textFingerprint.slice(0, 256);
    return `${msg.senderId}|${String(msg.timestamp)}|${String(len)}|${head}`;
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
    for (const msg of request.messages) {
      if (msg.senderId !== "user") continue;
      const id = messageIdentity(msg);
      if (state.emittedCorrectionIds.has(id)) continue;
      if (state.scannedCorrectionIds.has(id)) continue;
      const toolsCompletedAtScan = hasAnyCompletedTool(state);
      if (!toolsCompletedAtScan) {
        state.scannedCorrectionIds.add(id);
        continue;
      }
      if (msg.timestamp > state.lastProcessedUserTimestamp) {
        state.lastProcessedUserTimestamp = msg.timestamp;
      }
      const correctedToolId = resolveCorrectedToolId(state, msg.timestamp);
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
      emitSignal(state, p.trigger, { failureCount: 1, threshold: 1 });
      state.emittedCorrectionIds.add(p.id);
    }
  }

  function resolveCorrectedToolId(state: SessionState, userMessageTimestamp: number): string {
    for (let i = state.recentToolCalls.length - 1; i >= 0; i -= 1) {
      const call = state.recentToolCalls[i];
      if (call !== undefined && call.completedAt >= 0 && call.completedAt <= userMessageTimestamp) {
        return call.toolId;
      }
    }
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
          checkLatencyDegradation(state, toolId);
          return response;
        }
        state.consecutiveFailures.set(toolId, 0);
        checkLatencyDegradation(state, toolId);
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
          checkLatencyDegradation(state, toolId);
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
        checkLatencyDegradation(state, toolId);
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
    getSignals: (sessionId: SessionId): readonly ForgeDemandSignal[] => {
      const state = sessions.get(sessionId);
      return state === undefined ? [] : state.signals.map(cloneSignal);
    },
    dismiss,
    getActiveSignalCount: (sessionId: SessionId): number => {
      const state = sessions.get(sessionId);
      return state === undefined ? 0 : state.signals.length;
    },
  };
}
