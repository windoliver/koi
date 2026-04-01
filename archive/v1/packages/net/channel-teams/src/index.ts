/**
 * @koi/channel-teams — Microsoft Teams channel adapter via Bot Framework.
 *
 * Creates a ChannelAdapter that receives Bot Framework Activities via HTTP
 * webhook and sends responses through turn contexts.
 *
 * @example
 * ```typescript
 * import { createTeamsChannel } from "@koi/channel-teams";
 *
 * const channel = createTeamsChannel({
 *   appId: process.env.TEAMS_APP_ID!,
 *   appPassword: process.env.TEAMS_APP_PASSWORD!,
 * });
 * await channel.connect();
 * ```
 */

export type {
  TeamsAccount,
  TeamsActivity,
  TeamsAttachment,
  TeamsConversation,
  TeamsConversationReference,
} from "./activity-types.js";
export type { TeamsChannelAdapter, TeamsChannelConfig, TeamsFeatures } from "./config.js";
export { DEFAULT_TEAMS_PORT } from "./config.js";
export { descriptor } from "./descriptor.js";
export { createTeamsChannel } from "./teams-channel.js";
export type { BotFrameworkAuthenticator, BotFrameworkAuthResult } from "./verify-jwt.js";
export { createBotFrameworkAuthenticator } from "./verify-jwt.js";
