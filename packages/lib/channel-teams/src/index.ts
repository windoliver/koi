/**
 * @koi/channel-teams — public exports.
 *
 * Microsoft Teams channel adapter: Bot Framework JWT-verified webhook inbound
 * + Adaptive-Card-capable outbound via `ConversationAddressStore`.
 */

export type { CloudProfile, ServiceUrlPattern, TeamsConfig } from "./config.js";
export { validateTeamsConfig } from "./config.js";

export type { Activity, ActivityAttachment } from "./normalize.js";

export type {
  TeamsChannelAdapter,
  TeamsDependencies,
  TeamsErrorCode,
} from "./teams-channel.js";
export { createTeamsChannel } from "./teams-channel.js";

export type { JwtVerifier, VerifiedClaims, VerifyResult } from "./verify-jwt.js";
export { createTokenVerifier, matchServiceUrl } from "./verify-jwt.js";
