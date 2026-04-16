/**
 * Memory recall middleware — frozen snapshot + live delta + optional relevance.
 *
 * Three layers:
 *   1. Frozen snapshot (always): single atomic scan at session start derives
 *      both the formatted snapshot AND the per-file signature baseline used
 *      by the live delta. Prepended to messages — part of the cached prefix.
 *   2. Live delta (per-turn): rescans memory dir each turn, hashes the full
 *      record (name + description + type + content), compares against the
 *      session-start baseline. New files or changed records emit a
 *      "system:memory-live" block INSERTED BEFORE the last user message.
 *      When a delta entry's path collides with a frozen-snapshot entry,
 *      the section title makes precedence explicit ("these supersede
 *      same-name entries above").
 *   3. Relevance overlay (optional): per-turn side-query asks a lightweight
 *      model to pick the N most relevant memories for the current message.
 *      Also inserted before the last user message.
 *
 * Message order on a turn with a live delta:
 *   [frozen snapshot, prior conversation..., live delta, relevance, current user]
 *
 * Why before-user (not appended at the end): the session transcript
 * middleware records `request.messages.at(-1)` as the inbound user turn.
 * Appending memory blocks at the end would replace the user message in
 * the persisted transcript, losing user input on resume/replay. We accept
 * a partial cache miss (memory blocks land mid-conversation) for
 * correctness on resume.
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
import { memoryRecordId, parseMemoryFrontmatter, validateMemoryFilePath } from "@koi/core/memory";
import type { ScannedMemory, ScoredMemory } from "@koi/memory";
import {
  formatMemorySection,
  scanMemoryDirectory,
  scoreMemories,
  selectWithinBudget,
} from "@koi/memory";
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
  liveIds: ReadonlySet<string>;
  /**
   * Paths that exist in `frozenIds` AND were observed as changed
   * mid-session. The frozen snapshot now contains stale data for these
   * paths. The relevance selector must be ALLOWED to pick them up
   * (overriding the normal "exclude frozen" rule) so a budget-truncated
   * overwrite can still reach the model. Without this, an overwrite
   * that doesn't fit in the live delta becomes unreachable for the
   * rest of the session — the agent keeps seeing the stale frozen copy.
   */
  staleFrozenIds: Set<string>;
  /**
   * Last seen fs.list() fingerprint (path+mtime+size hash). Fast-path
   * gate: if this turn's fingerprint matches, the directory looks
   * unchanged and we skip the expensive full scan. Set to "" to force
   * a rescan on the next turn (e.g., after init or fingerprint failure).
   */
  lastListFingerprint: string;
}

