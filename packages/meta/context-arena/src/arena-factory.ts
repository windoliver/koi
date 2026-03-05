/**
 * Arena factory — the single entry point for coordinated context management.
 *
 * Creates all middleware, providers, and optional modules with coherent budget
 * allocation. Async because optional FsMemory initialization requires I/O.
 */

import type { ContextHydratorMiddleware } from "@koi/context";
import { createContextHydrator } from "@koi/context";
import type { Agent } from "@koi/core/ecs";
import type { ModelHandler } from "@koi/core/middleware";
import type { MergeHandler } from "@koi/memory-fs";
import {
  createFsMemory,
  createKeywordCategoryInferrer,
  createMemoryProvider,
  createUserScopedMemoryProvider,
} from "@koi/memory-fs";
import {
  createCompactorMiddleware,
  createCompositeArchiver,
  createFactExtractingArchiver,
  createSnapshotArchiver,
} from "@koi/middleware-compactor";
import { createContextEditingMiddleware } from "@koi/middleware-context-editing";
import { createConversationMiddleware } from "@koi/middleware-conversation";
import { createHotMemoryMiddleware } from "@koi/middleware-hot-memory";
import { createPersonalizationMiddleware } from "@koi/middleware-personalization";
import { createPreferenceMiddleware } from "@koi/middleware-preference";
import { createSquashProvider } from "@koi/tool-squash";
import { resolveContextArenaConfig } from "./config-resolution.js";
import type { ContextArenaBundle, ContextArenaConfig } from "./types.js";

const MERGE_PROMPT =
  "Merge these two related facts about the same topic into a single concise fact." +
  " Preserve all unique details from both. Return only the merged text, nothing else." +
  "\n\nFact 1: ";

/**
 * Creates a default merge handler that delegates to the summarizer model.
 *
 * Uses a minimal prompt to combine two related facts. Returns undefined
 * if the model response is empty (falls through to supersede).
 */
function createDefaultMergeHandler(summarizer: ModelHandler): MergeHandler {
  return async (existing: string, incoming: string): Promise<string | undefined> => {
    const response = await summarizer({
      messages: [
        {
          content: [{ kind: "text", text: `${MERGE_PROMPT}${existing}\n\nFact 2: ${incoming}` }],
          senderId: "system",
          timestamp: Date.now(),
        },
      ],
      maxTokens: 256,
    });
    const merged = response.content.trim();
    return merged.length > 0 ? merged : undefined;
  };
}

/**
 * Creates a fully wired context arena bundle with coordinated budget allocation.
 *
 * Middleware ordering in the returned array: conversation (100, opt-in) → squash (220) → compactor (225) → context-editing (250) → hot-memory (310, opt-in) → personalization (420, opt-in) → preference (410, default-on with memory).
 * Priority is owned by L2 packages — arena just returns them in priority order.
 *
 * @param config - User-facing configuration with required summarizer, sessionId, and getMessages
 * @returns Bundle containing middleware, providers, resolved config, and optional hydrator factory
 */
