/**
 * Arena factory — the single entry point for coordinated context management.
 *
 * Creates all middleware, providers, and optional modules with coherent budget
 * allocation. Async because optional FsMemory initialization requires I/O.
 */

import type { ContextHydratorMiddleware } from "@koi/context";
import { createContextHydrator } from "@koi/context";
import type { Agent } from "@koi/core/ecs";
import { createFsMemory, createMemoryProvider } from "@koi/memory-fs";
import { createCompactorMiddleware } from "@koi/middleware-compactor";
import { createContextEditingMiddleware } from "@koi/middleware-context-editing";
import { createSquashProvider } from "@koi/tool-squash";
import { resolveContextArenaConfig } from "./config-resolution.js";
import type { ContextArenaBundle, ContextArenaConfig } from "./types.js";

/**
 * Creates a fully wired context arena bundle with coordinated budget allocation.
 *
 * Middleware ordering in the returned array: squash (220) → compactor (225) → context-editing (250).
 * Priority is owned by L2 packages — arena just returns them in priority order.
 *
 * @param config - User-facing configuration with required summarizer, sessionId, and getMessages
 * @returns Bundle containing middleware, providers, resolved config, and optional hydrator factory
 */
export async function createContextArena(config: ContextArenaConfig): Promise<ContextArenaBundle> {
  const resolved = resolveContextArenaConfig(config);

  // --- Opt-in: filesystem memory (created early so squash + compactor can share it) ---
  const fsMemory =
    config.memoryFs !== undefined
      ? await createFsMemory({
          ...config.memoryFs.config,
          retriever: config.memoryFs.retriever ?? config.memoryFs.config.retriever,
          indexer: config.memoryFs.indexer ?? config.memoryFs.config.indexer,
        })
      : undefined;

  // Single effective memory for fact extraction — explicit config.memory overrides fsMemory.
  // When both are provided, fsMemory provider (tools) still attaches for recall/search.
  const effectiveMemory = config.memory ?? fsMemory?.component;

  // --- Always-on: squash provider + middleware ---
  const squashBundle = createSquashProvider(
    {
      archiver: resolved.archiver,
      memory: effectiveMemory,
      tokenEstimator: resolved.tokenEstimator,
      preserveRecent: resolved.squashPreserveRecent,
      maxPendingSquashes: resolved.squashMaxPendingSquashes,
      sessionId: config.sessionId,
    },
    config.getMessages,
  );

  // --- Always-on: compactor middleware ---
  const compactorMiddleware = createCompactorMiddleware({
    summarizer: config.summarizer,
    contextWindowSize: resolved.contextWindowSize,
    trigger: {
      tokenFraction: resolved.compactorTriggerFraction,
      softTriggerFraction: resolved.compactorSoftTriggerFraction,
    },
    preserveRecent: resolved.compactorPreserveRecent,
    maxSummaryTokens: resolved.compactorMaxSummaryTokens,
    tokenEstimator: resolved.tokenEstimator,
    memory: effectiveMemory,
  });

  // --- Always-on: context-editing middleware ---
  const contextEditingMiddleware = createContextEditingMiddleware({
    triggerTokenCount: resolved.editingTriggerTokenCount,
    numRecentToKeep: resolved.editingNumRecentToKeep,
    tokenEstimator: resolved.tokenEstimator,
  });

  // --- Middleware in priority order ---
  const middleware = [squashBundle.middleware, compactorMiddleware, contextEditingMiddleware];

  // --- Opt-in: filesystem memory provider (reuses pre-created fsMemory) ---
  const memoryProvider =
    fsMemory !== undefined ? createMemoryProvider({ memory: fsMemory }) : undefined;

  // --- Providers (immutable) ---
  const providers = [
    squashBundle.provider,
    ...(memoryProvider !== undefined ? [memoryProvider] : []),
  ];

  // --- Opt-in: context hydrator (deferred factory) ---
  // Capture hydrator config before closure to avoid non-null assertion
  const hydratorConfig = config.hydrator?.config;
  const createHydratorFn =
    hydratorConfig !== undefined
      ? (agent: Agent): ContextHydratorMiddleware =>
          createContextHydrator({
            config: hydratorConfig,
            agent,
            estimator: resolved.tokenEstimator,
          })
      : undefined;

  return {
    middleware,
    providers,
    config: resolved,
    ...(createHydratorFn !== undefined ? { createHydrator: createHydratorFn } : {}),
  };
}
