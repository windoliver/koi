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
  TelegramDeployment,
  TelegramInlineButton,
  TelegramReplyMarkup,
  TelegramSendOptions,
} from "./telegram-channel.js";
export { createTelegramChannel, splitText } from "./telegram-channel.js";
