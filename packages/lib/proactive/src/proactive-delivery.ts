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
      readonly reason: "no_channels" | "rate_limited" | "all_failed";
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

export function createProactiveDelivery(config: ProactiveDeliveryConfig): ProactiveDelivery {
  const preferences = config.preferences;
  return {
    send: async (notification) => {
      if (config.channels.size === 0) {
        return { ok: false, reason: "no_channels" };
      }
      // Urgent fan-out comes in Task 3; for now treat all non-empty cases
      // as single-channel preferred routing.
      const target = selectPreferred(config.channels, preferences?.preferredChannel);
      if (target === undefined) {
        return { ok: false, reason: "no_channels" };
      }
      const msg = buildOutbound(notification);
      const failure = await sendOne(target, msg);
      if (failure !== undefined) {
        return { ok: false, reason: "all_failed", failures: [failure] };
      }
      return { ok: true, delivered: [target.name] };
    },
  };
}
