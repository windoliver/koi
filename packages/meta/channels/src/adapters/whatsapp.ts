import type { ChannelAdapter, JsonObject } from "@koi/core";
import type { ChannelRuntimeOpts } from "../types.js";

export async function createWhatsappShim(
  config: JsonObject,
  _opts?: ChannelRuntimeOpts,
): Promise<ChannelAdapter> {
  try {
    const { createWhatsAppChannel } = await import("@koi/channel-whatsapp");
    return createWhatsAppChannel(config as unknown as Parameters<typeof createWhatsAppChannel>[0]);
  } catch (error: unknown) {
    throw new Error("To use the WhatsApp channel, install: bun add @koi/channel-whatsapp", {
      cause: error,
    });
  }
}
