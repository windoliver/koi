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
import type {
  ForgeDemandConfig,
  ForgeDemandHandle,
  HeuristicThresholds,
  SessionScopedForgeDemandHandle,
} from "./types.js";

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
/** Max distinct capability-gap buckets retained per session. */
const CAPABILITY_GAP_BUCKET_CAP = 128;
/** Max distinct unresolved-tool query buckets retained per session. */
const NO_MATCHING_TOOL_BUCKET_CAP = 64;
/** Max distinct toolIds retained in failure counters per session. */
const FAILURE_TOOL_CAP = 64;

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
    /**
     * Per-signal cooldown bucket key. Stored at emit time so dismiss/
     * resetTriggerState can clear ONLY the exact bucket that produced
     * the signal — never another task that happens to share the same
     * generic refusal text. F84/F85 regression.
     */
    readonly cooldownKeyBySignal: Map<string, string>;
    /**
     * Per-capability-gap signal: the full counter bucket key
     * (`pattern|taskContext|windowText`). Used so dismiss clears ONLY
     * that task's count, not every task whose refusal text happens to
     * end with the same suffix. F85 regression.
     */
    readonly gapBucketBySignal: Map<string, string>;
    lastProcessedUserTimestamp: number;
    sessionEmitCount: number;
  };

  const sessions = new Map<SessionId, SessionState>();
  /**
   * Per-sessionId generation counter, incremented on every onSessionEnd.
   * Scoped handles capture the generation at issuance and refuse to
   * read or dismiss against a different generation. Without this, a
   * sessionId reused across resume/replay would let an old handle
   * silently attach to the new session's signals — a cross-session
   * isolation break. F88 regression. Kept separate from `sessions`
   * because that map is cleared on session end; this counter must
   * persist for the lifetime of the detector.
   */
  const sessionGenerations = new Map<SessionId, number>();
  function currentGeneration(sid: SessionId): number {
    return sessionGenerations.get(sid) ?? 0;
  }
  // Object-identity authorization for forSession(). Authorizing purely
  // by sessionId would let any in-process caller fabricate a
  // `SessionContext` literal carrying another tenant's id and read or
  // dismiss that tenant's signals. We only register SessionContext
  // objects that have actually flowed through this detector's
  // middleware hooks (wrapToolCall / wrapModelCall / onSessionEnd) —
  // i.e. real engine-issued contexts — and `forSession` rejects
  // anything else.
  // Map a SessionContext object to the sessionId it was FIRST seen with.
  // forSession resolves state via this stored binding, not via the
  // mutable `session.sessionId` field — a caller who legitimately
  // observed one session cannot mutate its sessionId and obtain a
  // handle for a different tenant. F89 regression. (WeakMap so
  // long-running detectors do not retain SessionContext objects past
  // their natural lifetime.)
  const observedSessions = new WeakMap<SessionContext, SessionId>();

  function ensureObserved(session: SessionContext): void {
    if (observedSessions.has(session)) return;
    // First sighting — deliver the unforgeable scoped handle to the
    // legitimate session owner BEFORE marking the session observed,
    // so a transient callback failure does not permanently strand
    // the session: the next call retries delivery. Once the callback
    // returns cleanly, mark observed so subsequent traffic short-
    // circuits without re-firing the callback. If no callback is
    // configured, mark observed immediately. F72 regression.
    if (config.onSessionAttached === undefined) {
      observedSessions.set(session, session.sessionId);
      return;
    }
    // Capture sessionId at issuance and close over it. Resolving via
    // `session.sessionId` on every call would let a later mutation of
    // the SessionContext's sessionId field redirect a previously-issued
    // handle to a different tenant's state — the object-identity
    // authorization check (F61) guards admission, but post-admission
    // resolution must use the id we actually authorized for. F76
    // regression.
    const sid = session.sessionId;
    // Capture the session generation at issuance. If the session ends
    // and a later session reuses the same id, the generation counter
    // advances and this stale handle becomes a no-op. F88 regression.
    const gen = currentGeneration(sid);
    const isLive = (): boolean => currentGeneration(sid) === gen;
    const scoped: SessionScopedForgeDemandHandle = {
      getSignals: (): readonly ForgeDemandSignal[] => {
        if (!isLive()) return [];
        const state = sessions.get(sid);
        return state === undefined ? [] : state.signals.map(cloneSignal);
      },
      dismiss: (signalId: string): void => {
        if (!isLive()) return;
        dismiss(sid, signalId);
      },
      getActiveSignalCount: (): number => {
        if (!isLive()) return 0;
        const state = sessions.get(sid);
        return state === undefined ? 0 : state.signals.length;
      },
    };
    let delivered = true;
    try {
      config.onSessionAttached(session, scoped);
    } catch (e: unknown) {
      delivered = false;
      console.error("[forge-demand] onSessionAttached threw, will retry on next traffic:", e);
    }
    if (delivered) observedSessions.set(session, sid);
  }
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
      cooldownKeyBySignal: new Map(),
      gapBucketBySignal: new Map(),
      lastProcessedUserTimestamp: -1,
      sessionEmitCount: 0,
    };
  }

  /**
   * FIFO map insert with eviction. Bounds per-session counter maps so
   * long-lived sessions with many unique tasks/tools cannot let detector
   * state grow monotonically. JS Maps preserve insertion order, so the
   * first key is the oldest and re-setting an existing key keeps its
   * original position (re-insertion-order semantics intentionally not
   * used here — capability gaps and tool failures naturally re-set on
   * each occurrence, and treating that as freshness would let a hot
   * key keep cold keys evicted indefinitely; insertion-order FIFO is
   * sufficient and predictable). F86 regression.
   */
  function setBoundedMap<K, V>(map: Map<K, V>, key: K, value: V, cap: number): void {
    map.set(key, value);
    while (map.size > cap) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) break;
      if (oldest === key) break;
      map.delete(oldest);
    }
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

  /**
   * Emit a signal. `cooldownKey` overrides the default `triggerKey()`
   * derivation: capability_gap callers must pass the FULL bucket key
   * (`pattern|taskContext|windowText`) so cooldowns and dismissal are
   * scoped to the same task that produced the count, never to every
   * task that happens to share the same generic refusal text. F84/F85.
   */
  function emitSignal(
    state: SessionState,
    trigger: ForgeTrigger,
    context: DemandContext,
    cooldownKey?: string,
  ): boolean {
    const key = cooldownKey ?? triggerKey(trigger);
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
      if (evicted !== undefined) {
        const evictedKey = state.cooldownKeyBySignal.get(evicted.id) ?? triggerKey(evicted.trigger);
        state.cooldowns.delete(evictedKey);
        state.cooldownKeyBySignal.delete(evicted.id);
        state.gapBucketBySignal.delete(evicted.id);
      }
    }
    state.signals.push(signal);
    state.cooldowns.set(key, clock());
    state.cooldownKeyBySignal.set(signal.id, key);
    state.sessionEmitCount += 1;
    safeInvoke(config.onDemand, signal);
    return true;
  }

  function resetTriggerState(state: SessionState, signalId: string, trigger: ForgeTrigger): void {
    switch (trigger.kind) {
      case "repeated_failure":
        state.consecutiveFailures.delete(trigger.toolName);
        state.failedToolCalls.delete(`rf:${trigger.toolName}`);
        return;
      case "no_matching_tool":
        state.noMatchingToolCounts.delete(trigger.query);
        return;
      case "capability_gap": {
        // Clear ONLY the exact bucket that produced this signal.
        // Suffix-matching by `|requiredCapability` (the prior approach)
        // would wipe accumulated counts for every task whose refusal
        // text shared that suffix — silently erasing in-progress
        // evidence for unrelated tasks. F85 regression.
        const bucket = state.gapBucketBySignal.get(signalId);
        if (bucket !== undefined) state.capabilityGapCounts.delete(bucket);
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
      const cdKey = state.cooldownKeyBySignal.get(signalId) ?? triggerKey(signal.trigger);
      state.cooldowns.delete(cdKey);
      resetTriggerState(state, signalId, signal.trigger);
    }
    state.cooldownKeyBySignal.delete(signalId);
    state.gapBucketBySignal.delete(signalId);
    state.signals.splice(idx, 1);
    safeInvoke(config.onDismiss, signalId);
  }

  function checkLatencyDegradation(
    state: SessionState,
    sessionId: SessionId,
    toolId: string,
  ): void {
    if (config.healthTracker === undefined) return;
    // The detector is a passive observer: a throwing health tracker
    // must NOT escape wrapToolCall and turn a successful tool call
    // into a failure or mask the real tool error on the failure path.
    // Isolate the read; on error, skip latency detection for this
    // call and log. F74 regression.
    let snapshot: ReturnType<NonNullable<typeof config.healthTracker>["getSnapshot"]>;
    try {
      snapshot = config.healthTracker.getSnapshot(sessionId, toolId);
    } catch (e: unknown) {
      console.error("[forge-demand] healthTracker.getSnapshot threw:", e);
      return;
    }
    const trigger = detectLatencyDegradation(toolId, snapshot, thresholds.latencyDegradationAvgMs);
    if (trigger !== undefined) {
      emitSignal(state, trigger, {
        failureCount: snapshot?.metrics.avgLatencyMs ?? 0,
        threshold: thresholds.latencyDegradationAvgMs,
      });
    }
  }

  /**
   * Derive a task-context fingerprint from the CURRENT (most recent)
   * user message in the request. Used to scope capability-gap counters
   * so generic refusals ("I don't have a tool for that") to UNRELATED
   * user turns do not aggregate into a single false-positive demand
   * signal. Anchoring on the FIRST user message would be wrong in chat
   * runtimes that replay the entire transcript — every later turn would
   * share the original opener's identity and unrelated subsequent asks
   * would still aggregate (F78). The active turn is the user's current
   * top-level request: a literal repeat shares the bucket; any change
   * to the user's wording starts a fresh bucket. F77/F78 regression.
   * Returns "" when no user message is present (the bucket falls back
   * to refusal-text-only — identical to pre-F77 behavior for that edge).
   */
  function taskContextFingerprint(request: ModelRequest): string {
    for (let i = request.messages.length - 1; i >= 0; i -= 1) {
      const msg = request.messages[i];
      if (msg === undefined || msg.senderId !== "user") continue;
      // CONTENT-only fingerprint — must NOT include `msg.timestamp`.
      // The same ask repeated in a later turn carries a fresh
      // wall-clock timestamp, and timestamp-based scoping would put
      // every retry into its own bucket — defeating the threshold
      // (F80). Includes EVERY content block (not just text) so two
      // turns with the same prompt over different attachments/images
      // do not collapse into one bucket. F83 regression.
      let body = "";
      let total = 0;
      for (const block of msg.content) {
        body += `${blockFingerprint(block)};`;
        total += 1;
      }
      return `${msg.senderId}|n=${String(total)}|${fnv1a(body)}`;
    }
    return "";
  }

  /**
   * Stable per-block fingerprint covering all ContentBlock kinds. Two
   * turns sharing the same text but different attachments or images
   * must NOT collapse into a single task-context bucket — that would
   * cause "summarize this" against different documents to aggregate as
   * one false demand signal. F83 regression.
   */
  function blockFingerprint(block: InboundMessage["content"][number]): string {
    switch (block.kind) {
      case "text":
        return `t:${String(block.text.length)}:${fnv1a(block.text)}`;
      case "file":
        return `f:${block.mimeType}:${fnv1a(`${block.url}|${block.name ?? ""}`)}`;
      case "image":
        return `i:${fnv1a(`${block.url}|${block.alt ?? ""}`)}`;
      case "button":
        return `b:${fnv1a(`${block.label}|${block.action}`)}`;
      case "custom":
        // CustomBlock.data is `unknown` — JSON.stringify is best-effort
        // (cycles fall back to the type tag, preserving distinction
        // between custom-block kinds even when payloads are unhashable).
        try {
          return `c:${block.type}:${fnv1a(JSON.stringify(block.data) ?? "")}`;
        } catch {
          return `c:${block.type}:unhashable`;
        }
      default: {
        // Defensive: future block kinds still get a distinct bucket
        // rather than silently sharing one.
        const tag = (block as { readonly kind?: unknown }).kind;
        return `?:${typeof tag === "string" ? tag : "unknown"}`;
      }
    }
  }

  function checkCapabilityGaps(
    state: SessionState,
    responseText: string,
    fingerprint: string,
    taskContext: string,
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
      // Scope the counter by task context (last user message identity)
      // so unrelated requests producing the same generic refusal do not
      // collapse into one bucket. F77 regression.
      const bucketKey = `${pattern.source}|${taskContext}|${windowText}`;
      const count = (state.capabilityGapCounts.get(bucketKey) ?? 0) + 1;
      setBoundedMap(state.capabilityGapCounts, bucketKey, count, CAPABILITY_GAP_BUCKET_CAP);
      if (count < thresholds.capabilityGapOccurrences) continue;
      // Pass the full bucket key as cooldownKey so suppression and
      // dismissal scope to this exact (pattern,task,window) tuple,
      // not to every task that happens to share the same refusal
      // window. F84 regression.
      const emitted = emitSignal(
        state,
        { kind: "capability_gap", requiredCapability: windowText },
        { failureCount: count, threshold: thresholds.capabilityGapOccurrences },
        `cg:${bucketKey}`,
      );
      if (emitted) {
        const lastSignal = state.signals[state.signals.length - 1];
        if (lastSignal !== undefined) state.gapBucketBySignal.set(lastSignal.id, bucketKey);
      }
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
    // Per-message identity: senderId + timestamp + per-block fingerprint
    // hash covering every ContentBlock kind. Truncating to text-only
    // (as before) let two messages with the same text but different
    // attachments collide as the same identity (F83). Both timestamp
    // AND content are required: timestamp distinguishes distinct
    // messages with identical content (different tool turns), content
    // distinguishes distinct messages that happen to share a
    // millisecond timestamp.
    let body = "";
    let total = 0;
    for (const block of msg.content) {
      body += `${blockFingerprint(block)};`;
      total += 1;
    }
    return `${msg.senderId}|${String(msg.timestamp)}|n=${String(total)}|${fnv1a(body)}`;
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

  function removeToolCall(state: SessionState, entry: RecentToolCall): void {
    const idx = state.recentToolCalls.indexOf(entry);
    if (idx !== -1) state.recentToolCalls.splice(idx, 1);
  }

  function recordFailure(state: SessionState, toolId: string, e: unknown): number {
    const count = (state.consecutiveFailures.get(toolId) ?? 0) + 1;
    setBoundedMap(state.consecutiveFailures, toolId, count, FAILURE_TOOL_CAP);
    const key = `rf:${toolId}`;
    const calls = state.failedToolCalls.get(key) ?? [];
    calls.push(extractMessage(e));
    if (calls.length > MAX_FAILED_CALL_MESSAGES) {
      calls.splice(0, calls.length - MAX_FAILED_CALL_MESSAGES);
    }
    setBoundedMap(state.failedToolCalls, key, calls, FAILURE_TOOL_CAP);
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
      ensureObserved(ctx.session);
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
        // Clear historical failure messages on a clean success so a
        // later repeated-failure signal carries only errors from the
        // current streak. Without this, a tool that recovers and then
        // fails again would surface stale messages from a prior run
        // alongside the fresh failureCount, misleading downstream
        // auto-forge / debugging context. F81 regression.
        state.failedToolCalls.delete(`rf:${toolId}`);
        checkLatencyDegradation(state, ctx.session.sessionId, toolId);
        return response;
      } catch (e: unknown) {
        if (e instanceof KoiRuntimeError && e.code === "NOT_FOUND") {
          // Unresolved tool lookup never executed — drop it from the
          // recent-tool-call history so a later user_correction cannot
          // be misattributed to a phantom tool. F62 regression.
          removeToolCall(state, callEntry);
          const attempts = (state.noMatchingToolCounts.get(toolId) ?? 0) + 1;
          setBoundedMap(state.noMatchingToolCounts, toolId, attempts, NO_MATCHING_TOOL_BUCKET_CAP);
          emitSignal(
            state,
            { kind: "no_matching_tool", query: toolId, attempts },
            { failureCount: attempts, threshold: 1 },
          );
          checkLatencyDegradation(state, ctx.session.sessionId, toolId);
          throw e;
        }
        markToolCallCompleted(callEntry);

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
      ensureObserved(ctx.session);
      const state = getOrCreate(ctx.session.sessionId);
      // Detect corrections eagerly but defer emission — a transient
      // transport/validator failure must not consume forge budget for a
      // response the user never sees.
      const pending = detectPendingCorrections(state, request);
      const fp = requestFingerprint(ctx, request);
      // No user-authored message → fall back to per-request fingerprint
      // so unrelated autonomous/internal turns cannot collapse into a
      // single capability-gap bucket via empty-string scoping. F82
      // regression.
      const taskCtx = taskContextFingerprint(request) || `internal:${fp}`;
      const response = await next(request);
      commitCorrections(state, pending);
      checkCapabilityGaps(state, extractResponseText(response), fp, taskCtx);
      return response;
    },

    wrapModelStream(
      ctx: TurnContext,
      request: ModelRequest,
      next: ModelStreamHandler,
    ): AsyncIterable<ModelChunk> {
      ensureObserved(ctx.session);
      const state = getOrCreate(ctx.session.sessionId);
      const pending = detectPendingCorrections(state, request);
      const fp = requestFingerprint(ctx, request);
      // No user-authored message → fall back to per-request fingerprint
      // so unrelated autonomous/internal turns cannot collapse into a
      // single capability-gap bucket via empty-string scoping. F82
      // regression.
      const taskCtx = taskContextFingerprint(request) || `internal:${fp}`;
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
            // Match wrapModelCall ordering: commit corrections first,
            // then capability gaps. Different orderings here would let
            // the same conversation drop a different signal under
            // tight maxForgesPerSession / cooldown budgets depending
            // only on whether the provider used streaming. F71
            // regression.
            commitCorrections(state, pending);
            if (text.length > 0) checkCapabilityGaps(state, text, fp, taskCtx);
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
      // Bump generation so any previously issued scoped handles are
      // revoked: if a future session reuses this sessionId, those
      // stale closures will not be able to read or dismiss its
      // signals. F88 regression.
      sessionGenerations.set(ctx.sessionId, currentGeneration(ctx.sessionId) + 1);
    },

    // The detector is a passive observer: we MUST NOT inject
    // detector state into the model prompt via the capability banner.
    // Surfacing signals here conditions future model calls on
    // observed state (a non-passive behavior change), and a banner
    // hardcoded to "capability gaps" misleads the model about the
    // actual trigger kind. Signals are exposed ONLY through the
    // explicit SessionScopedForgeDemandHandle and onDemand callback.
    // F87 regression.
    describeCapabilities(_ctx: TurnContext): CapabilityFragment | undefined {
      return undefined;
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
    forSession: (session: SessionContext) => {
      // Authorize by SessionContext object identity AND resolve the
      // sessionId from the binding stored at first observation, NOT
      // from the (mutable) `session.sessionId` field. A caller who
      // legitimately observed one session cannot mutate that object's
      // sessionId and obtain a handle for a different tenant — the
      // bound id is the one we actually authorized for. F61/F89
      // regression.
      const sid = observedSessions.get(session);
      if (sid === undefined) {
        throw new Error(
          "forSession requires a SessionContext that has been observed by " +
            "the detector middleware. Pass the SessionContext your runtime " +
            "issued to the engine (e.g. ctx.session inside a hook), not a " +
            "fabricated literal carrying only a sessionId.",
        );
      }
      // Capture the current session generation. If the session ends
      // before this handle is consumed, the generation advances and
      // every operation becomes a no-op — the new session that
      // happens to reuse `sid` is not addressable through this stale
      // handle. F88 regression.
      const gen = currentGeneration(sid);
      const isLive = (): boolean => currentGeneration(sid) === gen;
      return {
        getSignals: (): readonly ForgeDemandSignal[] => {
          if (!isLive()) return [];
          const state = sessions.get(sid);
          return state === undefined ? [] : state.signals.map(cloneSignal);
        },
        dismiss: (signalId: string): void => {
          if (!isLive()) return;
          dismiss(sid, signalId);
        },
        getActiveSignalCount: (): number => {
          if (!isLive()) return 0;
          const state = sessions.get(sid);
          return state === undefined ? 0 : state.signals.length;
        },
      };
    },
  };
}
