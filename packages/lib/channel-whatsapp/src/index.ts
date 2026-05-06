/**
 * @koi/channel-whatsapp — public exports.
 *
 * WhatsApp channel adapter: Meta Cloud API webhook (HMAC-SHA256 verified)
 * inbound + Graph API outbound message send.
 */

export type { WhatsAppConfig } from "./config.js";
export { validateWhatsAppConfig } from "./config.js";

export type {
  NormalizeError,
  NormalizeResult,
  WhatsAppMessage,
  WhatsAppWebhookEntry,
} from "./normalize.js";

export type { FetchFn, SendError, SendErrorCode, SendResult } from "./platform-send.js";

export type { VerifySignatureInput, VerifySignatureResult } from "./verify-signature.js";
export { verifyMetaSignature } from "./verify-signature.js";

export type {
  WhatsAppChannelAdapter,
  WhatsAppDependencies,
  WhatsAppErrorCode,
} from "./whatsapp-channel.js";
export { createWhatsAppChannel } from "./whatsapp-channel.js";
