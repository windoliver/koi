/**
 * Hot memory middleware — injects hot-tier memories into model calls.
 *
 * Priority 310: runs after context-editing (250) and context hydrator (300),
 * so hot memories are the last system content injected before the model sees the request.
 *
 * Turn-interval caching: memories are fetched at session start and every N turns,
 * avoiding redundant I/O on most turns.
 */

import type { MemoryResult } from "@koi/core";
import type { InboundMessage } from "@koi/core/message";
import type { CapabilityFragment, KoiMiddleware, SessionContext } from "@koi/core/middleware";
import type { HotMemoryConfig } from "./types.js";
import { HOT_MEMORY_DEFAULTS } from "./types.js";

/** Format recalled memories into a single text block. */
function formatMemories(memories: readonly MemoryResult[]): string {
  return memories.map((m) => `- ${m.content}`).join("\n");
}

/** Heuristic token estimate: ~4 chars per token. */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Truncate text to fit within a token budget using heuristic estimation. */
function truncateToTokenBudget(text: string, maxTokens: number): string {
  const maxChars = maxTokens * 4;
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}...[truncated]`;
}

/**
 * Creates a middleware that injects hot-tier memories into model calls.
 *
 * On the first model call, hot memories are fetched synchronously (awaited).
 * Subsequent refreshes happen at the configured turn interval.
 * Errors during recall are logged and swallowed — the middleware never blocks model calls.
 */
export function createHotMemoryMiddleware(config: HotMemoryConfig): KoiMiddleware {
  const memory = config.memory;
  const maxTokens = config.maxTokens ?? HOT_MEMORY_DEFAULTS.maxTokens;
  const refreshInterval = config.refreshInterval ?? HOT_MEMORY_DEFAULTS.refreshInterval;

  // let justified: cached injection message, updated at refresh intervals
  let cachedMessage: InboundMessage | undefined;
  // let justified: turn counter since last refresh
  let turnCount = 0;
  // let justified: count of hot memories for capability reporting
  let hotCount = 0;
  // let justified: token count of current cached message for capability reporting
  let cachedTokenCount = 0;
  // let justified: tracks whether initial fetch has completed
  let initialized = false;

  async function fetchHotMemories(): Promise<void> {
    try {
      const results = await memory.recall("*", { tierFilter: "hot", limit: 20 });
      if (results.length === 0) {
        cachedMessage = undefined;
        hotCount = 0;
        cachedTokenCount = 0;
        return;
      }

      const formatted = formatMemories(results);
      const truncated = truncateToTokenBudget(formatted, maxTokens);
      cachedTokenCount = estimateTokens(truncated);
      hotCount = results.length;

      cachedMessage = {
        content: [
          {
            kind: "text",
            text: `[Hot Memories]\n${truncated}`,
          },
        ],
        senderId: "system:hot-memory",
        timestamp: Date.now(),
      };
    } catch (_e: unknown) {
      console.warn("[middleware-hot-memory] recall() failed (swallowed)");
      // Keep existing cache on error — graceful degradation
    }
  }

  function shouldRefresh(): boolean {
    if (refreshInterval === 0) return false; // session start only
    return turnCount % refreshInterval === 0;
  }

  return {
    name: "koi:hot-memory",
    priority: 310,

    async onSessionStart(_ctx: SessionContext): Promise<void> {
      initialized = false;
      turnCount = 0;
      hotCount = 0;
      cachedTokenCount = 0;
      cachedMessage = undefined;
    },

    describeCapabilities(): CapabilityFragment | undefined {
      if (hotCount === 0) return undefined;
      return {
        label: "hot-memory",
        description: `${String(hotCount)} hot memories injected (${String(cachedTokenCount)}/${String(maxTokens)} tokens)`,
      };
    },

    async wrapModelCall(_ctx, request, next) {
      // Initial load on first call
      if (!initialized) {
        initialized = true;
        await fetchHotMemories();
      }

      // Prepend cached hot memories if available
      const effectiveRequest =
        cachedMessage !== undefined
          ? { ...request, messages: [cachedMessage, ...request.messages] }
          : request;

      const result = await next(effectiveRequest);

      // Post-call: increment turn, schedule async refresh if needed
      turnCount++;
      if (shouldRefresh()) {
        // Fire-and-forget refresh for next turn
        fetchHotMemories().catch((_e: unknown) => {
          console.warn("[middleware-hot-memory] background refresh failed (swallowed)");
        });
      }

      return result;
    },

    async *wrapModelStream(_ctx, request, next) {
      // Initial load on first call
      if (!initialized) {
        initialized = true;
        await fetchHotMemories();
      }

      // Prepend cached hot memories if available
      const effectiveRequest =
        cachedMessage !== undefined
          ? { ...request, messages: [cachedMessage, ...request.messages] }
          : request;

      yield* next(effectiveRequest);

      // Post-stream: increment turn, schedule async refresh if needed
      turnCount++;
      if (shouldRefresh()) {
        fetchHotMemories().catch((_e: unknown) => {
          console.warn("[middleware-hot-memory] background refresh failed (swallowed)");
        });
      }
    },
  };
}
