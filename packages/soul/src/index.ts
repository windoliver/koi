/**
 * @koi/soul — Unified agent personality middleware (Layer 2)
 *
 * Three composable layers of system prompt injection:
 * - soul: global agent personality (SOUL.md, STYLE.md, INSTRUCTIONS.md)
 * - identity: per-channel personas (name, avatar, instructions)
 * - user: per-user context (USER.md)
 *
 * Depends on @koi/core + @koi/file-resolution only (L2 package).
 */

export type {
  ChannelPersonaConfig,
  ContentInput,
  CreateSoulOptions,
} from "./config.js";
export {
  DEFAULT_IDENTITY_MAX_TOKENS,
  DEFAULT_SOUL_MAX_TOKENS,
  DEFAULT_TOTAL_MAX_TOKENS,
  DEFAULT_USER_MAX_TOKENS,
  extractInput,
  extractMaxTokens,
  validateSoulConfig,
} from "./config.js";
export { personasFromManifest } from "./manifest.js";
export type { CachedPersona, ResolvedPersona } from "./persona-map.js";
export {
  createPersonaMap,
  createPersonaWatchedPaths,
  generatePersonaText,
  resolvePersonaContent,
} from "./persona-map.js";
export type { SoulMiddleware } from "./soul.js";
export { createSoulMiddleware, enrichRequest } from "./soul.js";
export type { SoulState } from "./state.js";
export { createAllWatchedPaths, createSoulMessage } from "./state.js";
