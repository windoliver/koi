/**
 * Memory recall middleware — frozen snapshot + live delta + optional relevance.
 *
 * Three layers:
 *   1. Frozen snapshot (always): scans memory dir once at session start,
 *      scores by salience, budgets to token limit, caches as stable prefix.
 *   2. Live delta (per-turn): stats the memory dir, re-scans when mtime
 *      changes, injects new/changed memories after conversation history.
 *   3. Relevance overlay (optional): per-turn side-query asks a lightweight
 *      model to pick the N most relevant memories for the current message.
 *
 * The frozen snapshot preserves prompt cache (stable prefix). The live delta
 * and relevance overlay are appended after conversation history so they never
 * invalidate the cached prefix.
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
import type { ScannedMemory, ScoredMemory } from "@koi/memory";
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
  /**
   * updatedAt for EVERY memory file present at session start — not just the
   * frozen-snapshot subset. The live delta uses this as the baseline: a
   * record qualifies for injection only if its path isn't in this map
   * (new file) or its updatedAt exceeds the recorded value (in-place
   * overwrite). Without this, truncated sessions where the frozen snapshot
   * is a subset of the full memory set would pull pre-existing overflow
   * memories into the "Recently Added Memories" delta on the next write.
   */
  sessionStartMtimes: ReadonlyMap<string, number>;
  selectorNeeded: boolean;
  /** Fingerprint of last directory listing — skip re-scan when unchanged. */
  lastListFingerprint: string;
  /** Cached live delta message (new/modified memories since frozen snapshot). */
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
    sessionStartMtimes: new Map(),
    selectorNeeded: false,
    lastListFingerprint: "",
    liveMessage: undefined,
    livePaths: new Set(),
  };
}

/**
 * Compute a fingerprint of the memory directory listing.
 *
 * Uses `FileSystemBackend.list()` with the same recursive `**\/*.md` options
 * as `scanMemoryDirectory()` so the two stay in sync — any file the scan
 * would see, the fingerprint sees too. Builds a stable string from sorted
 * `(path, modifiedAt)` pairs. Any added, removed, or modified file changes
 * the fingerprint.
 *
 * Returns "" on any error OR when the backend reports `truncated: true`
 * (fail-open: force a rescan because we cannot trust a partial listing).
 */
