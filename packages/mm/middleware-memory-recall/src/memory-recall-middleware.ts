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
  SessionId,
  TurnContext,
} from "@koi/core";
import type { ScoredMemory } from "@koi/memory";
import { formatMemorySection, recallMemories, scanMemoryDirectory } from "@koi/memory";
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
/** Per-session recall state — keyed by sessionId to prevent cross-session bleed. */
interface SessionRecallState {
  cachedMessage: InboundMessage | undefined;
  initialized: boolean;
  memoryCount: number;
  tokenCount: number;
  memoryManifest: readonly MemoryManifestEntry[];
  frozenIds: ReadonlySet<string>;
  selectorNeeded: boolean;
}

function createEmptyState(): SessionRecallState {
  return {
    cachedMessage: undefined,
    initialized: false,
    memoryCount: 0,
    tokenCount: 0,
    memoryManifest: [],
    frozenIds: new Set(),
    selectorNeeded: false,
  };
}

export function createMemoryRecallMiddleware(config: MemoryRecallMiddlewareConfig): KoiMiddleware {
  // Per-session state map — prevents cross-session bleed when a single
  // middleware instance serves multiple concurrent sessions or child agents.
  const sessions = new Map<SessionId, SessionRecallState>();
  // let justified: current session ID, set in onSessionStart, read in wrapModelCall
  let activeSessionId: SessionId | undefined;

  function getState(sessionId: SessionId): SessionRecallState {
    const existing = sessions.get(sessionId);
    if (existing !== undefined) return existing;
    const fresh = createEmptyState();
    sessions.set(sessionId, fresh);
    return fresh;
  }

  /**
   * Runs the recall pipeline exactly once. Sets initialized = true regardless
   * of outcome so that failures are not retried.
   *
   * Also builds the memory manifest for per-turn relevance selection.
   */
  async function initialize(state: SessionRecallState): Promise<void> {
    state.initialized = true;

    try {
      const result = await recallMemories(config.fs, config.recall);

      if (result.formatted.length > 0) {
        state.memoryCount = result.selected.length;
        state.tokenCount = estimateTokens(result.formatted);

        state.cachedMessage = {
          content: [{ kind: "text", text: result.formatted }],
          senderId: "system:memory-recall",
          timestamp: Date.now(),
        };

        state.frozenIds = new Set(result.selected.map((s) => s.memory.record.id));
      }

      if (config.relevanceSelector !== undefined && result.truncated) {
        state.selectorNeeded = true;
        const scanResult = await scanMemoryDirectory(config.fs, {
          memoryDir: config.recall.memoryDir,
        });
        state.memoryManifest = scanResult.memories.map((m) => ({
          name: m.record.name,
          description: m.record.description,
          type: m.record.type,
          id: m.record.id,
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
  /**
   * Token budget for the relevance overlay. Defaults to 4000 tokens —
   * half the frozen snapshot budget — to prevent crowding the context.
   */
  const relevanceBudget = config.relevanceSelector?.maxTokens ?? 4000;

  async function selectRelevant(
    state: SessionRecallState,
    request: ModelRequest,
  ): Promise<InboundMessage | undefined> {
    if (
      !state.selectorNeeded ||
      config.relevanceSelector === undefined ||
      state.memoryManifest.length === 0
    ) {
      return undefined;
    }

    // Only select from memories NOT already in the frozen snapshot
    const candidates = state.memoryManifest.filter((m) => !state.frozenIds.has(m.id));
    if (candidates.length === 0) return undefined;

    const userMessage = extractUserMessage(request);
    if (userMessage.length === 0) return undefined;

    const selectedIds = await selectRelevantMemories(
      candidates,
      userMessage,
      config.relevanceSelector,
    );

    if (selectedIds.length === 0) return undefined;

    // Load selected memory files via scan (gets parsed MemoryRecord with frontmatter)
    const scanResult = await scanMemoryDirectory(config.fs, {
      memoryDir: config.recall.memoryDir,
    });
    const selectedSet = new Set(selectedIds);
    const selectedMemories = scanResult.memories.filter((m) => selectedSet.has(m.record.id));

    if (selectedMemories.length === 0) return undefined;

    // Wrap as ScoredMemory for the trusted formatter (score=1.0 — all are relevant)
    const scored: readonly ScoredMemory[] = selectedMemories.map((m) => ({
      memory: m,
      salienceScore: 1.0,
      decayScore: 1.0,
      typeRelevance: 1.0,
    }));

    // Format through the SAME trusted path as the frozen snapshot:
    // <memory-data> escaping, JSON metadata serialization, static headings
    const formatted = formatMemorySection(scored, {
      sectionTitle: "Relevant Memories (selected for this query)",
      trustingRecallNote: true,
    });

    // Enforce token budget — skip if overlay would exceed limit
    const overlayTokens = estimateTokens(formatted);
    if (overlayTokens > relevanceBudget) {
      return undefined;
    }

    return {
      content: [{ kind: "text", text: formatted }],
      senderId: "system:memory-relevant",
      timestamp: Date.now(),
    };
  }

  /** Prepends cached memory message(s) to the request. */
  function injectFrozenSnapshot(state: SessionRecallState, request: ModelRequest): ModelRequest {
    if (state.cachedMessage === undefined) {
      return request;
    }
    return { ...request, messages: [state.cachedMessage, ...request.messages] };
  }

  return {
    name: "koi:memory-recall",
    priority: 310,

    async onSessionStart(ctx: SessionContext): Promise<void> {
      activeSessionId = ctx.sessionId;
      // Clear previous state for this session (fresh recall on next model call)
      sessions.delete(ctx.sessionId);
    },

    describeCapabilities(): CapabilityFragment | undefined {
      const state = activeSessionId !== undefined ? sessions.get(activeSessionId) : undefined;
      if (state === undefined || state.memoryCount === 0) {
        return undefined;
      }
      const budget = config.recall.tokenBudget ?? 8000;
      const selectorNote = config.relevanceSelector !== undefined ? " + per-turn relevance" : "";
      return {
        label: "memory-recall",
        description: `${String(state.memoryCount)} memories recalled (${String(state.tokenCount)}/${String(budget)} tokens)${selectorNote}`,
      };
    },

    async wrapModelCall(
      ctx: TurnContext,
      request: ModelRequest,
      next: (request: ModelRequest) => Promise<ModelResponse>,
    ): Promise<ModelResponse> {
      activeSessionId = ctx.session.sessionId;
      const state = getState(ctx.session.sessionId);
      if (!state.initialized) {
        await initialize(state);
      }

      let effectiveRequest = injectFrozenSnapshot(state, request);

      if (config.relevanceSelector !== undefined) {
        try {
          const relevantMsg = await selectRelevant(state, request);
          if (relevantMsg !== undefined) {
            const messages = [...effectiveRequest.messages, relevantMsg];
            effectiveRequest = { ...effectiveRequest, messages };
          }
        } catch (_e: unknown) {
          console.warn("[middleware-memory-recall] relevance selector failed (swallowed)");
        }
      }

      return next(effectiveRequest);
    },

    async *wrapModelStream(
      ctx: TurnContext,
      request: ModelRequest,
      next: (request: ModelRequest) => AsyncIterable<ModelChunk>,
    ): AsyncIterable<ModelChunk> {
      activeSessionId = ctx.session.sessionId;
      const state = getState(ctx.session.sessionId);
      if (!state.initialized) {
        await initialize(state);
      }

      let effectiveRequest = injectFrozenSnapshot(state, request);

      if (config.relevanceSelector !== undefined) {
        try {
          const relevantMsg = await selectRelevant(state, request);
          if (relevantMsg !== undefined) {
            const messages = [...effectiveRequest.messages, relevantMsg];
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
