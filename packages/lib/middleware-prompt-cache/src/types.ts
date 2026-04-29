// CacheHints lives in @koi/execution-context (L0u) so both middleware and
// engine adapters can import it without peer-L2 deps.
export type { CacheHints } from "@koi/execution-context";

export interface PromptCacheConfig {
  /** Master switch. Default: true. */
  readonly enabled?: boolean;
  /** Provider allow-list. Default: ["anthropic", "openai"]. */
  readonly providers?: readonly string[];
  /**
   * Minimum static-prefix tokens before hints are emitted. Below this,
   * cache write cost outweighs the hit savings. Default: 1024.
   *
   * Provider thresholds (for reference):
   * - Anthropic: 1024 (Sonnet), 2048 (Haiku), 4096 (Opus)
   * - OpenAI: 1024 (automatic caching threshold)
   */
  readonly staticPrefixMinTokens?: number;
}

export interface ResolvedPromptCacheConfig {
  readonly enabled: boolean;
  readonly providers: readonly string[];
  readonly staticPrefixMinTokens: number;
}

export const DEFAULT_PROMPT_CACHE_CONFIG: ResolvedPromptCacheConfig = {
  enabled: true,
  providers: ["anthropic", "openai"],
  staticPrefixMinTokens: 1024,
} as const;
