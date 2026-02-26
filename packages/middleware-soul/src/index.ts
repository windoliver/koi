/**
 * @koi/middleware-soul — Markdown-based agent character + user context injection (Layer 2)
 *
 * @deprecated Use `@koi/soul` instead. This package is a thin re-export shim
 * kept for one release cycle. It will be removed in the next breaking release.
 *
 * Reads markdown personality files (SOUL.md, STYLE.md, INSTRUCTIONS.md) and per-user
 * context files (USER.md), then injects them as stable system prompt prefixes via
 * wrapModelCall/wrapModelStream.
 */

import type { ContentInput } from "@koi/soul";

/**
 * @deprecated Use `ContentInput` from `@koi/soul` instead.
 */
export type SoulUserInput = ContentInput;

export type { CreateSoulOptions, SoulMiddleware } from "@koi/soul";
export {
  createSoulMiddleware,
  DEFAULT_SOUL_MAX_TOKENS,
  DEFAULT_USER_MAX_TOKENS,
  enrichRequest,
  validateSoulConfig,
} from "@koi/soul";
export { descriptor } from "./descriptor.js";
export type { ResolvedContent, ResolveOptions } from "./resolve.js";
export { resolveSoulContent, resolveUserContent } from "./resolve.js";
