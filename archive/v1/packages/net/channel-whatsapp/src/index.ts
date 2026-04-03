/**
 * @koi/channel-whatsapp — Baileys WhatsApp Web channel adapter.
 *
 * Creates a ChannelAdapter for WhatsApp bots using @whiskeysockets/baileys.
 * Supports text, images, documents, audio, video, stickers, and reactions.
 */

export type { WhatsAppChannelConfig } from "./config.js";
export { descriptor } from "./descriptor.js";
export type { WhatsAppChannelAdapter } from "./whatsapp-channel.js";
export { createWhatsAppChannel } from "./whatsapp-channel.js";
