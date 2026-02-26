/**
 * @koi/middleware-soul — Markdown-based agent character + user context injection (Layer 2)
 *
 * Reads markdown personality files (SOUL.md, STYLE.md, INSTRUCTIONS.md) and per-user
 * context files (USER.md), then injects them as stable system prompt prefixes via
 * wrapModelCall/wrapModelStream.
 * Depends on @koi/core only.
 */

export type { CreateSoulOptions, SoulUserInput } from "./config.js";
export {
  DEFAULT_SOUL_MAX_TOKENS,
  DEFAULT_USER_MAX_TOKENS,
  validateSoulConfig,
} from "./config.js";
export { descriptor } from "./descriptor.js";
export type { ResolvedContent, ResolveOptions } from "./resolve.js";
export { resolveSoulContent, resolveUserContent } from "./resolve.js";
export type { SoulMiddleware } from "./soul.js";
export { createSoulMiddleware, enrichRequest } from "./soul.js";
