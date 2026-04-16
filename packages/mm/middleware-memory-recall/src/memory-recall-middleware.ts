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

import { stat as fsStat } from "node:fs/promises";
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
  frozenPaths: ReadonlySet<string>;
  selectorNeeded: boolean;
  /** mtime of memory dir after frozen scan — skip re-scan when unchanged. */
  lastDirMtimeMs: number;
  /** Cached live delta message (new memories since frozen snapshot). */
  liveMessage: InboundMessage | undefined;
  /** Paths included in the live delta (for relevance exclusion). */
  livePaths: ReadonlySet<string>;
}

function createEmptyState(): SessionRecallState {
  return {
    cachedMessage: undefined,
    initialized: false,
    memoryCount: 0,
    tokenCount: 0,
    memoryManifest: [],
    frozenPaths: new Set(),
    selectorNeeded: false,
    lastDirMtimeMs: 0,
    liveMessage: undefined,
    livePaths: new Set(),
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

        state.frozenPaths = new Set(result.selected.map((s) => s.memory.record.filePath));
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
          filePath: m.record.filePath,
        }));
      }

      // Record dir mtime so the first wrapModelCall doesn't immediately re-scan.
      try {
        const dirStat = await fsStat(config.recall.memoryDir);
        state.lastDirMtimeMs = dirStat.mtimeMs;
      } catch {
        // Dir may not exist yet — leave at 0 so first turn triggers scan.
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
    const candidates = state.memoryManifest.filter((m) => !state.frozenPaths.has(m.filePath));
    if (candidates.length === 0) return undefined;

    const userMessage = extractUserMessage(request);
    if (userMessage.length === 0) return undefined;

    const selectedPaths = await selectRelevantMemories(
      candidates,
      userMessage,
      config.relevanceSelector,
    );

    if (selectedPaths.length === 0) return undefined;

    // Load selected memory files via scan (gets parsed MemoryRecord with frontmatter)
    const scanResult = await scanMemoryDirectory(config.fs, {
      memoryDir: config.recall.memoryDir,
    });
    const selectedSet = new Set(selectedPaths);
    const selectedMemories = scanResult.memories.filter((m) => selectedSet.has(m.record.filePath));

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

  /**
   * Check memory dir mtime and rebuild the live delta if changed.
   * The delta contains memories created/modified since the frozen snapshot.
   */
  async function refreshLiveDelta(state: SessionRecallState): Promise<void> {
    try {
      const dirStat = await fsStat(config.recall.memoryDir);
      if (dirStat.mtimeMs === state.lastDirMtimeMs) {
        return; // Nothing changed — reuse cached delta (or none).
      }
      state.lastDirMtimeMs = dirStat.mtimeMs;
    } catch {
      return; // Dir missing or unreadable — skip delta.
    }

    try {
      const scanResult = await scanMemoryDirectory(config.fs, {
        memoryDir: config.recall.memoryDir,
      });

      // Filter to memories NOT in the frozen snapshot.
      const newMemories = scanResult.memories.filter(
        (m) => !state.frozenPaths.has(m.record.filePath),
      );

      if (newMemories.length === 0) {
        state.liveMessage = undefined;
        state.livePaths = new Set();
        return;
      }

      // Wrap as ScoredMemory for the trusted formatter (score=1.0).
      const scored: readonly ScoredMemory[] = newMemories.map((m) => ({
        memory: m,
        salienceScore: 1.0,
        decayScore: 1.0,
        typeRelevance: 1.0,
      }));

      const formatted = formatMemorySection(scored, {
        sectionTitle: "Recently Added Memories",
        trustingRecallNote: true,
      });

      state.liveMessage = {
        content: [{ kind: "text", text: formatted }],
        senderId: "system:memory-live",
        timestamp: Date.now(),
      };
      state.livePaths = new Set(newMemories.map((m) => m.record.filePath));

      // Update manifest so relevance selector can consider new memories.
      const newManifestEntries: readonly MemoryManifestEntry[] = newMemories.map((m) => ({
        name: m.record.name,
        description: m.record.description,
        type: m.record.type,
        filePath: m.record.filePath,
      }));
      // Merge: keep existing manifest entries, add new ones (dedup by filePath).
      const existingPaths = new Set(state.memoryManifest.map((e) => e.filePath));
      const additions = newManifestEntries.filter((e) => !existingPaths.has(e.filePath));
      if (additions.length > 0) {
        state.memoryManifest = [...state.memoryManifest, ...additions];
      }
    } catch (_e: unknown) {
      console.warn("[middleware-memory-recall] refreshLiveDelta() failed (swallowed)");
    }
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
