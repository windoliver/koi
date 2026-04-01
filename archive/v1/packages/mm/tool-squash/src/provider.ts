/**
 * Bundle factory — creates the squash tool provider + companion middleware.
 *
 * Both share a closure-scoped pending queue. The caller registers:
 * - The ComponentProvider via assembly (attaches tool:squash)
 * - The KoiMiddleware via middleware chain (applies squashes before model calls)
 */

import { skillToken } from "@koi/core";
import type { Agent, ComponentProvider } from "@koi/core/ecs";
import type { InboundMessage } from "@koi/core/message";
import type { KoiMiddleware } from "@koi/core/middleware";
import { heuristicTokenEstimator } from "./estimator.js";
import { SQUASH_SKILL, SQUASH_SKILL_NAME } from "./skill.js";
import { createSquashMiddleware } from "./squash-middleware.js";
import { createSquashTool } from "./squash-tool.js";
import type { ResolvedSquashConfig, SquashConfig } from "./types.js";
import { createPendingQueue, SQUASH_DEFAULTS } from "./types.js";

// ---------------------------------------------------------------------------
// Config validation
// ---------------------------------------------------------------------------

function validatePositiveInt(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`Invalid ${name}: expected a positive integer, got ${String(value)}`);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Return value of createSquashProvider — both must be registered. */
export interface SquashProviderBundle {
  readonly provider: ComponentProvider;
  readonly middleware: KoiMiddleware;
}

/**
 * Creates a ComponentProvider + KoiMiddleware bundle for the squash tool.
 *
 * @param config - User-facing configuration
 * @param getMessages - Returns current conversation messages for the tool to partition
 */
export function createSquashProvider(
  config: SquashConfig,
  getMessages: () => readonly InboundMessage[],
): SquashProviderBundle {
  const pendingQueue = createPendingQueue();

  const resolved: ResolvedSquashConfig = {
    archiver: config.archiver,
    memory: config.memory,
    tokenEstimator: config.tokenEstimator ?? heuristicTokenEstimator,
    preserveRecent: config.preserveRecent ?? SQUASH_DEFAULTS.preserveRecent,
    maxPendingSquashes: config.maxPendingSquashes ?? SQUASH_DEFAULTS.maxPendingSquashes,
    sessionId: config.sessionId,
  };

  validatePositiveInt(resolved.preserveRecent, "preserveRecent");
  validatePositiveInt(resolved.maxPendingSquashes, "maxPendingSquashes");

  // let justified: mutable cache (set once on first attach, reused thereafter)
  let cached: ReadonlyMap<string, unknown> | undefined;

  const provider: ComponentProvider = {
    name: "squash",

    async attach(_agent: Agent): Promise<ReadonlyMap<string, unknown>> {
      if (cached !== undefined) return cached;

      const tool = createSquashTool(resolved, pendingQueue, getMessages);
      cached = new Map<string, unknown>([
        ["tool:squash", tool],
        [skillToken(SQUASH_SKILL_NAME) as string, SQUASH_SKILL],
      ]);
      return cached;
    },

    async detach(_agent: Agent): Promise<void> {
      cached = undefined;
      pendingQueue.clear();
    },
  };

  const middleware = createSquashMiddleware(pendingQueue);

  return { provider, middleware };
}
