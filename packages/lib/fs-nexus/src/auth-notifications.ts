/**
 * Channel wiring for bridge auth notifications.
 *
 * Converts BridgeNotification events from transport.subscribe() into
 * user-facing channel messages during inline OAuth flows.
 *
 * Usage:
 *   const transport = await createLocalTransport({ mountUri: "gdrive://my-drive" });
 *   const handler = createAuthNotificationHandler(channel);
 *   const unsubscribe = transport.subscribe(handler);
 *   // on teardown: unsubscribe() auto-calls handler.dispose() so timers are
 *   // cancelled without a separate explicit call.
 *   unsubscribe();
 */

import type { ChannelAdapter } from "@koi/core";
import type { BridgeNotification } from "./types.js";

/** Strip query parameters from an OAuth URL before logging — they carry anti-CSRF state. */
function redactUrl(raw: string): string {
  try {
    const u = new URL(raw);
    return `${u.origin}${u.pathname}`;
  } catch {
    return "[unparseable URL]";
  }
}

/**
 * Handler function returned by `createAuthNotificationHandler`. The function
 * itself is wired to `transport.subscribe()`; `.dispose()` tears down pending
 * timers and gates all queued async callbacks so they become no-ops after
 * close. Idempotent. Called automatically by the unsubscribe function returned
 * from `transport.subscribe()`.
 */
export type AuthNotificationHandler = ((n: BridgeNotification) => void) & {
  readonly dispose: () => void;
};

/**
 * Creates a BridgeNotification handler that sends user-facing messages to a
 * channel when OAuth authorization is required, in progress, or complete.
 *
 * Wire the returned function to `transport.subscribe()`. The unsubscribe
 * function returned by `subscribe()` automatically calls `handler.dispose()`
 * so watchdog timers and late `.then/.catch` callbacks cannot outlive the
 * transport session without any separate caller action.
 *
 * The handler is non-blocking — channel.send() is fire-and-forget via void.
 * Errors from channel.send() are swallowed to avoid breaking the reader loop.
 */
