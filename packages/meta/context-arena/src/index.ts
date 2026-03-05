/**
 * @koi/context-arena — Everything about context (Layer 3)
 *
 * Composes and coordinates all context sources — personality (soul),
 * bootstrap files (.koi/), conversation history, memory, compaction,
 * and context editing — with preset-driven budget allocation.
 *
 * Usage:
 *   const bundle = await createContextArena({
 *     summarizer: myModelHandler,
 *     sessionId: mySessionId,
 *     getMessages: () => messages,
 *     preset: "balanced",      // optional, default: "balanced"
 *   });
 *
 *   const runtime = await createKoi({
 *     manifest,
 *     adapter,
 *     middleware: [...bundle.middleware, ...otherMiddleware],
 *     providers: [...bundle.providers],
 *   });
 */

// --- Bootstrap: .koi/ file hierarchy resolver ---
export type {
  BootstrapConfig,
  BootstrapResolveResult,
  BootstrapResult,
  BootstrapSlot,
  BootstrapTextSource,
  ResolvedSlot,
} from "@koi/bootstrap";
export { DEFAULT_SLOTS, resolveBootstrap } from "@koi/bootstrap";

// --- Search DI types re-exported for L3 convenience ---
export type {
  FsIndexDoc,
  FsSearchHit,
  FsSearchIndexer,
  FsSearchRetriever,
} from "@koi/memory-fs";

// --- Soul: agent personality middleware ---
export type {
  CachedPersona,
  ChannelPersonaConfig,
  ContentInput,
  CreateSoulOptions,
  MetaInstructionSources,
  PersonaMapResult,
  ResolvedPersona,
  SoulMiddleware,
  SoulState,
} from "@koi/soul";
export {
  createAllWatchedPaths,
  createPersonaMap,
  createPersonaWatchedPaths,
  createSoulMessage,
  createSoulMiddleware,
  DEFAULT_IDENTITY_MAX_TOKENS,
  DEFAULT_SOUL_MAX_TOKENS,
  DEFAULT_TOTAL_MAX_TOKENS,
  DEFAULT_USER_MAX_TOKENS,
  descriptor as soulDescriptor,
  enrichRequest,
  extractInput,
  extractMaxTokens,
  generateMetaInstructionText,
  generatePersonaText,
  personasFromManifest,
  resolvePersonaContent,
  validateSoulConfig,
} from "@koi/soul";
export { createContextArena } from "./arena-factory.js";
export { resolveContextArenaConfig } from "./config-resolution.js";
export { computePresetBudget, PRESET_SPECS } from "./presets.js";
export type { ContextArenaBaseConfig, ContextArenaMiddlewareFactory } from "./registry-adapter.js";
export { createContextArenaEntries } from "./registry-adapter.js";
export type {
  CompactorOverrides,
  ContextArenaBundle,
  ContextArenaConfig,
  ContextArenaPreset,
  ContextEditingOverrides,
  ConversationOverrides,
  HotMemoryOverrides,
  PersonalizationOverrides,
  PresetBudget,
  PresetSpec,
  ResolvedContextArenaConfig,
  SquashOverrides,
} from "./types.js";
