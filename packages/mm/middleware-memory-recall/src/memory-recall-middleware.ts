/**
 * Memory recall middleware — frozen snapshot + live delta + optional relevance.
 *
 * Three layers:
 *   1. Frozen snapshot (always): scans memory dir once at session start,
 *      scores by salience, budgets to token limit, caches as stable prefix.
 *   2. Live delta (per-turn): rescans memory dir each turn, computes a
 *      content-hash signature per file, compares against the session-start
 *      baseline. New files or changed content emit the new "system:memory-live"
 *      block. Content hashing (not mtime) is required because @koi/memory-fs
 *      update() preserves mtime to keep createdAt stable.
 *   3. Relevance overlay (optional): per-turn side-query asks a lightweight
 *      model to pick the N most relevant memories for the current message.
 *
 * The frozen snapshot preserves prompt cache (stable prefix). The live delta
 * and relevance overlay are INSERTED BEFORE the last user message so the new
 * memory arrives as prior context, not as a post-hoc instruction, while
 * keeping the prefix (system prompt + frozen snapshot + prior conversation)
 * untouched for cache hits.
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
   * Content-hash signatures for EVERY memory file present at session
   * start — not just the frozen-snapshot subset. The live delta uses
   * this as the baseline: a record qualifies for injection only if its
   * path isn't in this map (new file) OR its content hash differs from
   * the recorded value (in-place overwrite).
   *
   * Content hash (not mtime) because `@koi/memory-fs.update()` stamps
   * mtime back to preserve createdAt — size-preserving overwrites
   * ("blue" -> "pink") would be undetectable otherwise.
   */
  sessionStartSignatures: ReadonlyMap<string, FileSignature>;
  selectorNeeded: boolean;
  /**
   * Per-path timestamp of when the middleware first OBSERVED the path
   * as changed (new or modified). Used to rank changed memories under
   * token-budget pressure: we cannot trust `record.updatedAt` because
   * scanMemoryDirectory populates it from file mtime, which memory-fs
   * deliberately preserves across updates. Our observation time is the
   * most reliable monotonic mutation signal available without L0
   * changes to FileSystemBackend.
   */
  detectedAt: Map<string, number>;
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
    sessionStartSignatures: new Map(),
    selectorNeeded: false,
    detectedAt: new Map(),
    liveMessage: undefined,
    livePaths: new Set(),
  };
}

/**
 * Per-file signature — the scan result's full content hash plus size.
 *
 * Uses a content hash (not mtime) because `@koi/memory-fs.update()` does
 * atomic write+rename+utimes, stamping mtime back to the original
 * creation time to preserve createdAt. That means mtime alone — and
 * even mtime+size — miss same-size in-place overwrites like "blue" ->
 * "pink". The content hash detects any change, regardless of what the
 * store does with stat metadata.
 *
 * The hash is a cheap FNV-1a over the parsed content string. Collisions
 * are effectively impossible for natural text; an adversarial user
 * would have to construct a specific pre-image, which is out of scope
 * for a local-memory middleware.
 */
interface FileSignature {
  readonly hash: number;
  readonly size: number;
}

function signatureChanged(a: FileSignature, b: FileSignature): boolean {
  return a.hash !== b.hash || a.size !== b.size;
}

/**
 * FNV-1a 32-bit hash — fast, stable, no dependencies. Sufficient for
 * change detection on small text files (~1-10KB per memory record).
 */
