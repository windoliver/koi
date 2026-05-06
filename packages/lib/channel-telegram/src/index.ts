/**
 * @koi/channel-telegram — Telegram ChannelAdapter (L2).
 */

export type {
  AnswerCallbackQuery,
  GetFileUrl,
  TelegramCallbackQueryLike,
  TelegramChatLike,
  TelegramDocumentLike,
  TelegramMessageLike,
  TelegramNormalizerDeps,
  TelegramPhotoSizeLike,
  TelegramUpdateLike,
  TelegramUserLike,
} from "./normalize.js";
export { createNormalizer } from "./normalize.js";
export type {
  TelegramApiLike,
  TelegramBotLike,
  TelegramChannelAdapter,
  TelegramChannelConfig,
  TelegramContextLike,
  TelegramDeployment,
  TelegramInlineButton,
  TelegramReplyMarkup,
  TelegramSendDocumentOther,
  TelegramSendMessageOther,
  TelegramSendPhotoOther,
} from "./telegram-channel.js";
export {
  createTelegramChannel,
  splitText,
  TelegramPartialDeliveryError,
} from "./telegram-channel.js";
