/**
 * createUserModelMiddleware — single coordinated pipeline that fuses
 * pre-action ambiguity, post-action corrections (incl. drift), and sensor
 * signals into one [User Context] block. Each channel is independently
 * optional and degrades gracefully when its dependencies are missing.
 */

import type {
  CapabilityFragment,
  KoiMiddleware,
  ModelHandler,
  ModelRequest,
  ModelResponse,
  SessionContext,
  TurnContext,
} from "@koi/core";
import { classifyAmbiguity } from "./ambiguity-classifier.js";
import { resolveUserModelDefaults } from "./config.js";
import { buildContextMessage, formatUserContext } from "./context-injector.js";
import { isCorrection } from "./correction-detector.js";
import { drainPendingStores, ingestPersistedSignal, recallPreferences } from "./persistence.js";
import {
  applySubjectScope,
  ensureSession,
  freshSession,
  ingestInternal,
  ingestSensor,
  type SessionState,
} from "./session-state.js";
import { readSignalSources } from "./signal-reader.js";
import {
  buildSnapshot,
  collectExistingPreferences,
  hasContent,
  prependPinned,
} from "./snapshot.js";
import { extractLastUserMessage } from "./text-extractor.js";
import type { ResolvedUserModelConfig, UserModelConfig } from "./types.js";

export function createUserModelMiddleware(config: UserModelConfig): KoiMiddleware {
  const cfg = resolveUserModelDefaults(config);
  const sessions = new Map<string, SessionState>();
  return {
    name: "user-model",
    priority: cfg.priority,
    phase: "intercept",
    onSessionStart(ctx: SessionContext): Promise<void> {
      sessions.set(ctx.sessionId, startSession(cfg, ctx));
      return Promise.resolve();
    },
    onSessionEnd(ctx: SessionContext): Promise<void> {
      sessions.delete(ctx.sessionId);
      return Promise.resolve();
    },
    onBeforeTurn(ctx: TurnContext): Promise<void> {
      return handleOnBeforeTurn(cfg, sessions, ctx);
    },
    wrapModelCall(
      ctx: TurnContext,
      request: ModelRequest,
      handler: ModelHandler,
    ): Promise<ModelResponse> {
      const state = obtainSession(cfg, sessions, ctx.session);
      return runWrapModelCall(cfg, state, ctx, request, handler);
    },
    describeCapabilities(): CapabilityFragment | undefined {
      return { label: "user-model", description: describeChannels(cfg) };
    },
  } satisfies KoiMiddleware;
}

/**
 * Closure-capture pattern: `s` is referenced inside the lazy snapshot
 * builder before it is assigned, but the builder only fires when the
 * cache is queried — by then the binding is initialized.
 */
function startSession(cfg: ResolvedUserModelConfig, session: SessionContext): SessionState {
  // eslint-disable-next-line prefer-const -- TDZ-safe self-referential closure
  let s: SessionState;
  s = freshSession(() => Promise.resolve(buildSnapshot(s)));
  applySubjectScope(cfg, s, session);
  return s;
}

function obtainSession(
  cfg: ResolvedUserModelConfig,
  sessions: Map<string, SessionState>,
  session: SessionContext,
): SessionState {
  // eslint-disable-next-line prefer-const -- TDZ-safe self-referential closure
  let s: SessionState;
  s = ensureSession(sessions, session, cfg, () => Promise.resolve(buildSnapshot(s)));
  return s;
}

function handleOnBeforeTurn(
  cfg: ResolvedUserModelConfig,
  sessions: Map<string, SessionState>,
  ctx: TurnContext,
): Promise<void> {
  const state = obtainSession(cfg, sessions, ctx.session);
  // Chain behind any in-flight OBT for this session. The lock is
  // released as soon as THIS OBT completes (eager snapshot is set by
  // then). wrapModelCall is independent — it reads its turn's snapshot
  // directly. (review round 15, finding 2.)
  const next = state.obtChain.then(
    () => runBeforeTurn(cfg, state, ctx),
    () => runBeforeTurn(cfg, state, ctx),
  );
  state.obtChain = next.catch(() => undefined);
  return next;
}

async function runBeforeTurn(
  cfg: ResolvedUserModelConfig,
  state: SessionState,
  ctx: TurnContext,
): Promise<void> {
  // 1. Sensor channel — read sources in parallel, drop non-sensor returns at
  //    the boundary, and reconcile sensorState so a failed source doesn't
  //    leave stale values pinned forever.
  const { signals, failedSources } = await readSignalSources(
    cfg.signalSources,
    cfg.signalTimeoutMs,
    cfg.onError,
  );
  // Evict every cached entry that any failed source had populated. We
  // key sensorState by SignalSource.name (which is unique per
  // registration, see config validation), so a failed source can only
  // ever evict ITS OWN slot — never a healthy peer's data
  // (review round 16, finding 3).
  for (const name of failedSources) {
    delete state.sensorState[name];
  }
  for (const { sourceName, signal } of signals) {
    ingestSensor(state, sourceName, signal);
  }

  // 2. Drain any persistence promises from prior turns (bounded by
  //    persistenceTimeoutMs) so a correction stored in turn N is observable
  //    to this turn's recall. Stragglers are abandoned — the in-session
  //    merge in buildSnapshot still surfaces them in the prompt.
  await drainPendingStores(state, cfg.persistenceTimeoutMs, cfg.onError);

  // 3. Recall preferences once per turn — seeds drift detection AND
  //    populates the snapshot cache so wrapModelCall has the same view.
  state.lastRecalledPreferences = await recallPreferences(cfg, state).catch((e: unknown) => {
    cfg.onError(e);
    return [];
  });

  // 4. Inspect the latest user message for pre/post-action signals.
  // Clear per-turn carryover from the previous turn before re-deriving.
  state.pendingPreAction = undefined;
  state.pendingPostAction = undefined;
  const last = extractLastUserMessage(ctx.messages);
  if (last === undefined) {
    state.cache.invalidate();
    state.snapshotByTurn.set(ctx.turnId, buildSnapshot(state));
    return;
  }
  const { message: lastMessage, text } = last;
  // Skip signal derivation when the engine re-presents the EXACT same
  // user message OBJECT (stop-gate retry path). Reference identity only:
  // text equality would silently drop legitimate later turns where the
  // user genuinely repeats the same wording (review round 15, finding 3).
  if (
    state.lastProcessedUserMessage !== undefined &&
    state.lastProcessedUserMessage === lastMessage
  ) {
    state.cache.invalidate();
    state.snapshotByTurn.set(ctx.turnId, buildSnapshot(state));
    return;
  }
  state.lastProcessedUserMessage = lastMessage;

  await derivePerTurnSignals(cfg, state, text);

  state.cache.invalidate();
  // Eagerly snapshot the turn AFTER all awaits so two overlapping turns
  // each capture their own view before either reaches wrapModelCall
  // (review round 13, finding 3). buildSnapshot has no awaits, so this
  // is effectively synchronous.
  state.snapshotByTurn.set(ctx.turnId, buildSnapshot(state));
}

