/**
 * @koi/channel-slack — Slack channel adapter.
 *
 * Creates a ChannelAdapter for Slack bots using @slack/web-api +
 * @slack/socket-mode. Supports Socket Mode (WebSocket) and HTTP Events API.
 */

export type {
  SlackChannelConfig,
  SlackDeployment,
  SlackFeatures,
  SlackReplyToMode,
} from "./config.js";
export { descriptor } from "./descriptor.js";
export type { SlackChannelAdapter } from "./slack-channel.js";
export { createSlackChannel } from "./slack-channel.js";
export type { VerifySlackRequestResult } from "./verify-signature.js";
export { verifySlackRequest, verifySlackSignature } from "./verify-signature.js";
