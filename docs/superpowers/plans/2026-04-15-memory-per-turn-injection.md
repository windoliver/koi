# Per-Turn Memory Re-Injection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make memories stored mid-session visible to the agent on the next turn, without breaking prefix caching, by adding an mtime-guarded live delta block after conversation history.

**Architecture:** The existing frozen snapshot (prefix-cached) stays untouched. A new `refreshLiveDelta()` function runs per turn: `stat()` the memory dir, re-scan only if `mtime` changed, diff against frozen set, format and cache a delta message appended after conversation history. The relevance selector's candidate filter is updated to exclude delta paths.

**Tech Stack:** Bun 1.3.x, bun:test, TypeScript 6 strict

**Spec:** `docs/superpowers/specs/2026-04-15-memory-per-turn-injection-design.md`

---

### Task 1: Add live delta state fields and `refreshLiveDelta()` function

**Files:**
- Modify: `packages/mm/middleware-memory-recall/src/memory-recall-middleware.ts`

- [ ] **Step 1: Add `stat` import**

Add at the top of the file (after existing imports, before the factory section):

```typescript
import { stat as fsStat } from "node:fs/promises";
```

- [ ] **Step 2: Add new fields to `SessionRecallState`**

Update the interface (currently lines 44-52) to:

```typescript
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
```

- [ ] **Step 3: Update `createEmptyState()` with new fields**

```typescript
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
```

- [ ] **Step 4: Record dir mtime at end of `initialize()`**

At the end of the `try` block in `initialize()` (after line 117, before the `catch`), add:

```typescript
      // Record dir mtime so the first wrapModelCall doesn't immediately re-scan.
      try {
        const dirStat = await fsStat(config.recall.memoryDir);
        state.lastDirMtimeMs = dirStat.mtimeMs;
      } catch {
        // Dir may not exist yet — leave at 0 so first turn triggers scan.
      }
```

- [ ] **Step 5: Add `refreshLiveDelta()` function**

Add after `injectFrozenSnapshot()` (after line 224):

```typescript
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
```

- [ ] **Step 6: Verify typecheck passes**

Run: `bun run typecheck --filter=@koi/middleware-memory-recall`

Expected: PASS (new function exists but is not called yet — no type errors).

- [ ] **Step 7: Commit**

```bash
git add packages/mm/middleware-memory-recall/src/memory-recall-middleware.ts
git commit -m "feat(middleware-memory-recall): add refreshLiveDelta with mtime guard

New state fields (lastDirMtimeMs, liveMessage, livePaths) and
refreshLiveDelta() that scans for new memories when dir mtime
changes. Not wired into wrapModelCall yet. Ref #1829"
```

---

### Task 2: Wire live delta into `wrapModelCall` and `wrapModelStream`

**Files:**
- Modify: `packages/mm/middleware-memory-recall/src/memory-recall-middleware.ts`

- [ ] **Step 1: Update `wrapModelCall` to inject live delta**

Replace the current `wrapModelCall` body (lines 249-275) with:

```typescript
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
```

- [ ] **Step 2: Update `wrapModelStream` identically**

Replace the current `wrapModelStream` body (lines 277-303) with:

```typescript
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
```

- [ ] **Step 3: Update relevance candidate filter to exclude live delta paths**

In `selectRelevant()`, change line 167 from:

```typescript
    const candidates = state.memoryManifest.filter((m) => !state.frozenPaths.has(m.filePath));
```

To:

```typescript
    const candidates = state.memoryManifest.filter(
      (m) => !state.frozenPaths.has(m.filePath) && !state.livePaths.has(m.filePath),
    );
```

- [ ] **Step 4: Update module doc comment**

Replace the file's opening doc comment (lines 1-15) with:

```typescript
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
```

- [ ] **Step 5: Verify typecheck passes**

Run: `bun run typecheck --filter=@koi/middleware-memory-recall`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/mm/middleware-memory-recall/src/memory-recall-middleware.ts
git commit -m "feat(middleware-memory-recall): wire live delta into wrapModelCall/Stream

