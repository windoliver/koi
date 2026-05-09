import type { ForgeDemandSignal } from "@koi/core";
import { createPolicyCacheMiddleware, type PolicyCacheHandle } from "@koi/middleware-policy-cache";
import {
  createSessionStateMap,
  formatGeneratePrompt,
  GLOBAL_SESSION_BUCKET,
  getOrCreateSessionState,
  resolveMaxSynthesesPerSession,
  type SessionState,
  triggerIdentity,
} from "./internals.js";
import { runPipeline } from "./run-pipeline.js";
import type {
  AutoHarnessConfig,
  AutoHarnessError,
  AutoHarnessEvent,
  AutoHarnessSessionContext,
  AutoHarnessStack,
  AutoHarnessSynthesisResult,
} from "./types.js";

/**
 * Validate config invariants and wrap the verifier in a runtime sync-only
 * gate. Throws on misconfiguration; returns the wrapped verifier.
 */
function validateConfigAndWrapVerifier(
  config: AutoHarnessConfig,
): ((entry: unknown) => boolean) | undefined {
  if (config.policyVerifier !== undefined && config.notifier === undefined) {
    throw new Error(
      "@koi/auto-harness: `notifier` (StoreChangeNotifier) is required when " +
        "`policyVerifier` is configured. Deployed policy-cache entries can " +
        "outlive their backing brick if the cache has no invalidation source, " +
        "leaving stale allow/deny decisions in place after the brick is " +
        "updated, removed, or quarantined. Supply a notifier wired to the " +
        "forge store's lifecycle events.",
    );
  }
  if (config.policyVerifier === undefined) return undefined;
  // Wrap the verifier with a runtime sync-boolean check. An async verifier
  // returns a Promise (truthy → silently approves every register, a
  // trust-boundary failure). The TS type forbids it; this guards untyped
  // JS hosts (R5 round 11).
  const verifier = config.policyVerifier as (e: unknown) => unknown;
  return (entry) => {
    const result = verifier(entry);
    if (
      result !== null &&
      typeof result === "object" &&
      typeof (result as { then?: unknown }).then === "function"
    ) {
      throw new Error(
        "@koi/auto-harness: policyVerifier must return boolean synchronously. " +
          "An async verifier returns a Promise, which is truthy and would silently " +
          "approve every policy-cache registration — a trust-boundary failure.",
      );
    }
    if (typeof result !== "boolean") {
      throw new Error(
        `@koi/auto-harness: policyVerifier must return boolean, got ${typeof result}.`,
      );
    }
    return result;
  };
}

interface SynthesizeDeps {
  readonly config: AutoHarnessConfig;
  readonly emitEvent: (event: AutoHarnessEvent) => void;
  readonly reportError: (error: AutoHarnessError) => void;
  readonly policyCacheHandle: PolicyCacheHandle;
  readonly sessionState: Map<string, SessionState>;
  readonly maxSynthesesPerSession: number;
}

/**
 * Per-call dedupe + budget gate around `runPipeline`. Coalesces concurrent
 * emissions of the same trigger, suppresses replays of completed triggers
 * until `resetSession`, refunds the budget on transient outcomes, and
 * dismisses the demand signal only after a non-transient terminal outcome
 * (so transient outages preserve detector evidence; R5 round 17).
 */
async function synthesizeOne(
  deps: SynthesizeDeps,
  signal: ForgeDemandSignal,
  session: AutoHarnessSessionContext | undefined,
): Promise<AutoHarnessSynthesisResult> {
  const sessionKey = session?.sessionId ?? GLOBAL_SESSION_BUCKET;
  const state = getOrCreateSessionState(deps.sessionState, sessionKey);
  const triggerKey = triggerIdentity(signal);
  const safeDismiss = (): void => {
    if (session?.dismiss === undefined) return;
    try {
      session.dismiss();
    } catch (cause: unknown) {
      deps.reportError({ stage: "verify", message: "dismiss callback threw", cause });
    }
  };
  if (state.inFlightTriggers.has(triggerKey)) {
    deps.emitEvent({
      kind: "synthesis.skipped",
      signalId: signal.id,
      message: `synthesis already in flight for trigger ${triggerKey}`,
    });
    safeDismiss();
    return null;
  }
  if (state.completedTriggers.has(triggerKey)) {
    deps.emitEvent({
      kind: "synthesis.skipped",
      signalId: signal.id,
      message: `trigger ${triggerKey} already processed this session`,
    });
    safeDismiss();
    return null;
  }
  if (state.count >= deps.maxSynthesesPerSession) {
    deps.emitEvent({
      kind: "synthesis.skipped",
      signalId: signal.id,
      message: "session synthesis cap reached",
    });
    // Do not dismiss — capacity refunds on transient outcomes (R5 round 14).
    return null;
  }
  state.inFlightTriggers.add(triggerKey);
  state.count += 1;
  deps.emitEvent({ kind: "synthesis.started", signalId: signal.id });
  try {
    const outcome = await runPipeline(
      {
        config: deps.config,
        emitEvent: deps.emitEvent,
        reportError: deps.reportError,
        policyCacheHandle: deps.policyCacheHandle,
        formatGeneratePrompt,
      },
      signal,
      session,
    );
    if (outcome.kind !== "transient") {
      safeDismiss();
      state.completedTriggers.add(triggerKey);
    } else {
      state.count = Math.max(0, state.count - 1);
    }
    return outcome.artifact;
  } finally {
    state.inFlightTriggers.delete(triggerKey);
  }
}

export function createAutoHarnessStack(config: AutoHarnessConfig): AutoHarnessStack {
  const wrappedVerifier = validateConfigAndWrapVerifier(config);
  const policyCacheHandle = createPolicyCacheMiddleware({
    notifier: config.notifier,
    ...(wrappedVerifier !== undefined && { verifier: wrappedVerifier }),
  });
  const maxSynthesesPerSession = resolveMaxSynthesesPerSession(config.maxSynthesesPerSession);
  const sessionState = createSessionStateMap();
  // Subscribe to store-change events to invalidate completedTriggers — without
  // this, post-completion replay-suppression persists across artifact
  // updates/removals/quarantines and operators can't recover from a bad
  // deployment without resetting the entire session (R5 round 18). The
  // subscription is captured so `dispose()` can release it (R5 round 20).
  const completedTriggersUnsubscribe = config.notifier?.subscribe(() => {
    for (const s of sessionState.values()) s.completedTriggers.clear();
  });
  const emitEvent = (event: AutoHarnessEvent): void => config.onEvent?.(event);
  const reportError = (error: AutoHarnessError): void => config.onError?.(error);
  const deps: SynthesizeDeps = {
    config,
    emitEvent,
    reportError,
    policyCacheHandle,
    sessionState,
    maxSynthesesPerSession,
  };
  return {
    policyCacheMiddleware: policyCacheHandle.middleware,
    policyCacheHandle,
    synthesizeHarness: (signal, session) => synthesizeOne(deps, signal, session),
    resetSession: (sessionId?: string) => {
      if (sessionId === undefined) sessionState.clear();
      else sessionState.delete(sessionId);
      emitEvent({ kind: "session.reset", message: "session synthesis state cleared" });
    },
    dispose: () => {
      // Releases the completedTriggers subscription only;
      // policyCacheHandle.dispose() is separate (caller invokes both).
      completedTriggersUnsubscribe?.();
      sessionState.clear();
    },
    maxSynthesesPerSession,
  };
}
