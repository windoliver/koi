/**
 * Frozen-snapshot memory recall middleware.
 *
 * On the first model call of a session, calls recallMemories() to scan a
 * memory directory, score by salience, budget-select within a token limit,
 * and format the results. The formatted output is cached and prepended to
 * every subsequent model call in the session. Never re-recalls.
 *
 * Priority 310: runs after extraction (305), so recalled memories reflect
 * the latest extracted learnings from prior sessions.
 */

import type {
  CapabilityFragment,
  InboundMessage,
  KoiMiddleware,
  ModelChunk,
  ModelRequest,
  ModelResponse,
  SessionContext,
  TurnContext,
} from "@koi/core";
import { recallMemories } from "@koi/memory";
import { estimateTokens } from "@koi/token-estimator";
import type { MemoryRecallMiddlewareConfig } from "./types.js";

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates a frozen-snapshot memory recall middleware.
 *
 * Behavior:
 * - First model call: runs recallMemories() once, caches the result
 * - Subsequent calls: prepends cached memory message to request.messages
 * - onSessionStart: resets cache for a fresh recall on the next session
 * - Errors during recall are logged and swallowed (graceful degradation)
 */
export function createMemoryRecallMiddleware(config: MemoryRecallMiddlewareConfig): KoiMiddleware {
  // let justified: cached injection message, set once on first model call per session
  let cachedMessage: InboundMessage | undefined;
  // let justified: whether recallMemories() has been attempted this session
  let initialized = false;
  // let justified: count of recalled memories for capability reporting
  let memoryCount = 0;
  // let justified: total token count of cached message for capability reporting
  let tokenCount = 0;

  /**
   * Runs the recall pipeline exactly once. Sets initialized = true regardless
   * of outcome so that failures are not retried.
   */
  async function initialize(): Promise<void> {
    initialized = true;

    try {
      const result = await recallMemories(config.fs, config.recall);

      if (result.formatted.length === 0) {
        return;
      }

      memoryCount = result.selected.length;
      tokenCount = estimateTokens(result.formatted);

      cachedMessage = {
        content: [{ kind: "text", text: result.formatted }],
        senderId: "system:memory-recall",
        timestamp: Date.now(),
      };
    } catch (_e: unknown) {
      console.warn("[middleware-memory-recall] recallMemories() failed (swallowed)");
      // Graceful degradation: proceed without memory injection
    }
  }

  /** Prepends cached memory message to the request if available. */
  function injectMemories(request: ModelRequest): ModelRequest {
    if (cachedMessage === undefined) {
      return request;
    }
    return { ...request, messages: [cachedMessage, ...request.messages] };
  }

  return {
    name: "koi:memory-recall",
    priority: 310,

    async onSessionStart(_ctx: SessionContext): Promise<void> {
      cachedMessage = undefined;
      initialized = false;
      memoryCount = 0;
      tokenCount = 0;
    },

    describeCapabilities(): CapabilityFragment | undefined {
      if (memoryCount === 0) {
        return undefined;
      }
      const budget = config.recall.tokenBudget ?? 8000;
      return {
        label: "memory-recall",
        description: `${String(memoryCount)} memories recalled (${String(tokenCount)}/${String(budget)} tokens)`,
      };
    },

    async wrapModelCall(
      _ctx: TurnContext,
      request: ModelRequest,
      next: (request: ModelRequest) => Promise<ModelResponse>,
    ): Promise<ModelResponse> {
      if (!initialized) {
        await initialize();
      }
      return next(injectMemories(request));
    },

    async *wrapModelStream(
      _ctx: TurnContext,
      request: ModelRequest,
      next: (request: ModelRequest) => AsyncIterable<ModelChunk>,
    ): AsyncIterable<ModelChunk> {
      if (!initialized) {
        await initialize();
      }
      yield* next(injectMemories(request));
    },
  };
}