async function derivePerTurnSignals(
  cfg: ResolvedUserModelConfig,
  state: SessionState,
  text: string,
): Promise<void> {
  // Single post-action decision per message. The explicit-correction path
  // runs first; drift only persists when explicit declined. Without this
  // gate, "Actually use JSON instead of YAML" would store the full message
  // (explicit) AND the captured `newValue` ("JSON" — drift), permanently
  // duplicating the preference store.
  let postActionPersistedThisTurn = false;

  if (cfg.postActionEnabled) {
    try {
      if (isCorrection(text)) {
        const stored = await ingestPersistedSignal(cfg, state, text, "explicit");
        if (stored) postActionPersistedThisTurn = true;
      }
    } catch (e: unknown) {
      cfg.onError(e);
    }
  }

  if (cfg.driftEnabled && cfg.driftDetector !== undefined && !postActionPersistedThisTurn) {
    try {
      // Seed drift from BOTH persisted preferences AND in-session post_action
      // history so a transient memory.store/recall failure cannot lose
      // earlier corrections from the live session.
      const existing = collectExistingPreferences(state);
      const decision = await cfg.driftDetector.detect(text, existing);
      // Require a validated newValue before persisting drift. Falling back to
      // the raw turn text would let a malformed classifier response (e.g.,
      // bundled LLM detector returning `{ drifted: true }` on JSON parse
      // failure) durably store arbitrary user prose as a "preference"
      // (review round 11, finding 2).
      if (
        decision.drifted &&
        typeof decision.newValue === "string" &&
        decision.newValue.length > 0
      ) {
        await ingestPersistedSignal(cfg, state, decision.newValue, "drift");
      }
    } catch (e: unknown) {
      // Detector failure must NOT durably store arbitrary turn text as a
      // preference (review round 3, finding 1). Surface the error and skip
      // drift persistence for this turn — the next turn re-runs detection.
      cfg.onError(e);
    }
  }

  // Pre-action ambiguity is per-turn (the carryover slot was cleared
  // above). Stops a single vague request from poisoning the rest of the
  // session with stale clarification prompts.
  if (cfg.preActionEnabled) {
    try {
      const ambiguity = classifyAmbiguity(text);
      if (ambiguity.ambiguous && ambiguity.question !== undefined) {
        const sig = {
          kind: "pre_action",
          question: ambiguity.question,
          answer: "",
        } as const;
        state.pendingPreAction = sig;
        ingestInternal(state, sig);
      }
    } catch (e: unknown) {
      cfg.onError(e);
    }
  }
}

async function runWrapModelCall(
  cfg: ResolvedUserModelConfig,
  state: SessionState,
  ctx: TurnContext,
  request: ModelRequest,
  next: ModelHandler,
): Promise<ModelResponse> {
  // Prefer the eager per-turn snapshot captured at the end of OBT — that
  // entry was built before any later turn could mutate shared state
  // (review round 13, finding 3). Fall back to the lazy cache when WMC
  // is invoked without a prior OBT (e.g., transient runtime).
  const eager = state.snapshotByTurn.get(ctx.turnId);
  if (eager !== undefined) state.snapshotByTurn.delete(ctx.turnId);
  const snapshot = eager ?? (await state.cache.get());
  if (!hasContent(snapshot)) return next(request);
  const text = formatUserContext(snapshot, {
    maxPreferenceTokens: cfg.maxPreferenceTokens,
    maxSensorTokens: cfg.maxSensorTokens,
    maxMetaTokens: cfg.maxMetaTokens,
  });
  const pinned = buildContextMessage(text);
  const enriched: ModelRequest = {
    ...request,
    messages: prependPinned(pinned, request.messages),
  };
  return next(enriched);
}

function describeChannels(cfg: ResolvedUserModelConfig): string {
  const channels: string[] = [];
  if (cfg.preActionEnabled) channels.push("pre-action");
  if (cfg.postActionEnabled) channels.push("post-action");
  if (cfg.signalSources.length > 0) channels.push(`sensor(${String(cfg.signalSources.length)})`);
  if (cfg.driftEnabled) channels.push("drift");
  if (channels.length === 0) return "user-model: no channels enabled";
  return `user-model: ${channels.join(" + ")}`;
}