Live delta appended after conversation history. Relevance candidate
filter excludes both frozen and live delta paths. Ref #1829"
```

---

### Task 3: Tests for live delta injection

**Files:**
- Modify: `packages/mm/middleware-memory-recall/src/memory-recall-middleware.test.ts`

- [ ] **Step 1: Add `stat` mock infrastructure**

After the existing imports (line 16), add:

```typescript
import { stat as fsStat } from "node:fs/promises";
import { mock as bunMock } from "bun:test";
```

Add a helper to mock `fsStat` at the top of the helpers section (after line 20):

```typescript
/** Track mocked mtime for fsStat — tests update this to simulate dir changes. */
let mockedDirMtimeMs = 1000;

// Mock fsStat to return controlled mtime values.
bunMock.module("node:fs/promises", () => ({
  stat: async (_path: string) => ({
    mtimeMs: mockedDirMtimeMs,
  }),
}));
```

Update `beforeEach` to reset:

```typescript
  beforeEach(() => {
    mock.restore();
    mockedDirMtimeMs = 1000;
  });
```

- [ ] **Step 2: Add live delta test — new memory appears after mtime change**

Add at the end of the `describe("createMemoryRecallMiddleware", ...)` block:

```typescript
  test("live delta injects new memories when dir mtime changes", async () => {
    // Start with one memory file.
    const initialFiles = [
      {
        path: "/mem/role.md",
        content: makeMemoryFileContent("Role", "user", "Senior engineer"),
        modifiedAt: now,
      },
    ];
    const fs = createMockFs(initialFiles);
    const mw = createMemoryRecallMiddleware(createConfig(fs));
    const request = createModelRequest();

    // First call — initializes frozen snapshot.
    let capturedRequest: ModelRequest | undefined;
    const next = async (req: ModelRequest): Promise<ModelResponse> => {
      capturedRequest = req;
      return mockNext(req);
    };

    await mw.wrapModelCall?.(createTurnCtx(), request, next);

    // Should have frozen snapshot + user message only.
    expect(capturedRequest?.messages.length).toBe(2);
    expect(capturedRequest?.messages[0]?.senderId).toBe("system:memory-recall");

    // Simulate a new memory being stored mid-session:
    // 1. Add new file to the mock FS.
    const updatedFiles = [
      ...initialFiles,
      {
        path: "/mem/color.md",
        content: makeMemoryFileContent("Fav Color", "user", "Favorite color is blue"),
        modifiedAt: now + 1000,
      },
    ];
    const updatedFs = createMockFs(updatedFiles);
    // We need a new middleware instance that uses the updated FS.
    // Instead, we patch the existing config's fs — but config is readonly.
    // Better approach: create a mutable FS wrapper.

    // Re-create middleware with a FS that has both files from the start,
    // but mock fsStat to return different mtime on second call.
    const allFiles = [
      {
        path: "/mem/role.md",
        content: makeMemoryFileContent("Role", "user", "Senior engineer"),
        modifiedAt: now,
      },
      {
        path: "/mem/color.md",
        content: makeMemoryFileContent("Fav Color", "user", "Favorite color is blue"),
        modifiedAt: now + 1000,
      },
    ];
    const allFs = createMockFs(allFiles);
    const mw2 = createMemoryRecallMiddleware(createConfig(allFs));

    // Initialize — frozen snapshot captures both files.
    // We need to simulate that only "role.md" was in frozen, and "color.md" is new.
    // To do this: set initial mtime, let initialize run, then bump mtime.

    mockedDirMtimeMs = 1000;
    await mw2.wrapModelCall?.(createTurnCtx(), request, next);

    // First call: both files are in frozen snapshot (both exist at init time).
    // To properly test the delta, we need the second file to NOT exist at init.
    // Let's use a different approach: a FS that can change between calls.
  });
```

Actually, the test approach above gets complicated with immutable mock FS. Let me restructure.

- [ ] **Step 2 (revised): Create a mutable mock FS helper and write proper tests**

Replace the test above. Add a new helper after `createThrowingFs()`:

```typescript
/**
 * Mutable mock FS — files can be added/removed between calls to simulate
 * mid-session memory stores.
 */