async function computeListFingerprint(
  fs: MemoryRecallMiddlewareConfig["fs"],
  memoryDir: string,
): Promise<string> {
  try {
    const result = fs.list(memoryDir, { glob: "**/*.md", recursive: true });
    const settled = await Promise.resolve(result);
    if (!settled.ok) return "";
    if (settled.value.truncated) return ""; // fail-open on partial listings
    const entries = [...settled.value.entries]
      .filter((e) => e.path.endsWith(".md"))
      .map((e) => `${e.path}:${String(e.modifiedAt ?? 0)}`)
      .sort();
    return entries.join("|");
  } catch {
    return "";
  }
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

      // Always scan the full memory dir at init to build the session-start
      // baseline. This is used by refreshLiveDelta to answer "what is new
      // since session start" — critical for truncated sessions where the
      // frozen snapshot is a subset of all memories on disk.
      //
      // Also populates the manifest for the relevance selector if configured.
      const scanResult = await scanMemoryDirectory(config.fs, {
        memoryDir: config.recall.memoryDir,
      });
      state.sessionStartMtimes = new Map(
        scanResult.memories.map((m) => [m.record.filePath, m.record.updatedAt]),
      );

      if (config.relevanceSelector !== undefined && result.truncated) {
        state.selectorNeeded = true;
        state.memoryManifest = scanResult.memories.map((m) => ({
          name: m.record.name,
          description: m.record.description,
          type: m.record.type,
          filePath: m.record.filePath,
        }));
      }

      // Record listing fingerprint so the first wrapModelCall doesn't
      // immediately re-scan. Uses config.fs.list() — abstracts over backend
      // so the middleware works with non-local FileSystemBackend implementations.
      state.lastListFingerprint = await computeListFingerprint(config.fs, config.recall.memoryDir);
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

    // Only select from memories NOT already in the frozen snapshot or live delta
    const candidates = state.memoryManifest.filter(
      (m) => !state.frozenPaths.has(m.filePath) && !state.livePaths.has(m.filePath),
    );
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
   * Token budget for the live delta. Defaults to 4000 tokens — prevents
   * a chatty session from dumping tens of thousands of tokens of freshly
   * stored memories into every subsequent turn. Memories are sorted by
   * recency (updatedAt desc) and packed until the budget is hit.
   */
  const liveDeltaBudget = config.liveDeltaMaxTokens ?? 4000;

  /**
   * Check the memory directory listing fingerprint and rebuild the live
   * delta if any file was added, removed, or modified.
   *
   * The delta contains memories that appeared OR were modified since
   * session start — diffed against `sessionStartMtimes` which snapshots
   * every memory file at init, not just the frozen subset. Using the full
   * baseline is critical for truncated sessions: otherwise pre-existing
   * overflow memories (on disk at session start but not frozen) would be
   * misclassified as "recently added" on the first subsequent write.
   *
   * A memory qualifies when either:
   *  - Its filePath is not in sessionStartMtimes (genuinely new file), or
   *  - Its updatedAt exceeds the recorded mtime (in-place overwrite —
   *    `memory_store` with `force: true` reuses the same filePath).
   *
   * The delta is token-budgeted (liveDeltaBudget) to prevent a chatty
   * session from crowding out the conversation.
   */
  async function refreshLiveDelta(state: SessionRecallState): Promise<void> {
    const fingerprint = await computeListFingerprint(config.fs, config.recall.memoryDir);
    if (fingerprint === state.lastListFingerprint && fingerprint !== "") {
      return; // Nothing changed — reuse cached delta (or none).
    }
    state.lastListFingerprint = fingerprint;

    try {
      const scanResult = await scanMemoryDirectory(config.fs, {
        memoryDir: config.recall.memoryDir,
      });

      // Include memories that are new or were modified since session start.
      // Diff against sessionStartMtimes (the FULL baseline), not frozenPaths —
      // otherwise overflow memories would be pulled into the delta on first
      // write.
      const changedMemories = scanResult.memories.filter((m) => {
        const path = m.record.filePath;
        const baseline = state.sessionStartMtimes.get(path);
        if (baseline === undefined) return true; // genuinely new file
        return m.record.updatedAt > baseline; // in-place overwrite
      });

      if (changedMemories.length === 0) {
        state.liveMessage = undefined;
        state.livePaths = new Set();
        return;
      }

      // Budget-pack: sort by recency desc, include memories until we'd
      // exceed liveDeltaBudget. The oldest new memories drop off first.
      const byRecency = [...changedMemories].sort(
        (a, b) => b.record.updatedAt - a.record.updatedAt,
      );
      const packed: ScannedMemory[] = [];
      // let — accumulator for token budget packing
      let packedTokens = 0;
      for (const m of byRecency) {
        // Approximate per-memory tokens from content + name + description.
        const approxTokens = estimateTokens(
          `${m.record.name}\n${m.record.description}\n${m.record.content}`,
        );
        if (packed.length > 0 && packedTokens + approxTokens > liveDeltaBudget) {
          break; // Adding this would exceed budget — stop (keep what fits).
        }
        packed.push(m);
        packedTokens += approxTokens;
      }

      if (packed.length === 0) {
        state.liveMessage = undefined;
        state.livePaths = new Set();
        return;
      }

      // Wrap as ScoredMemory for the trusted formatter (score=1.0).
      const scored: readonly ScoredMemory[] = packed.map((m) => ({
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
      state.livePaths = new Set(packed.map((m) => m.record.filePath));

      // Update manifest so relevance selector can consider new memories.
      const newManifestEntries: readonly MemoryManifestEntry[] = packed.map((m) => ({
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

      // 1. Frozen snapshot — prepend (prefix-stable).
      let effectiveRequest = injectFrozenSnapshot(state, request);

      // 2. Live delta — check mtime, scan if changed, append after conversation.
      await refreshLiveDelta(state);
      if (state.liveMessage !== undefined) {
        effectiveRequest = {
          ...effectiveRequest,
          messages: [...effectiveRequest.messages, state.liveMessage],
        };
      }

      // 3. Relevance overlay — append after delta.
      if (config.relevanceSelector !== undefined) {
        try {
          const relevantMsg = await selectRelevant(state, request);
          if (relevantMsg !== undefined) {
            effectiveRequest = {
              ...effectiveRequest,
              messages: [...effectiveRequest.messages, relevantMsg],
            };
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

      // 1. Frozen snapshot — prepend (prefix-stable).
      let effectiveRequest = injectFrozenSnapshot(state, request);

      // 2. Live delta — check mtime, scan if changed, append after conversation.
      await refreshLiveDelta(state);
      if (state.liveMessage !== undefined) {
        effectiveRequest = {
          ...effectiveRequest,
          messages: [...effectiveRequest.messages, state.liveMessage],
        };
      }

      // 3. Relevance overlay — append after delta.
      if (config.relevanceSelector !== undefined) {
        try {
          const relevantMsg = await selectRelevant(state, request);
          if (relevantMsg !== undefined) {
            effectiveRequest = {
              ...effectiveRequest,
              messages: [...effectiveRequest.messages, relevantMsg],
            };
          }
        } catch (_e: unknown) {
          console.warn("[middleware-memory-recall] relevance selector failed (swallowed)");
        }
      }

      yield* next(effectiveRequest);
    },
  };
}
