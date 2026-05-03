/**
 * memory.store / memory.recall plumbing for @koi/middleware-user-model.
 * Handles bounded-retry persistence, drain-with-timeout for prior-turn
 * stores, salience gating, and recall-with-fallback.
 */

import type { MemoryResult, UserSignal } from "@koi/core";
import { ingestInternal, namespaceForSession, type SessionState } from "./session-state.js";
import type { ResolvedUserModelConfig } from "./types.js";

const STORE_RETRY_DELAY_MS = 25;

export async function ingestPersistedSignal(
  cfg: ResolvedUserModelConfig,
  state: SessionState,
  correction: string,
  source: "explicit" | "drift",
): Promise<boolean> {
  const salient = await isSalient(cfg, correction);
  if (!salient) return false;
  const sig = { kind: "post_action", correction, source } as const satisfies UserSignal;
  ingestInternal(state, sig);
  state.pendingPostAction = sig;
  // Persist with the underlying `memory.store()` promise tracked on
  // `state.pendingStores` so that the next turn's `drainPendingStores`
  // observes its real backend completion — NOT a timeout-wrapper that
  // resolves while the write is still in flight (review round 9, finding 1).
  //
  // We deliberately do NOT pass `supersedes`: we cannot safely identify
  // which prior recalled record (if any) the user is replacing — the L0
  // `MemoryResult` contract does not expose stable record IDs to L2, and
  // a blanket "supersede everything" mark would discard unrelated memories
  // (review round 7).
  if (!state.scopeReady) {
    // Caller has no subject scope and did not opt into shared scope —
    // refusing to persist is the safe choice (review round 12, finding 3).
    return false;
  }
  const storeOpts = {
    namespace: namespaceForSession(cfg, state),
    category: cfg.preferenceCategory,
  };
  // Bounded retry: try once, on failure retry once with a small backoff.
  // If both attempts fail, the write is treated as terminally failed —
  // the overlay is retired (with a final onError so callers can see the
  // drop) so a single backend hiccup cannot pin stale or contradictory
  // corrections in [User Context] for the rest of the session
  // (review round 15, finding 1).
  state.unresolvedCorrections.add(correction);
  const underlying = (async (): Promise<"landed" | "failed"> => {
    try {
      await cfg.memory.store(correction, storeOpts);
      return "landed";
    } catch (firstErr: unknown) {
      cfg.onError(firstErr);
      await new Promise((r) => setTimeout(r, STORE_RETRY_DELAY_MS));
      try {
        await cfg.memory.store(correction, storeOpts);
        return "landed";
      } catch (secondErr: unknown) {
        cfg.onError(
          new Error(
            `memory.store failed twice — retiring correction overlay to prevent stale pin`,
            { cause: secondErr },
          ),
        );
        return "failed";
      }
    }
  })();
  const tracked: Promise<void> = underlying.then(
    () => {
      // Always retire the overlay on terminal outcome — success means
      // recall will surface it; failure means we accept the loss rather
      // than poison later snapshots forever.
      state.unresolvedCorrections.delete(correction);
    },
    () => {
      state.unresolvedCorrections.delete(correction);
    },
  );
  const finalized = tracked.finally(() => {
    state.pendingStores.delete(finalized);
  });
  state.pendingStores.add(finalized);
  return true;
}

export async function drainPendingStores(
  state: SessionState,
  timeoutMs: number,
  onError: (error: unknown) => void,
): Promise<void> {
  if (state.pendingStores.size === 0) return;
  const pending = [...state.pendingStores];
  const timer = new Promise<"timeout">((resolve) => {
    setTimeout(() => resolve("timeout"), timeoutMs);
  });
  const drained = Promise.allSettled(pending).then(() => "drained" as const);
  const winner = await Promise.race([drained, timer]);
  if (winner === "timeout") {
    // Retire whichever entries are still in `pendingStores` so a hung
    // backend can't keep imposing per-turn drain latency forever (review
    // round 10, finding 2). The underlying writes still run; on actual
    // settle their .finally also calls .delete(), but the call is
    // idempotent. The corresponding `unresolvedCorrections` entries stay
    // until the underlying truly settles, so prompt visibility is
    // preserved (review round 10, finding 1).
    let abandoned = 0;
    for (const p of pending) {
      if (state.pendingStores.delete(p)) abandoned++;
    }
    if (abandoned > 0) {
      onError(
        new Error(
          `memory.store drain timed out after ${String(timeoutMs)}ms — abandoned ${String(abandoned)} write(s); future turns will not re-wait on them`,
        ),
      );
    }
  }
}

export async function isSalient(cfg: ResolvedUserModelConfig, text: string): Promise<boolean> {
  if (cfg.salienceGate === undefined) return true;
  try {
    return await cfg.salienceGate.isSalient(text);
  } catch (e: unknown) {
    cfg.onError(e);
    return true;
  }
}

export async function recallPreferences(
  cfg: ResolvedUserModelConfig,
  state: SessionState,
): Promise<readonly MemoryResult[]> {
  if (!state.scopeReady) return [];
  // Bound recall against the same persistence-timeout knob so a stuck
  // backend cannot stall every turn before the model call (review round
  // 13, finding 2). On timeout, fall back to the last known good recall
  // result if any — otherwise an empty list — so the model can still run.
  const recallPromise = cfg.memory.recall("user preferences", {
    namespace: namespaceForSession(cfg, state),
    limit: cfg.recallLimit,
  });
  const timeoutMs = cfg.persistenceTimeoutMs;
  const timer = new Promise<"timeout">((resolve) => {
    setTimeout(() => resolve("timeout"), timeoutMs);
  });
  const winner = await Promise.race([recallPromise, timer]);
  if (winner === "timeout") {
    cfg.onError(
      new Error(
        `memory.recall timed out after ${String(timeoutMs)}ms — falling back to last known recall`,
      ),
    );
    return state.lastRecalledPreferences;
  }
  return winner.filter((r) => (r.score ?? 1) >= cfg.relevanceThreshold);
}