function createMutableMockFs(): {
  readonly fs: FileSystemBackend;
  readonly addFile: (path: string, content: string, modifiedAt: number) => void;
} {
  // let justified: mutable file list for simulating mid-session changes
  let files: Array<{ readonly path: string; readonly content: string; readonly modifiedAt: number }> =
    [];

  const fs: FileSystemBackend = {
    name: "mutable-mock-fs",
    read(path): Result<FileReadResult, KoiError> {
      const file = files.find((f) => f.path === path);
      if (!file) {
        return { ok: false, error: { code: "NOT_FOUND", message: "not found", retryable: false } };
      }
      return {
        ok: true,
        value: { content: file.content, path: file.path, size: file.content.length },
      };
    },
    list(path): Result<FileListResult, KoiError> {
      const entries = files
        .filter((f) => f.path.startsWith(path) && f.path.endsWith(".md"))
        .map((f) => ({
          path: f.path,
          kind: "file" as const,
          size: f.content.length,
          modifiedAt: f.modifiedAt,
        }));
      return { ok: true, value: { entries, truncated: false } };
    },
    write() {
      return {
        ok: false,
        error: { code: "INTERNAL" as const, message: "not implemented", retryable: false },
      };
    },
    edit() {
      return {
        ok: false,
        error: { code: "INTERNAL" as const, message: "not implemented", retryable: false },
      };
    },
    search() {
      return {
        ok: false,
        error: { code: "INTERNAL" as const, message: "not implemented", retryable: false },
      };
    },
  };

  return {
    fs,
    addFile(path: string, content: string, modifiedAt: number) {
      files = [...files, { path, content, modifiedAt }];
    },
  };
}
```

Then add the tests:

```typescript
  describe("live delta", () => {
    test("injects new memories when dir mtime changes", async () => {
      const { fs, addFile } = createMutableMockFs();
      addFile("/mem/role.md", makeMemoryFileContent("Role", "user", "Senior engineer"), now);

      const mw = createMemoryRecallMiddleware({ fs, recall: { memoryDir: "/mem", now } });

      let capturedRequest: ModelRequest | undefined;
      const next = async (req: ModelRequest): Promise<ModelResponse> => {
        capturedRequest = req;
        return mockNext(req);
      };

      // First call — initializes frozen snapshot with role.md.
      mockedDirMtimeMs = 1000;
      await mw.wrapModelCall?.(createTurnCtx(), createModelRequest(), next);
      expect(capturedRequest?.messages.length).toBe(2); // frozen + user

      // Simulate mid-session memory store: add a file + bump mtime.
      addFile("/mem/color.md", makeMemoryFileContent("Color", "user", "Favorite color is blue"), now + 1000);
      mockedDirMtimeMs = 2000;

      // Second call — should detect mtime change and inject delta.
      await mw.wrapModelCall?.(createTurnCtx(), createModelRequest(), next);

      expect(capturedRequest).toBeDefined();
      if (capturedRequest === undefined) return;
      // frozen (prepended) + user + live delta (appended)
      expect(capturedRequest.messages.length).toBe(3);
      expect(capturedRequest.messages[0]?.senderId).toBe("system:memory-recall");
      expect(capturedRequest.messages[1]?.senderId).toBe("user");
      expect(capturedRequest.messages[2]?.senderId).toBe("system:memory-live");
      const deltaText = (capturedRequest.messages[2]?.content[0] as { readonly kind: "text"; readonly text: string })?.text;
      expect(deltaText).toContain("Favorite color is blue");
      // Frozen snapshot should NOT contain the new memory.
      const frozenText = (capturedRequest.messages[0]?.content[0] as { readonly kind: "text"; readonly text: string })?.text;
      expect(frozenText).not.toContain("Favorite color is blue");
    });

    test("skips re-scan when mtime unchanged", async () => {
      const { fs, addFile } = createMutableMockFs();
      addFile("/mem/role.md", makeMemoryFileContent("Role", "user", "Engineer"), now);

      const mw = createMemoryRecallMiddleware({ fs, recall: { memoryDir: "/mem", now } });

      const scanSpy = spyOn(memoryModule, "scanMemoryDirectory");

      const next = async (req: ModelRequest): Promise<ModelResponse> => mockNext(req);

      // First call — init (recallMemories internally scans).
      mockedDirMtimeMs = 1000;
      await mw.wrapModelCall?.(createTurnCtx(), createModelRequest(), next);

      const callsAfterInit = scanSpy.mock.calls.length;

      // Second call — same mtime, should NOT call scanMemoryDirectory.
      await mw.wrapModelCall?.(createTurnCtx(), createModelRequest(), next);

      expect(scanSpy.mock.calls.length).toBe(callsAfterInit);
    });

    test("live delta updates on subsequent mtime changes", async () => {
      const { fs, addFile } = createMutableMockFs();
      addFile("/mem/role.md", makeMemoryFileContent("Role", "user", "Engineer"), now);

      const mw = createMemoryRecallMiddleware({ fs, recall: { memoryDir: "/mem", now } });

      let capturedRequest: ModelRequest | undefined;
      const next = async (req: ModelRequest): Promise<ModelResponse> => {
        capturedRequest = req;
        return mockNext(req);
      };

      // Init.
      mockedDirMtimeMs = 1000;
      await mw.wrapModelCall?.(createTurnCtx(), createModelRequest(), next);

      // First mid-session store.
      addFile("/mem/color.md", makeMemoryFileContent("Color", "user", "Blue"), now + 1000);
      mockedDirMtimeMs = 2000;
      await mw.wrapModelCall?.(createTurnCtx(), createModelRequest(), next);

      expect(capturedRequest?.messages.length).toBe(3); // frozen + user + delta(1)

      // Second mid-session store.
      addFile("/mem/lang.md", makeMemoryFileContent("Lang", "user", "Prefers TypeScript"), now + 2000);
      mockedDirMtimeMs = 3000;
      await mw.wrapModelCall?.(createTurnCtx(), createModelRequest(), next);

      expect(capturedRequest).toBeDefined();
      if (capturedRequest === undefined) return;
      // frozen + user + delta (now has 2 new memories)
      expect(capturedRequest.messages.length).toBe(3);
      const deltaText = (capturedRequest.messages[2]?.content[0] as { readonly kind: "text"; readonly text: string })?.text;
      expect(deltaText).toContain("Blue");
      expect(deltaText).toContain("Prefers TypeScript");
    });

    test("live delta works in wrapModelStream", async () => {
      const { fs, addFile } = createMutableMockFs();
      addFile("/mem/role.md", makeMemoryFileContent("Role", "user", "Engineer"), now);

      const mw = createMemoryRecallMiddleware({ fs, recall: { memoryDir: "/mem", now } });

      let capturedRequest: ModelRequest | undefined;
      async function* streamNext(req: ModelRequest): AsyncIterable<ModelChunk> {
        capturedRequest = req;
        yield { kind: "text_delta", delta: "hello" };
      }

      // Init.
      mockedDirMtimeMs = 1000;
      const initStream = mw.wrapModelStream?.(createTurnCtx(), createModelRequest(), streamNext);
      if (initStream) { for await (const _ of initStream) { /* drain */ } }

      // Add memory + bump mtime.
      addFile("/mem/color.md", makeMemoryFileContent("Color", "user", "Green"), now + 1000);
      mockedDirMtimeMs = 2000;

      const stream = mw.wrapModelStream?.(createTurnCtx(), createModelRequest(), streamNext);
      if (stream) { for await (const _ of stream) { /* drain */ } }

      expect(capturedRequest?.messages.length).toBe(3);
      expect(capturedRequest?.messages[2]?.senderId).toBe("system:memory-live");
    });
  });
```

- [ ] **Step 3: Run tests**

Run: `bun test packages/mm/middleware-memory-recall/src/memory-recall-middleware.test.ts`

Expected: All existing tests PASS, all 4 new live delta tests PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/mm/middleware-memory-recall/src/memory-recall-middleware.test.ts
git commit -m "test(middleware-memory-recall): live delta injection tests

Covers: delta appears after mtime change, mtime guard skips re-scan,
delta updates on subsequent changes, delta works in streaming.
Ref #1829"
```

---

### Task 4: Run full CI gate

**Files:** None — verification only.

- [ ] **Step 1: Run middleware tests**

Run: `bun test packages/mm/middleware-memory-recall/`

Expected: All tests PASS.

- [ ] **Step 2: Run typecheck**

Run: `bun run typecheck`

Expected: PASS.

- [ ] **Step 3: Run lint**

Run: `bun run lint`

Expected: PASS.

- [ ] **Step 4: Run layer check**

Run: `bun run check:layers`

Expected: PASS — no new cross-layer imports. `node:fs/promises` is a platform API, not a package dependency.

- [ ] **Step 5: Commit any autofix changes**

```bash
git add -A && git commit -m "chore: lint autofix" || echo "Nothing to fix"
```
