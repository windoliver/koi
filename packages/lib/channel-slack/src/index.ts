/**
 * @koi/channel-slack — Slack ChannelAdapter (L0u).
 *
 * Socket Mode (WebSocket) and HTTP Events API (signature-verified webhook).
 */

export type {
  SlackAppMentionEvent,
  SlackBlockAction,
  SlackEvent,
  SlackFileObject,
  SlackMessageEvent,
  SlackSlashCommand,
} from "./normalize.js";
export type {
  SlackChannelAdapter,
  SlackChannelConfig,
  SlackClients,
  SlackDeployment,
  SlackFeatures,
  SlackReplyToMode,
  SocketModeClientLike,
  WebClientLike,
} from "./slack-channel.js";
export { createSlackChannel } from "./slack-channel.js";
export type { VerifySlackRequestResult } from "./verify-signature.js";
export { verifySlackRequest, verifySlackSignature } from "./verify-signature.js";
