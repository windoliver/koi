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
   * Per-file signatures (mtime + size) for EVERY memory file present at
   * session start — not just the frozen-snapshot subset. The live delta
   * uses this as the baseline: a record qualifies for injection only if
   * its path isn't in this map (new file) OR its signature differs from
   * the recorded value (in-place overwrite).
   *
   * Size is part of the signature because `@koi/memory-fs` update() does
   * atomic write+rename+utimes, stamping mtime back to the original
   * createdAt to preserve it across updates. So mtime alone cannot detect
   * in-place overwrites via the standard store. Size reliably changes for
   * any real content change.
   */
  sessionStartSignatures: ReadonlyMap<string, FileSignature>;
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
    sessionStartSignatures: new Map(),
    selectorNeeded: false,
    lastListFingerprint: "",
    liveMessage: undefined,
    livePaths: new Set(),
  };
}

/**
 * Per-file signature used both for the directory fingerprint and the
 * session-start baseline. Combines `modifiedAt` (mtime) and `size` so
 * that an in-place overwrite is detected even when the backing store
 * resets mtime to preserve createdAt (e.g. `@koi/memory-fs` update()
 * does atomic write+rename+utimes, stamping mtime back to the original
 * creation time). Size typically differs for any real content change.
 */
interface FileSignature {
  readonly modifiedAt: number;
  readonly size: number;
}

function signatureChanged(a: FileSignature, b: FileSignature): boolean {
  return a.modifiedAt !== b.modifiedAt || a.size !== b.size;
}

function signatureKey(s: FileSignature): string {
  return `${String(s.modifiedAt)}:${String(s.size)}`;
}

/**
 * List the memory directory and return a map of relative paths to
 * per-file signatures. Used for the session-start baseline (uncapped —
 * must include EVERY memory file, not just the newest 200) and also as
 * the source of the per-turn fingerprint.
 *
 * Returns undefined on any error or truncation (fail-open: callers
 * treat this as "cannot trust listing, force rescan").
 *
 * Paths are stored relative to `memoryDir` so keys match what
 * `scanMemoryDirectory()` surfaces via `record.filePath`.
 */
async function listFileSignatures(
  fs: MemoryRecallMiddlewareConfig["fs"],
  memoryDir: string,
): Promise<ReadonlyMap<string, FileSignature> | undefined> {
  try {
    const result = fs.list(memoryDir, { glob: "**/*.md", recursive: true });
    const settled = await Promise.resolve(result);
    if (!settled.ok) return undefined;
    if (settled.value.truncated) return undefined;
    const base = `${memoryDir.replace(/\\/g, "/").replace(/\/$/, "")}/`;
    const out = new Map<string, FileSignature>();
    for (const entry of settled.value.entries) {
      if (!entry.path.endsWith(".md")) continue;
      if (entry.kind !== "file") continue;
      const normalized = entry.path.replace(/\\/g, "/");
      if (!normalized.startsWith(base)) continue;
      const relative = normalized.slice(base.length);
      if (relative.length === 0) continue;
      out.set(relative, {
        modifiedAt: entry.modifiedAt ?? 0,
        size: entry.size ?? 0,
      });
    }
    return out;
  } catch {
    return undefined;
  }
}

/**
 * Compute a stable fingerprint from a signature map. Any added, removed,
 * or modified file (mtime OR size change) produces a different string.
 */
function fingerprintSignatures(sigs: ReadonlyMap<string, FileSignature>): string {
  const entries = [...sigs.entries()].map(([path, sig]) => `${path}:${signatureKey(sig)}`).sort();
  return entries.join("|");
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

      // Build the session-start baseline from an UNCAPPED list() — must
      // include every memory file, not just the newest 200 (scan's default
      // maxFiles). Without the full baseline, pre-existing overflow
      // memories would be misclassified as "recently added" on the first
      // subsequent write.
      const signatures = await listFileSignatures(config.fs, config.recall.memoryDir);
      if (signatures !== undefined) {
        state.sessionStartSignatures = signatures;
        state.lastListFingerprint = fingerprintSignatures(signatures);
      }

      if (config.relevanceSelector !== undefined && result.truncated) {
        state.selectorNeeded = true;
        // Scan for the manifest (needs parsed frontmatter — name/description/type).
        // Separate from the signature baseline which needs only metadata.
        const scanResult = await scanMemoryDirectory(config.fs, {
          memoryDir: config.recall.memoryDir,
          // Use a large cap to cover the full directory for the manifest.
          maxFiles: Number.MAX_SAFE_INTEGER,
        });
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
    const currentSigs = await listFileSignatures(config.fs, config.recall.memoryDir);
    if (currentSigs === undefined) {
      // Listing failed or was truncated — fail-open: force a rescan on
      // next turn by invalidating the cache.
      state.lastListFingerprint = "";
      return;
    }
    const fingerprint = fingerprintSignatures(currentSigs);
    if (fingerprint === state.lastListFingerprint) {
      return; // Nothing changed — reuse cached delta (or none).
    }
    // Update cache before scanning — on interleaved turns, a failing scan
    // will still leave the fingerprint advanced so we don't loop trying
    // the same broken state repeatedly.
    state.lastListFingerprint = fingerprint;

    try {
      const scanResult = await scanMemoryDirectory(config.fs, {
        memoryDir: config.recall.memoryDir,
        // Use a large cap so truncated dirs don't hide real memories from
        // the delta. Scan defaults to 200 which is the index cap, not a
        // fundamental limit on stored memories.
        maxFiles: Number.MAX_SAFE_INTEGER,
      });

      // Include memories that are NEW (absent from baseline) or whose
      // signature (mtime + size) differs from session start. Using both
      // fields catches in-place overwrites via memory-fs update() which
      // stamps mtime back to createdAt but changes content size.
      const changedMemories = scanResult.memories.filter((m) => {
        const path = m.record.filePath;
        const baseline = state.sessionStartSignatures.get(path);
        if (baseline === undefined) return true; // genuinely new file
        const current = currentSigs.get(path);
        if (current === undefined) return false; // listed but vanished — skip
        return signatureChanged(current, baseline);
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
      const byRecency = [...changedMemories].sort(
        (a, b) => b.record.updatedAt - a.record.updatedAt,
      );
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
