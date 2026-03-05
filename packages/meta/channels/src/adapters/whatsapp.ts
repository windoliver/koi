import type { ChannelAdapter, JsonObject } from "@koi/core";
import type { ChannelRuntimeOpts } from "../types.js";

export async function createWhatsappShim(
  config: JsonObject,
  _opts?: ChannelRuntimeOpts,
): Promise<ChannelAdapter> {
  const { createWhatsAppChannel } = await import("@koi/channel-whatsapp");
  return createWhatsAppChannel(config as unknown as Parameters<typeof createWhatsAppChannel>[0]);
}
