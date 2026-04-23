/**
 * Channel wiring for bridge auth notifications.
 *
 * Converts BridgeNotification events from transport.subscribe() into
 * structured OAuthChannel callbacks (auth_required, auth_complete) and
 * channel text messages (auth_progress keepalives).
 *
 * Usage:
 *   const transport = await createLocalTransport({ mountUri: "gdrive://my-drive" });
 *   const handler = createAuthNotificationHandler(oauthChannel, channel);
 *   const unsubscribe = transport.subscribe(handler);
 *   // on teardown:
 *   unsubscribe();
 *   handler.dispose();            // cancel pending timers + drop late callbacks
 */

import type { ChannelAdapter, OAuthChannel } from "@koi/core";
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
 * close. Idempotent.
 */
export type AuthNotificationHandler = ((n: BridgeNotification) => void) & {
  readonly dispose: () => void;
};

/**
 * Creates a BridgeNotification handler that routes auth lifecycle events to an
 * OAuthChannel (auth_required, auth_complete) and sends progress keepalives to
 * a channel (auth_progress).
 *
 * Wire the returned function to `transport.subscribe()` and call
 * `.dispose()` on the returned handler when the transport is closed so that
 * pending watchdog timers and late `.then/.catch` callbacks don't outlive
 * the session (notifications dispatched before `unsubscribe()` can still
 * execute the handler via queued microtasks).
 *
 * The handler is non-blocking — all async calls are fire-and-forget.
 * Errors from oauthChannel callbacks and channel.send() are swallowed to
 * avoid breaking the reader loop.
 */
export function createAuthNotificationHandler(
  oauthChannel: OAuthChannel,
  channel: ChannelAdapter,
): AuthNotificationHandler {
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
  // let: monotonically incremented per send attempt; cannot be const
  let attemptCounter = 0;
  // let: toggled to false on dispose; cannot be const
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
      void Promise.resolve(
        oauthChannel.onAuthRequired({
          provider,
          authUrl: auth_url,
          message,
          mode,
          instructions,
        }),
      ).catch((err: unknown) => {
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
      void Promise.resolve(oauthChannel.onAuthComplete({ provider })).catch((_err: unknown) => {
        // auth_complete delivery failure is non-blocking — auth is already done.
        // eslint-disable-next-line no-console
        console.warn(
          `[koi/fs-nexus] auth_complete delivery failed for ${provider}: ${String(_err)}`,
        );
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
