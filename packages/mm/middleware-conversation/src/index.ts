/**
 * @koi/middleware-conversation — Conversation continuity via thread history (Layer 2)
 *
 * Links stateless channel sessions by loading history on session start,
 * injecting it into model calls, and persisting new turns on session end.
 * Depends on @koi/core, @koi/token-estimator, and @koi/snapshot-chain-store.
 */

export type { ConversationConfig, ConversationDefaults } from "./config.js";
export { CONVERSATION_DEFAULTS } from "./config.js";
export { createConversationMiddleware } from "./conversation-middleware.js";
