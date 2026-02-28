/**
 * @koi/context-arena — Coordinated context management (Layer 3)
 *
 * Arena allocator for the context window: a single factory allocates
 * token budgets across all 7 context management packages with coherent
 * preset-driven profiles (conservative / balanced / aggressive).
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
  PresetBudget,
  PresetSpec,
  ResolvedContextArenaConfig,
  SquashOverrides,
} from "./types.js";
