/**
 * Arena factory — the single entry point for coordinated context management.
 *
 * Creates all middleware, providers, and optional modules with coherent budget
 * allocation. Async because optional FsMemory initialization requires I/O.
 */

import type { ContextHydratorMiddleware } from "@koi/context";
import { createContextHydrator } from "@koi/context";
import type { Agent, MemoryComponent } from "@koi/core/ecs";
import type { KoiMiddleware, ModelHandler, SessionContext } from "@koi/core/middleware";
import type { MergeHandler, UserScopedMemory } from "@koi/memory-fs";
import {
  createFsMemory,
  createKeywordCategoryInferrer,
  createMemoryProvider,
  createUserScopedMemory,
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
import { createUserModelMiddleware } from "@koi/middleware-user-model";
import { estimateTokens } from "@koi/token-estimator";
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

// ---------------------------------------------------------------------------
// User-scoped memory proxy — delegates to per-user FsMemory at call time.
// ---------------------------------------------------------------------------

/**
 * Mutable userId binding for the user-scoped memory proxy.
 *
 * Updated by the session-binding middleware on each onSessionStart.
 */
interface UserIdBinding {
  /** let justified: mutable userId updated per-session by binding middleware. */
  userId: string | undefined;
}

/**
 * Creates a delegating MemoryComponent that resolves to the correct per-user
 * FsMemory instance at call time.
 *
 * When no userId is bound (e.g. before first session), falls back to the
 * shared instance — matching the provider's fallback behavior.
 */
function createScopedMemoryProxy(
  scopedMemory: UserScopedMemory,
  binding: UserIdBinding,
): MemoryComponent {
  async function resolve(): Promise<MemoryComponent> {
    const uid = binding.userId;
    const mem =
      uid !== undefined && uid.length > 0
        ? await scopedMemory.getOrCreate(uid)
        : await scopedMemory.getShared();
    return mem.component;
  }

  return {
    recall: async (query, options) => {
      const mem = await resolve();
      return mem.recall(query, options);
    },
    store: async (content, options) => {
      const mem = await resolve();
      return mem.store(content, options);
    },
  };
}

/**
 * Creates a zero-overhead middleware that binds the active userId from
 * SessionContext into the shared binding object. Must run before any
 * memory-dependent middleware in the chain (priority 0 — earliest possible).
 */
function createSessionBindingMiddleware(binding: UserIdBinding): KoiMiddleware {
  return {
    name: "koi:session-binding",
    priority: 0,

    describeCapabilities: () => undefined,

    async onSessionStart(ctx: SessionContext): Promise<void> {
      binding.userId = ctx.userId;
    },

    async onSessionEnd(_ctx: SessionContext): Promise<void> {
      binding.userId = undefined;
    },
  };
}

/**
 * Creates a fully wired context arena bundle with coordinated budget allocation.
 *
 * Middleware ordering in the returned array: session-binding (0, user-scoped only) → conversation (100, opt-in) → squash (220) → compactor (225) → context-editing (250) → hot-memory (310, opt-in) → user-model (415, opt-in).
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
            return typeof result === "number" ? result : estimateTokens(text);
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

  // Create early so squash + compactor can share the component.
  // When userScoped is enabled, skip the singleton — per-user instances are created lazily
  // via a delegating proxy so middleware reads/writes the correct user-scoped memory.
  const isUserScoped = config.memoryFs?.userScoped === true;
  const fsMemory =
    effectiveFsConfig !== undefined && !isUserScoped
      ? await createFsMemory({
          ...effectiveFsConfig,
          retriever: config.memoryFs?.retriever ?? effectiveFsConfig.retriever,
          indexer: config.memoryFs?.indexer ?? effectiveFsConfig.indexer,
        })
      : undefined;

  // When userScoped, create a delegating proxy that resolves per-user memory at call time.
  // The binding is mutated by the session-binding middleware on each onSessionStart.
  const userIdBinding: UserIdBinding = { userId: undefined };
  const scopedMemory =
    isUserScoped && effectiveFsConfig !== undefined
      ? createUserScopedMemory({
          baseDir: effectiveFsConfig.baseDir,
          maxCachedUsers: config.memoryFs?.maxCachedUsers,
          memoryConfig: effectiveFsConfig,
        })
      : undefined;
  const scopedProxy =
    scopedMemory !== undefined ? createScopedMemoryProxy(scopedMemory, userIdBinding) : undefined;

  // Single effective memory for fact extraction — explicit config.memory overrides fsMemory / proxy.
  // When both are provided, fsMemory provider (tools) still attaches for recall/search.
  const effectiveMemory = config.memory ?? scopedProxy ?? fsMemory?.component;

  // Session-binding middleware is only needed when the scoped proxy is actually in use
  // (i.e., not overridden by an explicit config.memory).
  const needsSessionBinding = scopedProxy !== undefined && config.memory === undefined;

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

  // --- Unified user model middleware (replaces personalization + preference-drift) ---
  const userModelMiddleware =
    (resolved.personalizationEnabled || resolved.preferenceEnabled) && effectiveMemory !== undefined
      ? createUserModelMiddleware({
          memory: effectiveMemory,
          preAction: { enabled: resolved.personalizationEnabled },
          postAction: { enabled: resolved.personalizationEnabled },
          drift: {
            enabled: resolved.preferenceEnabled,
            ...(config.preference !== false && config.preference?.classify !== undefined
              ? { classify: config.preference.classify }
              : {}),
          },
          relevanceThreshold: resolved.personalizationRelevanceThreshold,
          maxPreferenceTokens: resolved.personalizationMaxPreferenceTokens,
        })
      : undefined;

  // --- Middleware in priority order ---
  // When user-scoped, prepend session-binding middleware (priority 0) to set the
  // active userId before any memory-dependent middleware runs.
  const sessionBindingMiddleware = needsSessionBinding
    ? createSessionBindingMiddleware(userIdBinding)
    : undefined;

  const middleware = [
    ...(sessionBindingMiddleware !== undefined ? [sessionBindingMiddleware] : []),
    ...(conversationMiddleware !== undefined ? [conversationMiddleware] : []),
    squashBundle.middleware,
    compactorMiddleware,
    contextEditingMiddleware,
    ...(hotMemoryMiddleware !== undefined ? [hotMemoryMiddleware] : []),
    ...(userModelMiddleware !== undefined ? [userModelMiddleware] : []),
  ];

  // --- Opt-in: memory provider (user-scoped or single-instance) ---
  // When user-scoped AND session-binding is active, share the same scopedMemory
  // instance so the provider routes to the same per-user memory as the middleware proxy.
  // This prevents the mismatch where middleware uses SessionContext.userId but
  // the provider routes by agent.pid.ownerId (a static value set at attach time).
  const memoryProvider =
    config.memoryFs?.userScoped === true &&
    effectiveFsConfig !== undefined &&
    scopedMemory !== undefined
      ? createUserScopedMemoryProvider({
          baseDir: effectiveFsConfig.baseDir,
          maxCachedUsers: config.memoryFs.maxCachedUsers,
          memoryConfig: effectiveFsConfig,
          // TODO(#6): Provider tools still resolve userId from agent.pid.ownerId at attach time,
          // while the arena's session-binding middleware resolves from SessionContext.userId per-session.
          // In multi-user serve mode these can diverge. Full fix requires provider tools to accept
          // a dynamic userId resolver, similar to createScopedMemoryProxy above.
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
