import type { ChannelAdapter, ContentBlock, JsonObject, OutboundMessage } from "@koi/core";
import type { InboxEnvelope, InboxSink } from "./inbox-sink.js";

export type DeliveryPriority = "low" | "normal" | "high" | "urgent";

export interface ProactiveNotification {
  readonly priority: DeliveryPriority;
  readonly content: readonly ContentBlock[];
  readonly threadId?: string;
  readonly metadata?: JsonObject;
  /**
   * Caller-supplied dedupe key for safe retry after a `timed_out` result.
   * Forwarded into `OutboundMessage.metadata.idempotencyKey` (and into the
   * `InboxEnvelope` metadata) so adapters / sinks that honor it can drop
   * duplicates when the original send completes after the timeout. Without a
   * key, callers must treat `timed_out` as ambiguous (delivery state unknown)
   * and decide policy themselves; with a key, retrying on `timed_out` is
   * dedupe-safe end-to-end as long as every adapter in scope honors the key.
   */
  readonly idempotencyKey?: string;
}

export interface DeliveryPreferences {
  readonly preferredChannel?: string;
  readonly maxNotificationsPerHour?: number;
  readonly quietHoursStart?: number;
  readonly quietHoursEnd?: number;
  readonly timezone?: string;
}

export interface ProactiveDeliveryConfig {
  readonly channels: ReadonlyMap<string, ChannelAdapter>;
  readonly preferences?: DeliveryPreferences;
  readonly now?: () => number;
  readonly inbox?: InboxSink;
  /**
   * Per-attempt timeout in milliseconds. When set, each adapter `send()`
   * (and each `inbox.enqueue()`) is wrapped in a timeout — a hung
   * dependency cannot block urgent fan-out from returning after siblings
   * settle, cannot wedge high-priority fallback past the failed attempt,
   * and cannot strand a reserved rate-limit slot. Default: no timeout
   * (preserves Phase 3 behavior). Recommended in production where
   * adapters do remote I/O.
   */
  readonly sendTimeoutMs?: number;
}

export type DeliveryFailure = { readonly channel: string; readonly error: string };

export type DeliveryResult =
  | {
      readonly ok: true;
      readonly delivered: readonly string[];
      /**
       * Per-channel failures/timeouts that occurred ALONGSIDE successful
       * deliveries — only populated by `urgent` fan-out today. Lets callers
       * reconcile (e.g. retry the timed-out subset with the same
       * idempotencyKey, alert on partial failure) instead of seeing a clean
       * success that masked silent loss. Empty / undefined when every
       * channel succeeded.
       */
      readonly partialFailures?: readonly DeliveryFailure[];
    }
  | {
      readonly ok: false;
      readonly reason: "no_channels" | "rate_limited" | "all_failed" | "quiet_hours" | "timed_out";
      readonly failures?: readonly DeliveryFailure[];
    };

export interface ProactiveDelivery {
  readonly send: (notification: ProactiveNotification) => Promise<DeliveryResult>;
}

/**
 * Result of attempting to clone an outbound message. Cloning can fail because
 * `ContentBlock.button.payload` and `ContentBlock.custom.data` are typed as
 * `unknown` and `OutboundMessage.metadata` is `JsonObject` (also `unknown`
 * values), so callers can legally pass values structuredClone rejects
 * (functions, class instances, Errors, etc.). We surface that failure as a
 * `DeliveryFailure` rather than throwing — the caller's send must complete
 * with a wrapped result so reserved rate-limit slots can be refunded.
 */
type BuildOutboundResult =
  | { readonly ok: true; readonly msg: OutboundMessage }
  | { readonly ok: false; readonly error: string };

