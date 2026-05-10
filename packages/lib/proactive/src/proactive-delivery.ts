import type { ChannelAdapter, ContentBlock, JsonObject, OutboundMessage } from "@koi/core";

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
  return {
    content: notification.content,
    ...(notification.threadId !== undefined ? { threadId: notification.threadId } : {}),
    ...(notification.metadata !== undefined ? { metadata: notification.metadata } : {}),
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
  validateQuietHours(config.preferences);
  const preferences = config.preferences;
  const now = config.now ?? Date.now;
  const cap = preferences?.maxNotificationsPerHour;
  const WINDOW_MS = 3_600_000;
  // let: window mutates on every successful non-urgent send and on every gate
  // check (slides out entries older than now() - WINDOW_MS).
  const window: number[] = [];

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

  return {
    send: async (notification) => {
      if (config.channels.size === 0) {
        return { ok: false, reason: "no_channels" };
      }
      const t = now();
      if (notification.priority === "urgent") {
        // Urgent is its own path — fan-out, never gated by rate limit, never
        // consumes window capacity.
        const msg = buildOutbound(notification);
        const entries = Array.from(config.channels.entries(), ([name, adapter]) => ({
          name,
          adapter,
        }));
        const results = await Promise.all(entries.map((c) => sendOne(c, msg)));
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