function createEmptyState(): SessionRecallState {
  return {
    cachedMessage: undefined,
    initialized: false,
    memoryCount: 0,
    tokenCount: 0,
    memoryManifest: [],
    frozenIds: new Set(),
    sessionStartSignatures: new Map(),
    selectorNeeded: false,
    detectedAt: new Map(),
    liveMessage: undefined,
    liveIds: new Set(),
    staleFrozenIds: new Set(),
    lastListFingerprint: "",
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

/**
 * Build the canonical text used to compute a record's signature.
 * Includes the full parsed record — name + description + type + content
 * — so frontmatter-only edits (e.g. renaming a memory or changing its
 * type) are detected, not just content edits.
 */
function recordSignatureText(record: ScannedMemory["record"]): string {
  return `${record.name}\u0000${record.description}\u0000${record.type}\u0000${record.content}`;
}

function signatureFromRecord(record: ScannedMemory["record"]): FileSignature {
  const text = recordSignatureText(record);
  return { hash: fnv1a(text), size: text.length };
}

/**
 * Build a session-start signature baseline from a scan result.
 *
 * The scan already reads every memory file's content (to parse
 * frontmatter), so computing a per-record signature is free.
 */
function buildSignatureBaseline(
  memories: readonly ScannedMemory[],
): ReadonlyMap<string, FileSignature> {
  const out = new Map<string, FileSignature>();
  for (const m of memories) {
    out.set(m.record.filePath, signatureFromRecord(m.record));
  }
  return out;
}

/**
 * Cheap change-detection fingerprint built from `fs.list()` output.
 *
 * Hashes sorted `(path, modifiedAt, size)` tuples. Used as a fast-path
 * gate before the (expensive) full scan: if this fingerprint matches
 * the previous turn, the directory looks unchanged and we skip the
 * rescan entirely.
 *
 * Trade-off: misses same-size, mtime-preserving edits (the case
 * memory-fs.update() produces) until the next time SOMETHING ELSE in
 * the directory changes. The scan-based content hash will then catch
 * up. We accept this small staleness window to avoid an O(n) scan on
 * every turn — the alternative is a hard latency regression.
 *
 * Returns "" on any error or truncation (forces a rescan to be safe).
 *
 * Per-file size cap: skip suspiciously-large files (>1MB) to bound the
 * cost of fingerprinting on poisoned directories.
 */
async function computeListFingerprint(
  fs: MemoryRecallMiddlewareConfig["fs"],
  memoryDir: string,
): Promise<string> {
  try {
    const settled = await Promise.resolve(fs.list(memoryDir, { glob: "**/*.md", recursive: true }));
    if (!settled.ok) return "";
    if (settled.value.truncated) return "";
    const entries = [...settled.value.entries]
      .filter((e) => e.path.endsWith(".md") && e.kind === "file")
      .map((e) => `${e.path}:${String(e.modifiedAt ?? 0)}:${String(e.size ?? 0)}`)
      .sort();
    return entries.join("|");
  } catch {
    return "";
  }
}

/**
 * Per-file size cap shared with scan helper (MAX_MEMORY_FILE_BYTES).
 * Skip oversized files in selectRelevant's loader to match scan's
 * eligibility checks — otherwise a memory that was valid at session
 * start could be overwritten with a huge file and bypass the cap.
 */
const MAX_MEMORY_FILE_BYTES = 50_000;

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
      // Single atomic scan: derive frozen snapshot, baseline signatures,
      // AND the relevance manifest from one scanResult so a memory write
      // landing between two scans cannot disappear from both layers.
      // Inlines what recallMemories() does internally — same pipeline,
      // shared scan output. Honors caller's maxFiles/maxCandidates so
      // large memory dirs stay bounded; memories past the cap won't be
      // tracked for delta detection (consistent with their absence from
      // the prompt-visible recall).
      const scanResult = await scanMemoryDirectory(config.fs, {
        memoryDir: config.recall.memoryDir,
        ...(config.recall.maxFiles !== undefined ? { maxFiles: config.recall.maxFiles } : {}),
        ...(config.recall.maxCandidates !== undefined
          ? { maxCandidates: config.recall.maxCandidates }
          : {}),
      });

      // Always build the baseline (for delta detection) even if the
      // frozen snapshot is empty — a write later still needs a baseline
      // to diff against.
      state.sessionStartSignatures = buildSignatureBaseline(scanResult.memories);

      if (scanResult.memories.length > 0) {
        const now = config.recall.now ?? Date.now();
        const budget = config.recall.tokenBudget ?? 8000;
        const scored = scoreMemories(scanResult.memories, config.recall.salience, now);
        const selection = selectWithinBudget(scored, budget, config.recall.format);
        const formatted = formatMemorySection(selection.selected, config.recall.format);

        if (formatted.length > 0) {
          state.memoryCount = selection.selected.length;
          state.tokenCount = estimateTokens(formatted);

          state.cachedMessage = {
            content: [{ kind: "text", text: formatted }],
            senderId: "system:memory-recall",
            timestamp: Date.now(),
          };

          state.frozenIds = new Set(selection.selected.map((s) => s.memory.record.id));
        }

        if (config.relevanceSelector !== undefined && selection.truncated) {
          state.selectorNeeded = true;
          state.memoryManifest = scanResult.memories.map((m) => ({
            name: m.record.name,
            description: m.record.description,
            type: m.record.type,
            id: m.record.id,
          }));
        }
      }

      // Record the list fingerprint so subsequent turns can fast-path
      // when nothing has changed at the directory metadata level.
      state.lastListFingerprint = await computeListFingerprint(config.fs, config.recall.memoryDir);
    } catch (_e: unknown) {
      console.warn("[middleware-memory-recall] initialize() failed (swallowed)");
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

    // Candidate filter:
    //  - Exclude IDs already in the live delta (avoid double-injection).
    //  - Exclude frozen-snapshot IDs UNLESS they were observed as
    //    changed mid-session — those frozen entries are stale, and the
    //    selector is the fallback that lets a budget-truncated overwrite
    //    reach the model. Otherwise an overwrite that doesn't fit in
    //    the live delta would never be visible for the rest of the session.
    const candidates = state.memoryManifest.filter((m) => {
      if (state.liveIds.has(m.id)) return false;
      if (state.frozenIds.has(m.id)) {
        return state.staleFrozenIds.has(m.id);
      }
      return true;
    });
    if (candidates.length === 0) return undefined;

    const userMessage = extractUserMessage(request);
    if (userMessage.length === 0) return undefined;

    const selectedIds = await selectRelevantMemories(
      candidates,
      userMessage,
      config.relevanceSelector,
    );

    if (selectedIds.length === 0) return undefined;

    // Load only the selected memories via direct fs.read. Applies the
    // same path/size validation as scanMemoryDirectory:
    //  - relative path (derived from id + ".md") must pass
    //    validateMemoryFilePath (no traversal, no absolute paths)
    //  - file size must be <= MAX_MEMORY_FILE_BYTES (50KB) to bound
    //    prompt-budget impact and prevent runaway reads if a memory
    //    was overwritten with a huge file mid-session
    //
    // Replaces the previous scanMemoryDirectory() that was wasteful
    // (read N files, kept K) and bound by the 200-file default cap.
    // Direct reads are O(K) where K = selected memories.
    const baseDir = config.recall.memoryDir.replace(/\\/g, "/").replace(/\/$/, "");
    const selectedMemories: ScannedMemory[] = [];
    for (const id of selectedIds) {
      // scan.ts sets record.id = relativePath (including ".md"), so id
      // IS the filePath we need to read.
      const relPath = id;
      // Path validation — same checks scanMemoryDirectory applies.
      if (validateMemoryFilePath(relPath) !== undefined) continue;
      try {
        const absPath = `${baseDir}/${relPath}`;
        const readResult = config.fs.read(absPath);
        const settled = await Promise.resolve(readResult);
        if (!settled.ok) continue;
        // Size cap — matches MAX_MEMORY_FILE_BYTES from scan.ts so a
        // mid-session overwrite to a huge file doesn't bypass the
        // scan's eligibility check via the relevance overlay path.
        if (settled.value.size > MAX_MEMORY_FILE_BYTES) continue;
        const parsed = parseMemoryFrontmatter(settled.value.content);
        if (parsed === undefined) continue;
        selectedMemories.push({
          record: {
            id: memoryRecordId(id),
            name: parsed.frontmatter.name,
            description: parsed.frontmatter.description,
            type: parsed.frontmatter.type,
            content: parsed.content,
            filePath: relPath,
            createdAt: 0,
            updatedAt: 0,
          },
          fileSize: settled.value.size,
        });
      } catch {
        // Skip unreadable selections rather than failing the whole overlay.
      }
    }

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
   * Insert a memory block BEFORE the last user message in the request.
   *
   * Why this position (not appended at the end): downstream session
   * transcript middleware (`@koi/session/transcript`) records
   * `request.messages.at(-1)` as the inbound user turn. If memory were
   * appended at the end, the transcript would persist the memory block
   * AS the user message, losing the real user input on resume/replay.
   *
   * Why this position (not prepended after the system snapshot): the
   * model interprets order; placing dynamic memory immediately before
   * the current user keeps it semantically tied to the question being
   * answered.
   *
   * Cache implication: a delta that lands mid-conversation does break
   * prompt-cache hits at the insertion point on subsequent turns. We
   * accept this — losing user input on replay is a correctness bug,
   * cache miss is a cost optimization. The frozen snapshot stays in
   * the cached prefix; only the live delta and relevance overlay are
   * cache-uncached when present.
   *
   * Falls back to appending if no user message is found (defensive —
   * the middleware must not lose context).
   */
  function insertBeforeLastUser(request: ModelRequest, block: InboundMessage): ModelRequest {
    const messages = request.messages;
    // let — reverse-iteration cursor for the insert position.
    let insertAt = messages.length;
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg === undefined) continue;
      if (msg.senderId === "user" || msg.senderId.startsWith("user")) {
        insertAt = i;
        break;
      }
    }
    return {
      ...request,
      messages: [...messages.slice(0, insertAt), block, ...messages.slice(insertAt)],
    };
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
    // Fast-path gate: if the cheap fingerprint (path+mtime+size hash
    // from fs.list, includes MEMORY.md) matches the previous turn,
    // the directory looks unchanged and we skip the expensive
    // content-reading scan.
    //
    // memory-fs.update() preserves mtime AND can preserve size on
    // equal-length corrections — taken alone, the memory file's
    // fingerprint entry would not change. But memory-fs rebuilds
    // MEMORY.md after every mutation with a fresh mtime, and that
    // index update changes the directory fingerprint, forcing the
    // content-hash rescan to catch the same-length edit. The
    // detection is verified by the test "same-size mtime-preserving
    // edit IS detected via index-rebuild side effect".
    //
    // For backends that don't write a MEMORY.md index, same-size
    // mtime-preserving edits would not be detected by this gate
    // alone. memory-fs is currently the only backend used in
    // production; if a non-indexing backend is ever added, this
    // gate must be revisited (e.g. switch to ctime if exposed by
    // FileListEntry, or always-scan with caller-controlled bounds).
    const currentFingerprint = await computeListFingerprint(config.fs, config.recall.memoryDir);
    if (currentFingerprint !== "" && currentFingerprint === state.lastListFingerprint) {
      return; // Nothing changed at the metadata level.
    }
    state.lastListFingerprint = currentFingerprint;

    try {
      const scanResult = await scanMemoryDirectory(config.fs, {
        memoryDir: config.recall.memoryDir,
        // Honor caller's maxFiles/maxCandidates — same bounds as the
        // session-start scan so the delta only tracks memories the
        // recall pipeline considers in scope. Memories beyond the cap
        // are also excluded from prompt-visible recall, so consistency
        // is correct: the agent never sees them either way.
        ...(config.recall.maxFiles !== undefined ? { maxFiles: config.recall.maxFiles } : {}),
        ...(config.recall.maxCandidates !== undefined
          ? { maxCandidates: config.recall.maxCandidates }
          : {}),
      });

      // Include memories that are NEW (absent from baseline) or whose
      // record signature (content + frontmatter) differs from session
      // start. Frontmatter inclusion catches name/description/type
      // edits, not just content edits.
      const now = Date.now();
      const changedMemories = scanResult.memories.filter((m) => {
        const id = m.record.id;
        // Baseline is keyed by filePath (built during init scan);
        // keep filePath lookup for baseline compatibility.
        const baseline = state.sessionStartSignatures.get(m.record.filePath);
        const current = signatureFromRecord(m.record);
        if (baseline === undefined) {
          // Genuinely new file — record first-observation time for ranking.
          if (!state.detectedAt.has(id)) state.detectedAt.set(id, now);
          return true;
        }
        if (signatureChanged(current, baseline)) {
          if (!state.detectedAt.has(id)) state.detectedAt.set(id, now);
          // Record stale-frozen status so the relevance selector can
          // reach this overwrite even if the live delta budget drops it.
          if (state.frozenIds.has(id)) state.staleFrozenIds.add(id);
          return true;
        }
        // Signature matches baseline — unchanged.
        return false;
      });

      if (changedMemories.length === 0) {
        state.liveMessage = undefined;
        state.liveIds = new Set();
        return;
      }

      // Always merge ALL changed memories into the manifest BEFORE the
      // budget logic, so overflow stays reachable via the relevance
      // selector and frontmatter-only edits refresh the manifest's
      // metadata in place. Done up front because every code path below
      // (delta-injected, budget-truncated, all-too-big) needs this.
      const changedById = new Map<string, MemoryManifestEntry>();
      for (const m of changedMemories) {
        changedById.set(m.record.id, {
          name: m.record.name,
          description: m.record.description,
          type: m.record.type,
          id: m.record.id,
        });
      }
      const replaced = state.memoryManifest.map((e) => changedById.get(e.id) ?? e);
      const existingIds = new Set(state.memoryManifest.map((e) => e.id));
      const additions = [...changedById.values()].filter((e) => !existingIds.has(e.id));
      state.memoryManifest = additions.length > 0 ? [...replaced, ...additions] : replaced;

      // Build the section title to explicitly handle precedence when
      // any changed memory shares an id with the frozen snapshot.
      // Without this signal the model sees two contradictory copies
      // (stale frozen + fresh delta) and may answer from the wrong one.
      const hasOverwrite = changedMemories.some((m) => state.frozenIds.has(m.record.id));
      const sectionTitle = hasOverwrite
        ? "Recent Memory Updates (these supersede same-name entries in the earlier Memory section)"
        : "Recently Added Memories";

      // Budget-pack: sort by recency desc, include memories whose
      // formatted addition fits the budget. SKIP (not break on)
      // oversized candidates so a single huge newest memory does not
      // suppress smaller older updates. Re-measures after formatting
      // to account for section headers and XML overhead.
      // Rank by OUR observation time, not record.updatedAt — for
      // mtime-preserving stores, mtime is stale on every update.
      const rankOf = (m: ScannedMemory): number =>
        state.detectedAt.get(m.record.id) ?? m.record.updatedAt;
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
          sectionTitle,
          trustingRecallNote: true,
        });
        if (estimateTokens(candidateFormatted) > liveDeltaBudget) {
          // Skip this oversized candidate — try the next smaller/older
          // entry. Don't break: an oversized newest entry must not block
          // smaller older entries from being included in the delta.
          continue;
        }
        packed.push(m);
        formatted = candidateFormatted;
      }

      if (packed.length === 0 || formatted.length === 0) {
        // Nothing fits (even a single memory exceeds the budget). Clear
        // the delta but leave the manifest populated so the relevance
        // selector can route overflow.
        state.liveMessage = undefined;
        state.liveIds = new Set();
      } else {
        state.liveMessage = {
          content: [{ kind: "text", text: formatted }],
          senderId: "system:memory-live",
          timestamp: Date.now(),
        };
        state.liveIds = new Set(packed.map((m) => m.record.id));
      }

      // Enable the relevance selector when delta couldn't include
      // every changed memory (truncation OR couldn't fit anything).
      // The dropped memories remain reachable: they are in
      // memoryManifest but NOT in liveIds, so the selector's
      // candidate filter will include them.
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