export function createAuthNotificationHandler(channel: ChannelAdapter): AuthNotificationHandler {
  // Per-provider lifecycle state for auth_progress dedup.
  //   idle    — no progress shown in current flow; next heartbeat emits
  //   pending — channel.send() in flight; subsequent heartbeats skip
  //   emitted — send succeeded; subsequent heartbeats skip
  //
  // Epoch advances on every auth_required / auth_complete, so a stale send()
  // resolving after a flow reset cannot retroactively mark the next flow as
  // emitted. AttemptId is a per-send monotonic token so callbacks from an
  // evicted-then-reinserted pending entry (same provider, same epoch) cannot
  // corrupt the newer attempt's state.
  //
  // Map preserves insertion order for FIFO eviction under >= MAX_ENTRIES.
  type ProgressEntry = { state: "pending" | "emitted"; epoch: number; attemptId: number };
  const progressState = new Map<string, ProgressEntry>();
  const providerEpochs = new Map<string, number>();
  // Outstanding watchdogs by attemptId, so dispose() / flow resets can cancel
  // them without letting stale timers fire against a later attempt.
  const watchdogs = new Map<number, ReturnType<typeof setTimeout>>();
  const MAX_ENTRIES = 32;
  // Watchdog bound: if channel.send() never settles, pending clears after this
  // so heartbeats resume. Picked > bridge heartbeat interval (15s, see
  // AUTH_PROGRESS_INTERVAL_S in bridge.py) to avoid racing routine delivery.
  const PENDING_TIMEOUT_MS = 45_000;
  let attemptCounter = 0;
  let active = true;

  const bumpEpoch = (provider: string): number => {
    const next = (providerEpochs.get(provider) ?? 0) + 1;
    providerEpochs.set(provider, next);
    return next;
  };
  const currentEpoch = (provider: string): number => providerEpochs.get(provider) ?? 0;
  const cancelWatchdogsForProvider = (provider: string): void => {
    const entry = progressState.get(provider);
    if (entry === undefined) return;
    const t = watchdogs.get(entry.attemptId);
    if (t !== undefined) {
      clearTimeout(t);
      watchdogs.delete(entry.attemptId);
    }
  };

  const handler = ((n: BridgeNotification): void => {
    if (!active) return;
    if (n.method === "auth_required") {
      cancelWatchdogsForProvider(n.params.provider);
      progressState.delete(n.params.provider);
      bumpEpoch(n.params.provider);
      const { provider, auth_url, message, mode, instructions } = n.params;
      const remoteHint =
        mode === "remote" && instructions !== undefined ? `\n\n_${instructions}_` : "";
      void channel
        .send({
          content: [
            {
              kind: "text",
              text: `**${message}**\n\nOpen this link in your browser to authorize ${provider}:\n${auth_url}${remoteHint}`,
            },
          ],
        })
        .catch((err: unknown) => {
          if (!active) return;
          // auth_required delivery failure means the user never sees the OAuth URL.
          // Log the provider and a redacted URL (origin + path only — no query params,
          // which carry anti-CSRF state and account identifiers).
          // eslint-disable-next-line no-console
          console.error(
            `[koi/fs-nexus] Failed to deliver auth_required for ${provider}: ${String(err)}. ` +
              `User will not see the authorization link (redacted: ${redactUrl(auth_url)})`,
          );
        });
    } else if (n.method === "auth_progress") {
      const { provider, message, elapsed_seconds } = n.params;
      const existing = progressState.get(provider);
      // Skip when a send is in flight or already succeeded for this flow.
      if (existing !== undefined) return;
      // FIFO eviction: Map preserves insertion order, oldest key goes first.
      // Also cancel the evicted entry's watchdog so it can't fire against a
      // later reinserted attempt with the same provider key.
      while (progressState.size >= MAX_ENTRIES) {
        const oldestKey = progressState.keys().next().value;
        if (oldestKey === undefined) break;
        cancelWatchdogsForProvider(oldestKey);
        progressState.delete(oldestKey);
      }
      const flowEpoch = currentEpoch(provider);
      attemptCounter += 1;
      const attemptId = attemptCounter;
      progressState.set(provider, { state: "pending", epoch: flowEpoch, attemptId });
      // Mutations to progressState only fire if the current entry still
      // belongs to this attempt (same epoch AND attemptId). This prevents
      // an evicted-then-reinserted provider's stale callback from clobbering
      // the newer attempt.
      const matchesAttempt = (): boolean => {
        const now = progressState.get(provider);
        return now !== undefined && now.epoch === flowEpoch && now.attemptId === attemptId;
      };
      // Watchdog: if channel.send() never settles (no resolve, no reject),
      // pending otherwise sticks forever. Clear after PENDING_TIMEOUT_MS so
      // heartbeats resume. Harmless if send has already settled — the
      // matchesAttempt gate filters stale timer fires.
      const watchdog = setTimeout(() => {
        watchdogs.delete(attemptId);
        if (!active || !matchesAttempt()) return;
        progressState.delete(provider);
      }, PENDING_TIMEOUT_MS);
      watchdogs.set(attemptId, watchdog);
      void channel
        .send({
          content: [
            {
              kind: "text",
              text: `${message} (${String(elapsed_seconds)}s elapsed)`,
            },
          ],
        })
        .then(() => {
          clearTimeout(watchdog);
          watchdogs.delete(attemptId);
          if (!active || !matchesAttempt()) return;
          progressState.set(provider, { state: "emitted", epoch: flowEpoch, attemptId });
        })
        .catch(() => {
          clearTimeout(watchdog);
          watchdogs.delete(attemptId);
          if (!active || !matchesAttempt()) return;
          progressState.delete(provider);
        });
    } else if (n.method === "auth_complete") {
      cancelWatchdogsForProvider(n.params.provider);
      progressState.delete(n.params.provider);
      bumpEpoch(n.params.provider);
      const { provider } = n.params;
      void channel
        .send({
          content: [
            {
              kind: "text",
              text: `${provider} authorization complete. Continuing...`,
            },
          ],
        })
        .catch(() => {
          // Completion notice — decorative; operation will succeed regardless
        });
    }
  }) as AuthNotificationHandler;

  Object.defineProperty(handler, "dispose", {
    value: (): void => {
      if (!active) return;
      active = false;
      for (const t of watchdogs.values()) clearTimeout(t);
      watchdogs.clear();
      progressState.clear();
      providerEpochs.clear();
    },
    enumerable: false,
    writable: false,
    configurable: false,
  });

  return handler;
}
