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

export function createProactiveDelivery(config: ProactiveDeliveryConfig): ProactiveDelivery {
  return {
    send: async (notification) => {
      if (config.channels.size === 0) {
        return { ok: false, reason: "no_channels" };
      }
      // Real routing comes in later tasks.
      return { ok: true, delivered: [] };
    },
  };
}
