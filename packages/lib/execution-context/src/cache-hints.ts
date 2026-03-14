/**
 * Prompt cache hints — shared type and side-channel instance for
 * middleware → engine adapter communication.
 *
 * Lives in L0u so both L2 middleware (@koi/middleware-prompt-cache)
 * and L2 adapters (@koi/model-router) can import without peer L2 deps.
 */

import { createSideChannel, type SideChannel } from "./side-channel.js";

/**
 * Cache hints attached to a ModelRequest via side-channel.
 * Engine adapters read these to apply provider-specific cache markers.
 */
export interface CacheHints {
  /** Provider name (e.g., "anthropic", "openai"). */
  readonly provider: string;
  /**
   * Index of the last stable (static) message in the reordered array.
   * For Anthropic: set cache_control on content blocks at this index.
   * For OpenAI: ensure content up to this index exceeds prefix threshold.
   */
  readonly lastStableIndex: number;
  /** Total estimated tokens in the static prefix. */
  readonly staticPrefixTokens: number;
}

/**
 * Global side-channel for prompt cache hints.
 * Middleware writes; engine adapters read.
 */
export const PROMPT_CACHE_HINTS: SideChannel<CacheHints> =
  createSideChannel<CacheHints>("prompt-cache");
