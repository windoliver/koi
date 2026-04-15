/**
 * Memory recall middleware — frozen snapshot + optional per-turn relevance.
 *
 * Two layers:
 *   1. Frozen snapshot (always): scans memory dir once at session start,
 *      scores by salience, budgets to token limit, caches as stable prefix.
 *   2. Relevance overlay (optional): per-turn side-query asks a lightweight
 *      model to pick the N most relevant memories for the current message.
 *      Selected files are loaded and injected alongside the frozen snapshot.
 *
 * The frozen snapshot preserves prompt cache (stable prefix). The relevance
 * overlay adds per-turn context without breaking the cache (appended after).
 *
 * Priority 310: runs after extraction (305).
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
import { recallMemories, scanMemoryDirectory } from "@koi/memory";
import { estimateTokens } from "@koi/token-estimator";
import type { MemoryManifestEntry } from "./select-relevant.js";
import { selectRelevantMemories } from "./select-relevant.js";
import type { MemoryRecallMiddlewareConfig } from "./types.js";

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates a memory recall middleware with frozen snapshot + optional
 * per-turn relevance selection.
 */
export function createMemoryRecallMiddleware(config: MemoryRecallMiddlewareConfig): KoiMiddleware {
  // --- Frozen snapshot state ---
  // let justified: cached injection message, set once on first model call per session
  let cachedMessage: InboundMessage | undefined;
  // let justified: whether recallMemories() has been attempted this session
  let initialized = false;
  // let justified: count of recalled memories for capability reporting
  let memoryCount = 0;
  // let justified: total token count of cached message for capability reporting
  let tokenCount = 0;

  // --- Relevance state ---
  // let justified: full manifest built during initialize(), reused per-turn
  let memoryManifest: readonly MemoryManifestEntry[] = [];
  // let justified: set of file paths already in the frozen snapshot (skip in relevance overlay)
  let frozenPaths: ReadonlySet<string> = new Set();
  // let justified: true when frozen snapshot couldn't fit all memories (selector has work to do)
  let selectorNeeded = false;

  /**
   * Runs the recall pipeline exactly once. Sets initialized = true regardless
   * of outcome so that failures are not retried.
   *
   * Also builds the memory manifest for per-turn relevance selection.
   */
  async function initialize(): Promise<void> {
    initialized = true;

    try {
      const result = await recallMemories(config.fs, config.recall);

      if (result.formatted.length > 0) {
        memoryCount = result.selected.length;
        tokenCount = estimateTokens(result.formatted);

        cachedMessage = {
          content: [{ kind: "text", text: result.formatted }],
          senderId: "system:memory-recall",
          timestamp: Date.now(),
        };

        // Track which files are already in the frozen snapshot
        frozenPaths = new Set(result.selected.map((s) => s.memory.record.filePath));
      }

      // Build manifest for relevance selector ONLY when the frozen snapshot
      // was truncated (more memories exist than fit in the token budget).
      // When all memories fit, the selector adds zero value — skip the
      // second scan and the per-turn model call entirely.
      if (config.relevanceSelector !== undefined && result.truncated) {
        selectorNeeded = true;
        const scanResult = await scanMemoryDirectory(config.fs, {
          memoryDir: config.recall.memoryDir,
        });
        memoryManifest = scanResult.memories.map((m) => ({
          name: m.record.name,
          description: m.record.description,
          type: m.record.type,
          filePath: m.record.filePath,
        }));
      }
    } catch (_e: unknown) {
      console.warn("[middleware-memory-recall] recallMemories() failed (swallowed)");
    }
  }

  /**
   * Extract the user's latest text message from the request.
   * Used as the query for relevance selection.
   */
  function extractUserMessage(request: ModelRequest): string {
    // Walk messages in reverse to find the last user message
    for (let i = request.messages.length - 1; i >= 0; i--) {
      const msg = request.messages[i];
      if (msg === undefined) continue;
      if (msg.senderId === "user" || msg.senderId?.startsWith("user") === true) {
        const textBlocks = msg.content.filter(
          (b): b is { readonly kind: "text"; readonly text: string } => b.kind === "text",
        );
        if (textBlocks.length > 0) {
          return textBlocks.map((b) => b.text).join("\n");
        }
      }
    }
    return "";
  }

  /**
   * Run per-turn relevance selection and build an injection message
   * with the selected (non-frozen) memories.
   */
  async function selectRelevant(request: ModelRequest): Promise<InboundMessage | undefined> {
    if (!selectorNeeded || config.relevanceSelector === undefined || memoryManifest.length === 0) {
      return undefined;
    }

    // Only select from memories NOT already in the frozen snapshot
    const candidates = memoryManifest.filter((m) => !frozenPaths.has(m.filePath));
    if (candidates.length === 0) return undefined;

    const userMessage = extractUserMessage(request);
    if (userMessage.length === 0) return undefined;

    const selectedPaths = await selectRelevantMemories(
      candidates,
      userMessage,
      config.relevanceSelector,
    );

    if (selectedPaths.length === 0) return undefined;

    // Load selected memory files
    const contents: string[] = [];
    for (const filePath of selectedPaths) {
      const fullPath = `${config.recall.memoryDir}/${filePath}`;
      const readResult = await config.fs.read(fullPath);
      if (readResult.ok) {
        contents.push(`### Relevant memory: ${filePath}\n${readResult.value.content}`);
      }
    }

    if (contents.length === 0) return undefined;

    return {
      content: [
        {
          kind: "text",
          text: `## Relevant Memories (selected for this query)\n\n${contents.join("\n\n")}`,
        },
      ],
      senderId: "system:memory-relevant",
      timestamp: Date.now(),
    };
  }

  /** Prepends cached memory message(s) to the request. */
  function injectFrozenSnapshot(request: ModelRequest): ModelRequest {
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
      memoryManifest = [];
      frozenPaths = new Set();
      selectorNeeded = false;
    },

    describeCapabilities(): CapabilityFragment | undefined {
      if (memoryCount === 0) {
        return undefined;
      }
      const budget = config.recall.tokenBudget ?? 8000;
      const selectorNote = config.relevanceSelector !== undefined ? " + per-turn relevance" : "";
      return {
        label: "memory-recall",
        description: `${String(memoryCount)} memories recalled (${String(tokenCount)}/${String(budget)} tokens)${selectorNote}`,
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

      // Layer 1: frozen snapshot (stable prefix)
      let effectiveRequest = injectFrozenSnapshot(request);

      // Layer 2: per-turn relevance overlay (appended after frozen)
      if (config.relevanceSelector !== undefined) {
        try {
          const relevantMsg = await selectRelevant(request);
          if (relevantMsg !== undefined) {
            // Insert after frozen snapshot, before user messages
            const frozenCount = cachedMessage !== undefined ? 1 : 0;
            const messages = [...effectiveRequest.messages];
            messages.splice(frozenCount, 0, relevantMsg);
            effectiveRequest = { ...effectiveRequest, messages };
          }
        } catch (_e: unknown) {
          console.warn("[middleware-memory-recall] relevance selector failed (swallowed)");
        }
      }

      return next(effectiveRequest);
    },

    async *wrapModelStream(
      _ctx: TurnContext,
      request: ModelRequest,
      next: (request: ModelRequest) => AsyncIterable<ModelChunk>,
    ): AsyncIterable<ModelChunk> {
      if (!initialized) {
        await initialize();
      }

      let effectiveRequest = injectFrozenSnapshot(request);

      if (config.relevanceSelector !== undefined) {
        try {
          const relevantMsg = await selectRelevant(request);
          if (relevantMsg !== undefined) {
            const frozenCount = cachedMessage !== undefined ? 1 : 0;
            const messages = [...effectiveRequest.messages];
            messages.splice(frozenCount, 0, relevantMsg);
            effectiveRequest = { ...effectiveRequest, messages };
          }
        } catch (_e: unknown) {
          console.warn("[middleware-memory-recall] relevance selector failed (swallowed)");
        }
      }

      yield* next(effectiveRequest);
    },
  };
}