function buildOutbound(notification: ProactiveNotification): BuildOutboundResult {
  try {
    const content = structuredClone(notification.content);
    const baseMeta =
      notification.metadata !== undefined ? structuredClone(notification.metadata) : undefined;
    // Merge idempotencyKey into metadata so adapters that honor it for dedupe
    // can see it in a single, conventional location.
    const metadata: JsonObject | undefined =
      notification.idempotencyKey !== undefined
        ? { ...(baseMeta ?? {}), idempotencyKey: notification.idempotencyKey }
        : baseMeta;
    const msg: OutboundMessage = {
      content,
      ...(notification.threadId !== undefined ? { threadId: notification.threadId } : {}),
      ...(metadata !== undefined ? { metadata } : {}),
    };
    return { ok: true, msg };
  } catch (e: unknown) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "notification content not cloneable",
    };
  }
}

function selectPreferred(
  channels: ReadonlyMap<string, ChannelAdapter>,
  preferredName: string | undefined,
): { name: string; adapter: ChannelAdapter } | undefined {
  if (preferredName !== undefined) {
    const adapter = channels.get(preferredName);
    if (adapter !== undefined) return { name: preferredName, adapter };
  }
  // First by Map insertion order.
  const first = channels.entries().next();
  if (first.done === true) return undefined;
  const [name, adapter] = first.value;
  return { name, adapter };
}

function selectHighOrder(
  channels: ReadonlyMap<string, ChannelAdapter>,
  preferredName: string | undefined,
): readonly { name: string; adapter: ChannelAdapter }[] {
  const out: { name: string; adapter: ChannelAdapter }[] = [];
  if (preferredName !== undefined) {
    const adapter = channels.get(preferredName);
    if (adapter !== undefined) {
      out.push({ name: preferredName, adapter });
    }
  }
  for (const [name, adapter] of channels) {
    if (name === preferredName) continue;
    out.push({ name, adapter });
  }
  return out;
}

/**
 * Sentinel error class so timeout detection is reliable across the layered
 * try/catch boundaries (reading `error.message` for "timed out" would be
 * brittle and adapter-defined error messages might collide).
 */
class SendTimeoutError extends Error {}

