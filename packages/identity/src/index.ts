/**
 * @koi/identity — Per-channel agent personas with hot-reload (Layer 2 middleware)
 *
 * @deprecated Use `@koi/soul` instead, which unifies soul + identity + user
 * into a single middleware. This package is kept for one release cycle and
 * will be removed in the next breaking release.
 *
 * Injects per-channel persona (name, avatar, instructions) as a system message prefix,
 * keyed by `SessionContext.channelId`. Hot-reloads when instruction files change.
 *
 * Depends on @koi/core only (L2 package).
 */

export type { ChannelPersonaConfig, CreateIdentityOptions } from "./config.js";
export { validateIdentityConfig } from "./config.js";
export type { IdentityMiddleware } from "./identity.js";
export { createIdentityMiddleware, enrichRequest } from "./identity.js";
export { personasFromManifest } from "./manifest.js";
export type { CachedPersona, ResolvedPersona } from "./persona-map.js";
export { buildPersonaMap, buildWatchedPaths, resolvePersonaContent } from "./persona-map.js";
