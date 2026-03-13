/**
 * Shared middleware composition — assembles the full middleware + provider
 * arrays from resolved subsystems for createForgeConfiguredKoi.
 *
 * Reused by start.ts, serve.ts, and up.ts.
 */

import type { ComponentProvider, KoiMiddleware } from "@koi/core";
import type { createForgeBootstrap } from "@koi/forge";
import type { AgentChatBridge } from "./agui-chat-bridge.js";
import type { AutonomousResult } from "./resolve-autonomous.js";
import type { NexusResolvedState } from "./resolve-nexus.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MiddlewareCompositionInput {
  /** Middleware from manifest resolution (resolveAgent). */
  readonly resolved: readonly KoiMiddleware[];
  /** Nexus middleware + providers (from resolveNexusOrWarn). */
  readonly nexus: NexusResolvedState;
  /** Forge bootstrap (from bootstrapForgeOrWarn). */
  readonly forge: ReturnType<typeof createForgeBootstrap> | undefined;
  /** Autonomous agent result (from resolveAutonomousOrWarn). */
  readonly autonomous: AutonomousResult | undefined;
  /** AG-UI chat bridge (for admin chat). */
  readonly chatBridge: AgentChatBridge | undefined;
  /** Additional middleware to prepend (e.g., arena middleware for serve). */
  readonly extra?: readonly KoiMiddleware[];
  /** Additional providers to prepend (e.g., arena providers for serve). */
  readonly extraProviders?: readonly ComponentProvider[];
}

export interface ComposedMiddleware {
  readonly middleware: readonly KoiMiddleware[];
  readonly providers: readonly ComponentProvider[];
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Composes the full middleware and provider arrays from all resolved subsystems.
 *
 * Order matters: resolved (manifest) middleware runs first, then extra
 * (arena), then nexus, forge, autonomous, and finally chat bridge.
 */
export function composeRuntimeMiddleware(input: MiddlewareCompositionInput): ComposedMiddleware {
  const middleware: readonly KoiMiddleware[] = [
    ...input.resolved,
    ...(input.extra ?? []),
    ...input.nexus.middlewares,
    ...(input.forge?.middlewares ?? []),
    ...(input.autonomous?.middleware ?? []),
    ...(input.chatBridge !== undefined ? [input.chatBridge.middleware] : []),
  ];

  const providers: readonly ComponentProvider[] = [
    ...(input.extraProviders ?? []),
    ...input.nexus.providers,
    ...(input.forge !== undefined ? [input.forge.provider, input.forge.forgeToolsProvider] : []),
    ...(input.autonomous?.providers ?? []),
  ];

  return { middleware, providers };
}