async function withTimeout<T>(
  p: Promise<T>,
  timeoutMs: number | undefined,
  label: string,
): Promise<T> {
  if (timeoutMs === undefined) return p;
  let handle: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<T>((_, reject) => {
        handle = setTimeout(
          () => reject(new SendTimeoutError(`${label} timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    // Clear the timer so successful sends don't leave a live handle pending
    // for the full timeout window — keeps the event loop quiescent under
    // bursty traffic.
    if (handle !== undefined) clearTimeout(handle);
  }
}

type SendOutcome =
  | { readonly kind: "ok" }
  | { readonly kind: "error"; readonly failure: DeliveryFailure }
  | { readonly kind: "timeout"; readonly failure: DeliveryFailure };

async function sendOne(
  channel: { name: string; adapter: ChannelAdapter },
  msg: OutboundMessage,
  timeoutMs: number | undefined,
): Promise<SendOutcome> {
  try {
    await withTimeout(Promise.resolve(channel.adapter.send(msg)), timeoutMs, "channel.send");
    return { kind: "ok" };
  } catch (e: unknown) {
    const failure: DeliveryFailure = {
      channel: channel.name,
      error: e instanceof Error ? e.message : "channel.send failed",
    };
    if (e instanceof SendTimeoutError) {
      return { kind: "timeout", failure };
    }
    return { kind: "error", failure };
  }
}

function validateRateLimit(prefs: DeliveryPreferences | undefined): void {
  if (prefs === undefined) return;
  const cap = prefs.maxNotificationsPerHour;
  if (cap === undefined) return;
  if (typeof cap !== "number" || !Number.isFinite(cap) || !Number.isInteger(cap) || cap < 0) {
    throw new Error(
      `maxNotificationsPerHour must be a finite non-negative integer (got ${String(cap)})`,
    );
  }
}

function validateQuietHours(prefs: DeliveryPreferences | undefined): void {
  if (prefs === undefined) return;
  const { quietHoursStart: s, quietHoursEnd: e, timezone } = prefs;
  const sSet = s !== undefined;
  const eSet = e !== undefined;
  if (sSet !== eSet) {
    throw new Error("quietHoursStart and quietHoursEnd must both be set or both omitted");
  }
  if (sSet && eSet) {
    if (!Number.isInteger(s) || !Number.isInteger(e) || s < 0 || s > 23 || e < 0 || e > 23) {
      throw new Error("quietHoursStart and quietHoursEnd must be integers in [0, 23]");
    }
    if (s === e) {
      throw new Error("quietHoursStart must not equal quietHoursEnd");
    }
  }
  // Only validate timezone when quiet-hours are actually enabled. Hosts often
  // reuse a broader user-preferences object (with a stale or invalid tz) for
  // delivery wiring; rejecting it here would disable urgent/high paths that
  // never consult quiet hours.
  if (sSet && eSet && timezone !== undefined) {
    try {
      new Intl.DateTimeFormat("en-US", {
        timeZone: timezone,
        hour: "2-digit",
        hourCycle: "h23",
      }).format(new Date(0));
    } catch (cause: unknown) {
      throw new Error(`invalid timezone: ${timezone}`, { cause });
    }
  }
}

export function createProactiveDelivery(config: ProactiveDeliveryConfig): ProactiveDelivery {
  validateRateLimit(config.preferences);
  validateQuietHours(config.preferences);
  if (
    config.sendTimeoutMs !== undefined &&
    (!Number.isFinite(config.sendTimeoutMs) ||
      !Number.isInteger(config.sendTimeoutMs) ||
      config.sendTimeoutMs <= 0)
  ) {
    throw new Error(
      `sendTimeoutMs must be a finite positive integer (got ${String(config.sendTimeoutMs)})`,
    );
  }
  const sendTimeoutMs = config.sendTimeoutMs;
  const preferences = config.preferences;
  const now = config.now ?? Date.now;
  const cap = preferences?.maxNotificationsPerHour;
  const WINDOW_MS = 3_600_000;
  // Rate-limit reservations carry both a wall-clock timestamp (for window
  // pruning) and a monotonic id (for token-based refund). Storing just
  // timestamps was unsafe once timeouts existed: two concurrent sends in
  // the same millisecond reserve identical `t` values, one times out
  // (slot must stay consumed — delivery may still succeed), and the
  // other hard-fails. A by-timestamp refund could remove the wrong
  // reservation, reopening capacity early under fail-closed conditions.
  interface RateLimitReservation {
    readonly id: number;
    readonly t: number;
  }
  const window: RateLimitReservation[] = [];
  let nextReservationId = 0;

  const quietStart = preferences?.quietHoursStart;
  const quietEnd = preferences?.quietHoursEnd;
  const tz = preferences?.timezone ?? "UTC";
  const hourFormatter =
    quietStart !== undefined && quietEnd !== undefined
      ? new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "2-digit", hourCycle: "h23" })
      : undefined;

  function isQuietNow(t: number): boolean {
    if (hourFormatter === undefined || quietStart === undefined || quietEnd === undefined) {
      return false;
    }
    const hourStr = hourFormatter.format(new Date(t));
    const h = Number.parseInt(hourStr, 10);
    if (Number.isNaN(h)) return false;
    return quietStart < quietEnd
      ? h >= quietStart && h < quietEnd
      : h >= quietStart || h < quietEnd;
  }

  function pruneWindow(t: number): void {
    while (window.length > 0) {
      const head = window[0];
      if (head === undefined || head.t > t - WINDOW_MS) break;
      window.shift();
    }
  }

  // Sentinel for "no reservation taken" (urgent priority or rate-limit
  // disabled). Refund is a no-op for this value.
  const NO_RESERVATION = -1;

  function reserveSlot(t: number, priority: DeliveryPriority): number {
    if (priority === "urgent") return NO_RESERVATION;
    if (cap === undefined) return NO_RESERVATION;
    pruneWindow(t);
    if (window.length >= cap) return NO_RESERVATION;
    // Reserve synchronously so concurrent same-instant sends cannot both pass.
    const id = nextReservationId++;
    window.push({ id, t });
    return id;
  }

  function refundSlot(reservationId: number): void {
    if (reservationId === NO_RESERVATION) return;
    // Remove by id, not by timestamp — two concurrent sends in the same
    // millisecond carry distinct ids, so a hard-failure refund cannot
    // accidentally delete a sibling timed-out reservation that must stay
    // consumed (its delivery may still succeed).
    for (let i = 0; i < window.length; i++) {
      const entry = window[i];
      if (entry !== undefined && entry.id === reservationId) {
        window.splice(i, 1);
        return;
      }
    }
  }

  const inbox = config.inbox;

  return {
    send: async (notification) => {
      const t = now();
      if (notification.priority === "low" && inbox !== undefined) {
        // Deep-clone payload — sinks that retain envelopes (queue, scratchpad,
        // persistent store) must not see later caller mutations, and a sink
        // that mutates the envelope must not corrupt the caller's original
        // notification. Same boundary discipline as channel sends.
        let envelope: InboxEnvelope;
        try {
          const baseMeta =
            notification.metadata !== undefined
              ? structuredClone(notification.metadata)
              : undefined;
          const metadata: JsonObject | undefined =
            notification.idempotencyKey !== undefined
              ? { ...(baseMeta ?? {}), idempotencyKey: notification.idempotencyKey }
              : baseMeta;
          envelope = {
            content: structuredClone(notification.content),
            ...(notification.threadId !== undefined ? { threadId: notification.threadId } : {}),
            ...(metadata !== undefined ? { metadata } : {}),
            enqueuedAt: t,
          };
        } catch (e: unknown) {
          return {
            ok: false,
            reason: "all_failed",
            failures: [
              {
                channel: "inbox",
                error: e instanceof Error ? e.message : "notification content not cloneable",
              },
            ],
          };
        }
        try {
          await withTimeout(
            Promise.resolve(inbox.enqueue(envelope)),
            sendTimeoutMs,
            "inbox.enqueue",
          );
          return { ok: true, delivered: ["inbox"] };
        } catch (e: unknown) {
          const failure: DeliveryFailure = {
            channel: "inbox",
            error: e instanceof Error ? e.message : "inbox.enqueue failed",
          };
          // Inbox timeout: enqueue may complete after we return; surface as
          // timed_out so callers can dedupe rather than blindly retry.
          if (e instanceof SendTimeoutError) {
            return { ok: false, reason: "timed_out", failures: [failure] };
          }
          return { ok: false, reason: "all_failed", failures: [failure] };
        }
      }
      if (config.channels.size === 0) {
        return { ok: false, reason: "no_channels" };
      }
      if (notification.priority === "urgent") {
        // Urgent is its own path — fan-out, never gated by rate limit, never
        // consumes window capacity.
        const entries = Array.from(config.channels.entries(), ([name, adapter]) => ({
          name,
          adapter,
        }));
        // Per-adapter cloned message so a misbehaving adapter that mutates
        // its input cannot race against parallel sends to other channels.
        // If cloning fails for any adapter, that adapter gets an all_failed
        // entry — a single bad payload does not crash the whole send.
        const results: SendOutcome[] = await Promise.all(
          entries.map(async (c) => {
            const built = buildOutbound(notification);
            if (!built.ok) {
              const f: SendOutcome = {
                kind: "error",
                failure: { channel: c.name, error: built.error },
              };
              return f;
            }
            return sendOne(c, built.msg, sendTimeoutMs);
          }),
        );
        const delivered: string[] = [];
        const failures: DeliveryFailure[] = [];
        let timeoutCount = 0;
        for (let i = 0; i < entries.length; i++) {
          const entry = entries[i];
          const outcome = results[i];
          if (entry === undefined || outcome === undefined) continue;
          if (outcome.kind === "ok") {
            delivered.push(entry.name);
          } else {
            failures.push(outcome.failure);
            if (outcome.kind === "timeout") timeoutCount += 1;
          }
        }
        if (delivered.length === 0) {
          // If every failure was a timeout, surface "timed_out" so callers can
          // distinguish "we don't know whether it delivered" from "it
          // definitely failed". Mixed outcomes still report all_failed.
          if (timeoutCount === failures.length && timeoutCount > 0) {
            return { ok: false, reason: "timed_out", failures };
          }
          return { ok: false, reason: "all_failed", failures };
        }
        // Some channels delivered — preserve partial-failure visibility so
        // callers can reconcile (retry timed-out subset, alert on hard
        // failures) instead of seeing clean success that masked silent loss.
        if (failures.length > 0) {
          return { ok: true, delivered, partialFailures: failures };
        }
        return { ok: true, delivered };
      }
      if (notification.priority === "normal" && isQuietNow(t)) {
        return { ok: false, reason: "quiet_hours" };
      }
      if (notification.priority === "high") {
        const highReservation = reserveSlot(t, notification.priority);
        if (highReservation === NO_RESERVATION && cap !== undefined) {
          return { ok: false, reason: "rate_limited" };
        }
        const order = selectHighOrder(config.channels, preferences?.preferredChannel);
        if (order.length === 0) {
          refundSlot(highReservation);
          return { ok: false, reason: "no_channels" };
        }
        const failures: DeliveryFailure[] = [];
        for (const target of order) {
          // Per-attempt cloned message so an adapter that mutates its input
          // cannot poison subsequent fallback attempts. Clone failure on a
          // given attempt is recorded as a per-channel failure; we still try
          // remaining channels in case one of them mutates differently.
          const built = buildOutbound(notification);
          if (!built.ok) {
            failures.push({ channel: target.name, error: built.error });
            continue;
          }
          const outcome = await sendOne(target, built.msg, sendTimeoutMs);
          if (outcome.kind === "ok") {
            // Surface accumulated failures from earlier fallback attempts
            // as partialFailures so operators can see preferred-channel
            // degradation even when a secondary delivered. Matches the
            // urgent-path partial-success contract.
            if (failures.length > 0) {
              return { ok: true, delivered: [target.name], partialFailures: failures };
            }
            return { ok: true, delivered: [target.name] };
          }
          failures.push(outcome.failure);
          if (outcome.kind === "timeout") {
            // Timeout is always terminal for high fallback. Adapter
            // contract has no abort signal, and no idempotency field —
            // the `idempotencyKey` we forward into message metadata is
            // best-effort metadata-only (see docs/L2/proactive.md). The
            // original send may still complete in the background, and
            // falling back to a different transport (or even the same
            // transport with the same key) is NOT dedupe-safe at the
            // contract level. Stop the walk and report ambiguous state.
            // Slot stays consumed: we may have delivered.
            return { ok: false, reason: "timed_out", failures };
          }
        }
        refundSlot(highReservation);
        return { ok: false, reason: "all_failed", failures };
      }
      const normalReservation = reserveSlot(t, notification.priority);
      if (normalReservation === NO_RESERVATION && cap !== undefined) {
        return { ok: false, reason: "rate_limited" };
      }
      const target = selectPreferred(config.channels, preferences?.preferredChannel);
      if (target === undefined) {
        refundSlot(normalReservation);
        return { ok: false, reason: "no_channels" };
      }
      const built = buildOutbound(notification);
      if (!built.ok) {
        refundSlot(normalReservation);
        return {
          ok: false,
          reason: "all_failed",
          failures: [{ channel: target.name, error: built.error }],
        };
      }
      const outcome = await sendOne(target, built.msg, sendTimeoutMs);
      if (outcome.kind !== "ok") {
        // Same rationale as high fallback: timeout = "may have delivered",
        // do not refund the slot. Hard failure = refund.
        if (outcome.kind === "timeout") {
          return { ok: false, reason: "timed_out", failures: [outcome.failure] };
        }
        refundSlot(normalReservation);
        return { ok: false, reason: "all_failed", failures: [outcome.failure] };
      }
      return { ok: true, delivered: [target.name] };
    },
  };
}