export async function createContextArena(config: ContextArenaConfig): Promise<ContextArenaBundle> {
  const resolved = resolveContextArenaConfig(config);

  // --- Opt-in: conversation history (requires threadStore) ---
  const conversationMiddleware =
    resolved.conversationEnabled && config.threadStore !== undefined
      ? createConversationMiddleware({
          store: config.threadStore,
          maxHistoryTokens: resolved.conversationMaxHistoryTokens,
          maxMessages: resolved.conversationMaxMessages,
          // Bridge TokenEstimator (number | Promise<number>) to conversation's sync (number) API.
          // Falls back to chars/4 if the estimator is async — matches conversation's own default.
          estimateTokens: (text: string): number => {
            const result = resolved.tokenEstimator.estimateText(text);
            return typeof result === "number" ? result : Math.ceil(text.length / 4);
          },
          ...(config.conversation?.resolveThreadId !== undefined
            ? { resolveThreadId: config.conversation.resolveThreadId }
            : {}),
          ...(config.conversation?.compact !== undefined
            ? { compact: config.conversation.compact }
            : {}),
        })
      : undefined;

  // --- Opt-in: filesystem memory ---
  // Auto-wire merge handler when memoryFs is enabled (unless explicitly disabled or provided)
  const memoryFsConfig = config.memoryFs?.config;
  const mergeHandler =
    memoryFsConfig !== undefined && config.memoryFs?.disableMerge !== true
      ? (memoryFsConfig.mergeHandler ?? createDefaultMergeHandler(config.summarizer))
      : undefined;

  // Auto-wire keyword category inferrer when not explicitly provided (zero LLM cost)
  const categoryInferrer =
    memoryFsConfig !== undefined
      ? (memoryFsConfig.categoryInferrer ?? createKeywordCategoryInferrer())
      : undefined;

  const effectiveFsConfig =
    memoryFsConfig !== undefined
      ? {
          ...memoryFsConfig,
          ...(mergeHandler !== undefined ? { mergeHandler } : {}),
          ...(categoryInferrer !== undefined ? { categoryInferrer } : {}),
        }
      : undefined;

  // Create early so squash + compactor can share the component
  const fsMemory =
    effectiveFsConfig !== undefined
      ? await createFsMemory({
          ...effectiveFsConfig,
          retriever: config.memoryFs?.retriever ?? effectiveFsConfig.retriever,
          indexer: config.memoryFs?.indexer ?? effectiveFsConfig.indexer,
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
  // Build compactor archiver: durable snapshot storage + fact extraction when memory available.
  // Snapshot archiver runs first (preserves raw messages), then fact extractor (semantic extraction).
  const snapshotArchiver = createSnapshotArchiver(resolved.archiver, {
    sessionId: config.sessionId,
  });
  const compactorArchiver =
    effectiveMemory !== undefined
      ? createCompositeArchiver([snapshotArchiver, createFactExtractingArchiver(effectiveMemory)])
      : snapshotArchiver;

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
    // memory is kept for potential future use by the compactor (e.g., memory-aware prompts);
    // fact extraction is handled by the explicit composite archiver above.
    memory: effectiveMemory,
    archiver: compactorArchiver,
    ...(resolved.conventions.length > 0 ? { conventions: resolved.conventions } : {}),
  });

  // --- Always-on: context-editing middleware ---
  const contextEditingMiddleware = createContextEditingMiddleware({
    triggerTokenCount: resolved.editingTriggerTokenCount,
    numRecentToKeep: resolved.editingNumRecentToKeep,
    tokenEstimator: resolved.tokenEstimator,
  });

  // --- Opt-in: hot memory middleware (requires memoryFs) ---
  const hotMemoryMiddleware =
    resolved.hotMemoryEnabled && effectiveMemory !== undefined
      ? createHotMemoryMiddleware({
          memory: effectiveMemory,
          maxTokens: resolved.hotMemoryMaxTokens,
          refreshInterval: resolved.hotMemoryRefreshInterval,
          tokenEstimator: resolved.tokenEstimator,
        })
      : undefined;

  // --- Opt-in: personalization middleware ---
  const personalizationMiddleware =
    resolved.personalizationEnabled && effectiveMemory !== undefined
      ? createPersonalizationMiddleware({
          memory: effectiveMemory,
          relevanceThreshold: resolved.personalizationRelevanceThreshold,
          maxPreferenceTokens: resolved.personalizationMaxPreferenceTokens,
        })
      : undefined;

  // --- Default-on: preference drift detection (requires memory) ---
  const preferenceMiddleware =
    resolved.preferenceEnabled && effectiveMemory !== undefined
      ? createPreferenceMiddleware({
          memory: effectiveMemory,
          ...(config.preference !== false && config.preference?.classify !== undefined
            ? { classify: config.preference.classify }
            : {}),
        })
      : undefined;

  // --- Middleware in priority order ---
  const middleware = [
    ...(conversationMiddleware !== undefined ? [conversationMiddleware] : []),
    squashBundle.middleware,
    compactorMiddleware,
    contextEditingMiddleware,
    ...(hotMemoryMiddleware !== undefined ? [hotMemoryMiddleware] : []),
    ...(personalizationMiddleware !== undefined ? [personalizationMiddleware] : []),
    ...(preferenceMiddleware !== undefined ? [preferenceMiddleware] : []),
  ];

  // --- Opt-in: memory provider (user-scoped or single-instance) ---
  const memoryProvider =
    config.memoryFs?.userScoped === true && effectiveFsConfig !== undefined
      ? createUserScopedMemoryProvider({
          baseDir: effectiveFsConfig.baseDir,
          maxCachedUsers: config.memoryFs.maxCachedUsers,
          memoryConfig: effectiveFsConfig,
        })
      : fsMemory !== undefined
        ? createMemoryProvider({ memory: fsMemory })
        : undefined;

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
