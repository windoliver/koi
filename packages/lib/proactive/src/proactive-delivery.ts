import type { ChannelAdapter, ContentBlock, JsonObject, OutboundMessage } from "@koi/core";
import type { InboxEnvelope, InboxSink } from "./inbox-sink.js";

export type DeliveryPriority = "low" | "normal" | "high" | "urgent";

export interface ProactiveNotification {
  readonly priority: DeliveryPriority;
  readonly content: readonly ContentBlock[];
  readonly threadId?: string;
  readonly metadata?: JsonObject;
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
}

export type DeliveryFailure = { readonly channel: string; readonly error: string };

export type DeliveryResult =
  | { readonly ok: true; readonly delivered: readonly string[] }
  | {
      readonly ok: false;
      readonly reason: "no_channels" | "rate_limited" | "all_failed" | "quiet_hours";
      readonly failures?: readonly DeliveryFailure[];
    };

export interface ProactiveDelivery {
  readonly send: (notification: ProactiveNotification) => Promise<DeliveryResult>;
}

function buildOutbound(notification: ProactiveNotification): OutboundMessage {
  // Deep-clone content + metadata so a misbehaving adapter that mutates its
  // input cannot poison the caller's notification, sibling parallel sends
  // (urgent fan-out), or subsequent fallback attempts (high priority).
  // structuredClone preserves structural type; covariance allows assigning a
  // mutable clone to the readonly field.
  return {
    content: structuredClone(notification.content),
    ...(notification.threadId !== undefined ? { threadId: notification.threadId } : {}),
    ...(notification.metadata !== undefined
      ? { metadata: structuredClone(notification.metadata) }
      : {}),
  };
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

async function sendOne(
  channel: { name: string; adapter: ChannelAdapter },
  msg: OutboundMessage,
): Promise<DeliveryFailure | undefined> {
  try {
    await channel.adapter.send(msg);
    return undefined;
  } catch (e: unknown) {
    return {
      channel: channel.name,
      error: e instanceof Error ? e.message : "channel.send failed",
    };
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
  if (timezone !== undefined) {
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
  const preferences = config.preferences;
  const now = config.now ?? Date.now;
  const cap = preferences?.maxNotificationsPerHour;
  const WINDOW_MS = 3_600_000;
  // let: window mutates on every successful non-urgent send and on every gate
  // check (slides out entries older than now() - WINDOW_MS).
  const window: number[] = [];

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
      if (head === undefined || head > t - WINDOW_MS) break;
      window.shift();
    }
  }

  function reserveSlot(t: number, priority: DeliveryPriority): boolean {
    if (priority === "urgent") return true;
    if (cap === undefined) return true;
    pruneWindow(t);
    if (window.length >= cap) return false;
    // Reserve synchronously so concurrent same-instant sends cannot both pass.
    window.push(t);
    return true;
  }

  function refundSlot(t: number, priority: DeliveryPriority): void {
    if (priority === "urgent" || cap === undefined) return;
    // Remove the most-recent matching entry — undoes a failed delivery so it
    // does not consume capacity.
    for (let i = window.length - 1; i >= 0; i--) {
      if (window[i] === t) {
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
        const envelope: InboxEnvelope = {
          content: notification.content,
          ...(notification.threadId !== undefined ? { threadId: notification.threadId } : {}),
          ...(notification.metadata !== undefined ? { metadata: notification.metadata } : {}),
          enqueuedAt: t,
        };
        try {
          await inbox.enqueue(envelope);
          return { ok: true, delivered: ["inbox"] };
        } catch (e: unknown) {
          return {
            ok: false,
            reason: "all_failed",
            failures: [
              {
                channel: "inbox",
                error: e instanceof Error ? e.message : "inbox.enqueue failed",
              },
            ],
          };
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
        const results = await Promise.all(
          entries.map((c) => sendOne(c, buildOutbound(notification))),
        );
        const delivered: string[] = [];
        const failures: DeliveryFailure[] = [];
        for (let i = 0; i < entries.length; i++) {
          const entry = entries[i];
          const failure = results[i];
          if (entry === undefined) continue;
          if (failure === undefined) {
            delivered.push(entry.name);
          } else {
            failures.push(failure);
          }
        }
        if (delivered.length === 0) {
          return { ok: false, reason: "all_failed", failures };
        }
        return { ok: true, delivered };
      }
      if (notification.priority === "normal" && isQuietNow(t)) {
        return { ok: false, reason: "quiet_hours" };
      }
      if (notification.priority === "high") {
        if (!reserveSlot(t, notification.priority)) {
          return { ok: false, reason: "rate_limited" };
        }
        const order = selectHighOrder(config.channels, preferences?.preferredChannel);
        if (order.length === 0) {
          refundSlot(t, notification.priority);
          return { ok: false, reason: "no_channels" };
        }
        const failures: DeliveryFailure[] = [];
        for (const target of order) {
          // Per-attempt cloned message so an adapter that mutates its input
          // cannot poison subsequent fallback attempts.
          const failure = await sendOne(target, buildOutbound(notification));
          if (failure === undefined) {
            return { ok: true, delivered: [target.name] };
          }
          failures.push(failure);
        }
        refundSlot(t, notification.priority);
        return { ok: false, reason: "all_failed", failures };
      }
      if (!reserveSlot(t, notification.priority)) {
        return { ok: false, reason: "rate_limited" };
      }
      const target = selectPreferred(config.channels, preferences?.preferredChannel);
      if (target === undefined) {
        refundSlot(t, notification.priority);
        return { ok: false, reason: "no_channels" };
      }
      const msg = buildOutbound(notification);
      const failure = await sendOne(target, msg);
      if (failure !== undefined) {
        refundSlot(t, notification.priority);
        return { ok: false, reason: "all_failed", failures: [failure] };
      }
      return { ok: true, delivered: [target.name] };
    },
  };
}