function fnv1a(text: string): number {
  // let — classic FNV-1a accumulator loop
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function signatureFromContent(content: string): FileSignature {
  return { hash: fnv1a(content), size: content.length };
}

/**
 * Build a session-start signature baseline from a scan result.
 *
 * The scan already reads every memory file's content (to parse
 * frontmatter), so computing a content hash per record is free.
 */
function buildSignatureBaseline(
  memories: readonly ScannedMemory[],
): ReadonlyMap<string, FileSignature> {
  const out = new Map<string, FileSignature>();
  for (const m of memories) {
    out.set(m.record.filePath, signatureFromContent(m.record.content));
  }
  return out;
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

      // Build the session-start baseline from an UNCAPPED scan — must
      // include every memory file, not just the newest 200 (scan's default
      // maxFiles). Content hashes are computed from the parsed content so
      // same-size, mtime-preserving overwrites are still detectable.
      const scanResult = await scanMemoryDirectory(config.fs, {
        memoryDir: config.recall.memoryDir,
        maxFiles: Number.MAX_SAFE_INTEGER,
      });
      state.sessionStartSignatures = buildSignatureBaseline(scanResult.memories);

      if (config.relevanceSelector !== undefined && result.truncated) {
        state.selectorNeeded = true;
        state.memoryManifest = scanResult.memories.map((m) => ({
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
   * Insert a memory block into the request BEFORE the final user message.
   *
   * Canonical order: frozen snapshot → prior conversation → live delta →
   * relevance overlay → current user message. Appending after the user
   * turn breaks the semantic: providers treat the privileged
   * `system:memory-*` block as an instruction that arrives AFTER the
   * user's question, which either gets ignored as too late or overrides
   * the user's intent. Injecting before the last user message keeps
   * dynamic memory as prior context for the current turn.
   *
   * Falls back to appending if no user message is found (shouldn't happen
   * in practice, but the middleware must not lose context).
   */
  function insertBeforeLastUser(request: ModelRequest, block: InboundMessage): ModelRequest {
    const messages = request.messages;
    // Walk from the end to find the last user message.
    // let justified: reverse-iteration cursor for the insert position.
    let insertAt = messages.length;
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg === undefined) continue;
      if (msg.senderId === "user" || msg.senderId?.startsWith("user") === true) {
        insertAt = i;
        break;
      }
    }
    const next = [...messages.slice(0, insertAt), block, ...messages.slice(insertAt)];
    return { ...request, messages: next };
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
    try {
      // Always scan. Content hashing requires reading file content, which
      // is what scan does anyway. An optimization to gate on cheap metadata
      // (list size/mtime) would miss same-size mtime-preserving overwrites
      // — the exact case memory-fs.update() produces. Always-scan is
      // correct and costs one scan per turn (~ms on local FS for ~dozens
      // of files). For very large memory dirs this could be added as a
      // fast-path, but correctness comes first.
      const scanResult = await scanMemoryDirectory(config.fs, {
        memoryDir: config.recall.memoryDir,
        // Uncapped: truncated listings would hide real memories from delta.
        maxFiles: Number.MAX_SAFE_INTEGER,
      });

      // Include memories that are NEW (absent from baseline) or whose
      // content-hash signature differs from session start. Hashing the
      // content survives mtime preservation AND size preservation.
      const now = Date.now();
      const changedMemories = scanResult.memories.filter((m) => {
        const path = m.record.filePath;
        const baseline = state.sessionStartSignatures.get(path);
        const current = signatureFromContent(m.record.content);
        if (baseline === undefined) {
          // Genuinely new file — record first-observation time for ranking.
          if (!state.detectedAt.has(path)) state.detectedAt.set(path, now);
          return true;
        }
        if (signatureChanged(current, baseline)) {
          if (!state.detectedAt.has(path)) state.detectedAt.set(path, now);
          return true;
        }
        // Signature matches baseline — unchanged.
        return false;
      });

      if (changedMemories.length === 0) {
        state.liveMessage = undefined;
        state.livePaths = new Set();
        return;
      }

      // Budget-pack: sort by recency desc, include memories until the
      // fully-formatted section would exceed liveDeltaBudget. Unlike the
      // previous loop, a single oversized memory is NOT granted a budget
      // bypass — if even one memory exceeds the cap on its own, we stop
      // including anything (caller should raise liveDeltaMaxTokens or
      // split the memory). This also re-measures after formatting, which
      // accounts for section headers, XML boundary tags, and metadata
      // JSON that `estimateTokens(content)` alone misses.
      // Rank by OUR observation time, not record.updatedAt. record.updatedAt
      // comes from file mtime and is stale for mtime-preserving stores —
      // a freshly-corrected old memory would rank as ancient. detectedAt
      // is the true "middleware first saw this change" time: monotonic,
      // backend-independent, and reflects mutation ordering.
      const rankOf = (m: ScannedMemory): number =>
        state.detectedAt.get(m.record.filePath) ?? m.record.updatedAt;
      const byRecency = [...changedMemories].sort((a, b) => rankOf(b) - rankOf(a));
      const packed: ScannedMemory[] = [];
      // let — accumulator built by incrementally adding memories and
      // re-measuring the formatted output against the budget.
      let formatted = "";
      for (const m of byRecency) {
        const candidate = [...packed, m];
        const candidateScored: readonly ScoredMemory[] = candidate.map((sm) => ({
          memory: sm,
          salienceScore: 1.0,
          decayScore: 1.0,
          typeRelevance: 1.0,
        }));
        const candidateFormatted = formatMemorySection(candidateScored, {
          sectionTitle: "Recently Added Memories",
          trustingRecallNote: true,
        });
        if (estimateTokens(candidateFormatted) > liveDeltaBudget) {
          break; // Adding this would exceed the cap — stop.
        }
        packed.push(m);
        formatted = candidateFormatted;
      }

      if (packed.length === 0 || formatted.length === 0) {
        // Nothing fits (even a single memory exceeds the budget).
        // Leave the cached delta cleared and enable the relevance selector
        // so overflow remains reachable.
        state.liveMessage = undefined;
        state.livePaths = new Set();
        if (
          changedMemories.length > 0 &&
          config.relevanceSelector !== undefined &&
          !state.selectorNeeded
        ) {
          state.selectorNeeded = true;
        }
        // Fall through: still update manifest below so overflow is
        // selectable later.
        const allChangedEntries: readonly MemoryManifestEntry[] = changedMemories.map((m) => ({
          name: m.record.name,
          description: m.record.description,
          type: m.record.type,
          filePath: m.record.filePath,
        }));
        const existingPaths0 = new Set(state.memoryManifest.map((e) => e.filePath));
        const additions0 = allChangedEntries.filter((e) => !existingPaths0.has(e.filePath));
        if (additions0.length > 0) {
          state.memoryManifest = [...state.memoryManifest, ...additions0];
        }
        return;
      }

      state.liveMessage = {
        content: [{ kind: "text", text: formatted }],
        senderId: "system:memory-live",
        timestamp: Date.now(),
      };
      state.livePaths = new Set(packed.map((m) => m.record.filePath));

      // Merge ALL changed memories (not just the packed subset) into the
      // manifest so truncated overflow stays reachable via the relevance
      // selector. Without this, a memory that falls past the delta's
      // token cap would silently disappear until the next session.
      const allChangedEntries: readonly MemoryManifestEntry[] = changedMemories.map((m) => ({
        name: m.record.name,
        description: m.record.description,
        type: m.record.type,
        filePath: m.record.filePath,
      }));
      const existingPaths = new Set(state.memoryManifest.map((e) => e.filePath));
      const additions = allChangedEntries.filter((e) => !existingPaths.has(e.filePath));
      if (additions.length > 0) {
        state.memoryManifest = [...state.memoryManifest, ...additions];
      }

      // If the delta was truncated by the budget, enable the relevance
      // selector so the dropped memories remain reachable (they're in
      // memoryManifest but not in livePaths, so the selector's candidate
      // filter will include them on this and subsequent turns).
      if (
        packed.length < changedMemories.length &&
        config.relevanceSelector !== undefined &&
        !state.selectorNeeded
      ) {
        state.selectorNeeded = true;
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

      // Final order: frozen snapshot → prior conversation → live delta →
      // relevance overlay → current user message.
      // 1. Frozen snapshot — prepend (prefix-stable).
      let effectiveRequest = injectFrozenSnapshot(state, request);

      // 2. Live delta — insert BEFORE the last user message so the new
      //    memory arrives as prior context, not as a post-hoc instruction.
      await refreshLiveDelta(state);
      if (state.liveMessage !== undefined) {
        effectiveRequest = insertBeforeLastUser(effectiveRequest, state.liveMessage);
      }

      // 3. Relevance overlay — insert before last user, after live delta.
      if (config.relevanceSelector !== undefined) {
        try {
          const relevantMsg = await selectRelevant(state, request);
          if (relevantMsg !== undefined) {
            effectiveRequest = insertBeforeLastUser(effectiveRequest, relevantMsg);
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

      // Final order: frozen snapshot → prior conversation → live delta →
      // relevance overlay → current user message.
      // 1. Frozen snapshot — prepend (prefix-stable).
      let effectiveRequest = injectFrozenSnapshot(state, request);

      // 2. Live delta — insert BEFORE the last user message.
      await refreshLiveDelta(state);
      if (state.liveMessage !== undefined) {
        effectiveRequest = insertBeforeLastUser(effectiveRequest, state.liveMessage);
      }

      // 3. Relevance overlay — insert before last user, after live delta.
      if (config.relevanceSelector !== undefined) {
        try {
          const relevantMsg = await selectRelevant(state, request);
          if (relevantMsg !== undefined) {
            effectiveRequest = insertBeforeLastUser(effectiveRequest, relevantMsg);
          }
        } catch (_e: unknown) {
          console.warn("[middleware-memory-recall] relevance selector failed (swallowed)");
        }
      }

      yield* next(effectiveRequest);
    },
  };
}
