/**
 * @koi/bootstrap — File hierarchy resolver for agent bootstrap context.
 *
 * Resolves .koi/{INSTRUCTIONS,TOOLS,CONTEXT}.md files per agent type
 * and outputs text sources for the @koi/context hydrator.
 *
 * L2 package — depends on @koi/core (L0) and @koi/hash (L0u) only.
 */

export { DEFAULT_SLOTS, resolveBootstrap } from "./resolve.js";
export type {
  BootstrapConfig,
  BootstrapResolveResult,
  BootstrapResult,
  BootstrapSlot,
  BootstrapTextSource,
  ResolvedSlot,
} from "./types.js";
