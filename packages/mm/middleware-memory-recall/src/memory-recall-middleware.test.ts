import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtemp, realpath, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  FileListResult,
  FileReadResult,
  FileSystemBackend,
  KoiError,
  ModelChunk,
  ModelRequest,
  ModelResponse,
  Result,
  SessionContext,
  TurnContext,
} from "@koi/core";
import { createLocalFileSystem } from "@koi/fs-local";
import * as memoryModule from "@koi/memory";
import { createMemoryRecallMiddleware } from "./memory-recall-middleware.js";
import type { MemoryRecallMiddlewareConfig } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMemoryFileContent(name: string, type: string, content: string): string {
  return [
    "---",
    `name: ${name}`,
    "description: test desc",
    `type: ${type}`,
    "---",
    "",
    content,
  ].join("\n");
}

function createMockFs(
  files: ReadonlyArray<{
    readonly path: string;
    readonly content: string;
    readonly modifiedAt: number;
  }>,
): FileSystemBackend {
  return {
    name: "mock-fs",
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
}

function createThrowingFs(): FileSystemBackend {
  return {
    name: "throw-fs",
    read(): Result<FileReadResult, KoiError> {
      throw new Error("FS read exploded");
    },
    list(): Result<FileListResult, KoiError> {
      throw new Error("FS list exploded");
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
}

function createConfig(fs: FileSystemBackend): MemoryRecallMiddlewareConfig {
  return {
    fs,
    recall: { memoryDir: "/mem", now: Date.now() },
  };
}

function createSessionCtx(): SessionContext {
  return {
    agentId: "test-agent",
    sessionId: "sess-1" as never,
    runId: "run-1" as never,
    metadata: {},
  };
}

function createTurnCtx(): TurnContext {
  return {
    session: createSessionCtx(),
    turnIndex: 0,
    turnId: "turn-1" as never,
    messages: [],
    metadata: {},
  };
}

function createModelRequest(text: string = "hello"): ModelRequest {
  return {
    messages: [
      {
        content: [{ kind: "text", text }],
        senderId: "user",
        timestamp: Date.now(),
      },
    ],
  };
}

const mockNext = async (_req: ModelRequest): Promise<ModelResponse> => ({
  content: "response",
  model: "test-model",
  usage: { inputTokens: 10, outputTokens: 5 },
  stopReason: "stop",
});

async function* _mockStreamNext(_req: ModelRequest): AsyncIterable<ModelChunk> {
  yield { kind: "text_delta", delta: "hello" };
}

async function createTempMemoryDir(): Promise<string> {
  // realpath resolves macOS /var -> /private/var so the path matches what
  // createLocalFileSystem uses as its root.
  return realpath(await mkdtemp(join(tmpdir(), "koi-memrecall-live-")));
}

function createRealFsConfig(dir: string): MemoryRecallMiddlewareConfig {
  return {
    fs: createLocalFileSystem(dir),
    recall: { memoryDir: dir, now: Date.now() },
  };
}

function getMessageText(req: ModelRequest, index: number): string {
  const block = req.messages[index]?.content[0];
  if (block === undefined || block.kind !== "text") return "";
  return block.text;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createMemoryRecallMiddleware", () => {
  const now = Date.now();

  beforeEach(() => {
    // Clear any spies between tests
    mock.restore();
  });

  test("injects recalled memories into first model call", async () => {
    const files = [
      {
        path: "/mem/role.md",
        content: makeMemoryFileContent("Role", "user", "Senior engineer"),
        modifiedAt: now,
      },
      {
        path: "/mem/feedback.md",
        content: makeMemoryFileContent("Feedback", "feedback", "Use integration tests"),
        modifiedAt: now - 86_400_000,
      },
    ];
    const fs = createMockFs(files);
    const mw = createMemoryRecallMiddleware(createConfig(fs));
    const request = createModelRequest();

    let capturedRequest: ModelRequest | undefined;
    const next = async (req: ModelRequest): Promise<ModelResponse> => {
      capturedRequest = req;
      return mockNext(req);
    };

    await mw.wrapModelCall?.(createTurnCtx(), request, next);

    expect(capturedRequest).toBeDefined();
    if (capturedRequest === undefined) return;
    // Should have 2 messages: prepended memory + original user message
    expect(capturedRequest.messages.length).toBe(2);
    // First message is the memory injection
    const memoryMsg = capturedRequest.messages[0];
    expect(memoryMsg?.senderId).toBe("system:memory-recall");
    expect(memoryMsg?.content[0]?.kind).toBe("text");
    const memoryText = (memoryMsg?.content[0] as { readonly kind: "text"; readonly text: string })
      ?.text;
    expect(memoryText).toContain("Senior engineer");
    expect(memoryText).toContain("Use integration tests");
  });

  test("returns empty injection for empty memory directory", async () => {
    const fs = createMockFs([]);
    const mw = createMemoryRecallMiddleware(createConfig(fs));
    const request = createModelRequest();

    let capturedRequest: ModelRequest | undefined;
    const next = async (req: ModelRequest): Promise<ModelResponse> => {
      capturedRequest = req;
      return mockNext(req);
    };

    await mw.wrapModelCall?.(createTurnCtx(), request, next);

    expect(capturedRequest).toBeDefined();
    if (capturedRequest === undefined) return;
    // No memory to prepend — original request should be passed unchanged
    expect(capturedRequest.messages.length).toBe(1);
    expect(capturedRequest.messages[0]?.senderId).toBe("user");
  });

  test("caches result and reuses on subsequent model calls", async () => {
    const files = [
      {
        path: "/mem/role.md",
        content: makeMemoryFileContent("Role", "user", "Engineer memory"),
        modifiedAt: now,
      },
    ];
    const fs = createMockFs(files);
    const mw = createMemoryRecallMiddleware(createConfig(fs));
    const request = createModelRequest();

    const recallSpy = spyOn(memoryModule, "recallMemories");

    const next = async (req: ModelRequest): Promise<ModelResponse> => mockNext(req);

    await mw.wrapModelCall?.(createTurnCtx(), request, next);
    await mw.wrapModelCall?.(createTurnCtx(), request, next);

    // recallMemories should only be called once despite two model calls
    expect(recallSpy).toHaveBeenCalledTimes(1);
  });

  test("resets cache on session start", async () => {
    const files = [
      {
        path: "/mem/role.md",
        content: makeMemoryFileContent("Role", "user", "Cached memory"),
        modifiedAt: now,
      },
    ];
    const fs = createMockFs(files);
    const mw = createMemoryRecallMiddleware(createConfig(fs));
    const request = createModelRequest();

    const recallSpy = spyOn(memoryModule, "recallMemories");

    const next = async (req: ModelRequest): Promise<ModelResponse> => mockNext(req);

    // First model call — triggers recall
    await mw.wrapModelCall?.(createTurnCtx(), request, next);
    expect(recallSpy).toHaveBeenCalledTimes(1);

    // Reset via session start
    await mw.onSessionStart?.(createSessionCtx());

    // Second model call — triggers recall again because cache was reset
    await mw.wrapModelCall?.(createTurnCtx(), request, next);
    expect(recallSpy).toHaveBeenCalledTimes(2);
  });

  test("handles recallMemories failure gracefully", async () => {
    const fs = createThrowingFs();
    const mw = createMemoryRecallMiddleware(createConfig(fs));
    const request = createModelRequest();

    let capturedRequest: ModelRequest | undefined;
    const next = async (req: ModelRequest): Promise<ModelResponse> => {
      capturedRequest = req;
      return mockNext(req);
    };

    // Should not throw
    await mw.wrapModelCall?.(createTurnCtx(), request, next);

    // next() should be called with the original request (no memory injection)
    expect(capturedRequest).toBeDefined();
    if (capturedRequest === undefined) return;
    expect(capturedRequest.messages.length).toBe(1);
    expect(capturedRequest.messages[0]?.senderId).toBe("user");
  });

  test("reports capabilities when memories recalled", async () => {
    const files = [
      {
        path: "/mem/role.md",
        content: makeMemoryFileContent("Role", "user", "Engineer memory"),
        modifiedAt: now,
      },
      {
        path: "/mem/tip.md",
        content: makeMemoryFileContent("Tip", "feedback", "Use DI for testing"),
        modifiedAt: now,
      },
    ];
    const fs = createMockFs(files);
    const mw = createMemoryRecallMiddleware(createConfig(fs));
    const request = createModelRequest();

    const next = async (req: ModelRequest): Promise<ModelResponse> => mockNext(req);
    await mw.wrapModelCall?.(createTurnCtx(), request, next);

    const caps = mw.describeCapabilities(createTurnCtx());
    expect(caps).toBeDefined();
    if (caps === undefined) return;
    expect(caps.label).toBe("memory-recall");
    expect(caps.description).toContain("2 memories recalled");
    // Should include token count and budget
    expect(caps.description).toMatch(/\d+\/8000 tokens/);
  });

  test("reports no capabilities when no memories", async () => {
    const fs = createMockFs([]);
    const mw = createMemoryRecallMiddleware(createConfig(fs));
    const request = createModelRequest();

    const next = async (req: ModelRequest): Promise<ModelResponse> => mockNext(req);
    await mw.wrapModelCall?.(createTurnCtx(), request, next);

    const caps = mw.describeCapabilities(createTurnCtx());
    expect(caps).toBeUndefined();
  });

  test("injects memories in wrapModelStream", async () => {
    const files = [
      {
        path: "/mem/role.md",
        content: makeMemoryFileContent("Role", "user", "Stream memory content"),
        modifiedAt: now,
      },
    ];
    const fs = createMockFs(files);
    const mw = createMemoryRecallMiddleware(createConfig(fs));
    const request = createModelRequest();

    let capturedRequest: ModelRequest | undefined;
    async function* streamNext(req: ModelRequest): AsyncIterable<ModelChunk> {
      capturedRequest = req;
      yield { kind: "text_delta", delta: "hello" };
    }

    const chunks: ModelChunk[] = [];
    const stream = mw.wrapModelStream?.(createTurnCtx(), request, streamNext);
    if (stream) {
      for await (const chunk of stream) {
        chunks.push(chunk);
      }
    }

    // Verify memory was injected into the request
    expect(capturedRequest).toBeDefined();
    if (capturedRequest === undefined) return;
    expect(capturedRequest.messages.length).toBe(2);
    expect(capturedRequest.messages[0]?.senderId).toBe("system:memory-recall");
    const memoryText = (
      capturedRequest.messages[0]?.content[0] as { readonly kind: "text"; readonly text: string }
    )?.text;
    expect(memoryText).toContain("Stream memory content");

    // Verify chunks pass through
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.kind).toBe("text_delta");
  });

  test("does not re-recall after failure", async () => {
    const fs = createThrowingFs();
    const mw = createMemoryRecallMiddleware(createConfig(fs));
    const request = createModelRequest();

    const recallSpy = spyOn(memoryModule, "recallMemories");

    const next = async (req: ModelRequest): Promise<ModelResponse> => mockNext(req);

    // First call — recall attempted and fails
    await mw.wrapModelCall?.(createTurnCtx(), request, next);
    // Second call — should NOT retry recall (initialized flag prevents it)
    await mw.wrapModelCall?.(createTurnCtx(), request, next);

    // recallMemories is only attempted once
    expect(recallSpy).toHaveBeenCalledTimes(1);
  });

  test("prepends memory message before existing messages", async () => {
    const files = [
      {
        path: "/mem/role.md",
        content: makeMemoryFileContent("Role", "user", "Prepend check"),
        modifiedAt: now,
      },
    ];
    const fs = createMockFs(files);
    const mw = createMemoryRecallMiddleware(createConfig(fs));

    // Request with multiple existing messages
    const request: ModelRequest = {
      messages: [
        {
          content: [{ kind: "text", text: "first user msg" }],
          senderId: "user",
          timestamp: now,
        },
        {
          content: [{ kind: "text", text: "second user msg" }],
          senderId: "user",
          timestamp: now + 1,
        },
      ],
    };

    let capturedRequest: ModelRequest | undefined;
    const next = async (req: ModelRequest): Promise<ModelResponse> => {
      capturedRequest = req;
      return mockNext(req);
    };

    await mw.wrapModelCall?.(createTurnCtx(), request, next);

    expect(capturedRequest).toBeDefined();
    if (capturedRequest === undefined) return;
    // Memory message + 2 original messages
    expect(capturedRequest.messages.length).toBe(3);
    // Memory is FIRST, not last
    expect(capturedRequest.messages[0]?.senderId).toBe("system:memory-recall");
    // Original messages follow in order
    const secondText = (
      capturedRequest.messages[1]?.content[0] as { readonly kind: "text"; readonly text: string }
    )?.text;
    expect(secondText).toBe("first user msg");
    const thirdText = (
      capturedRequest.messages[2]?.content[0] as { readonly kind: "text"; readonly text: string }
    )?.text;
    expect(thirdText).toBe("second user msg");
  });

  describe("live delta", () => {
    let dir: string;

    beforeEach(async () => {
      dir = await createTempMemoryDir();
    });

    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    test("injects new memories when dir mtime changes", async () => {
      // Seed one memory file before init.
      await writeFile(
        join(dir, "role.md"),
        makeMemoryFileContent("Role", "user", "Frozen snapshot content"),
      );

      const mw = createMemoryRecallMiddleware(createRealFsConfig(dir));
      const request = createModelRequest();

      // First wrapModelCall — captures the frozen snapshot for "role.md".
      let firstRequest: ModelRequest | undefined;
      const firstNext = async (req: ModelRequest): Promise<ModelResponse> => {
        firstRequest = req;
        return mockNext(req);
      };
      await mw.wrapModelCall?.(createTurnCtx(), request, firstNext);

      expect(firstRequest).toBeDefined();
      if (firstRequest === undefined) return;
      // Frozen snapshot prepended, user message follows — no live delta yet.
      expect(firstRequest.messages.length).toBe(2);
      expect(firstRequest.messages[0]?.senderId).toBe("system:memory-recall");
      expect(getMessageText(firstRequest, 0)).toContain("Frozen snapshot content");

      // Add a SECOND memory file mid-session — this bumps the dir mtime.
      await writeFile(
        join(dir, "feedback.md"),
        makeMemoryFileContent("Feedback", "feedback", "Live delta content"),
      );
      // Force the dir mtime ahead of the frozen-scan snapshot (guards against
      // same-millisecond writes on fast disks).
      const future = new Date(Date.now() + 5000);
      await utimes(dir, future, future);

      // Second wrapModelCall — live delta should append the new memory.
      let secondRequest: ModelRequest | undefined;
      const secondNext = async (req: ModelRequest): Promise<ModelResponse> => {
        secondRequest = req;
        return mockNext(req);
      };
      await mw.wrapModelCall?.(createTurnCtx(), request, secondNext);

      expect(secondRequest).toBeDefined();
      if (secondRequest === undefined) return;
      // 3 messages: frozen (prepended) + live delta (before user) + user.
      expect(secondRequest.messages.length).toBe(3);
      expect(secondRequest.messages[0]?.senderId).toBe("system:memory-recall");
      expect(secondRequest.messages[1]?.senderId).toBe("system:memory-live");
      expect(secondRequest.messages[2]?.senderId).toBe("user");

      // Live delta contains the new memory, not the frozen one.
      const liveText = getMessageText(secondRequest, 1);
      expect(liveText).toContain("Live delta content");
      expect(liveText).not.toContain("Frozen snapshot content");

      // Frozen snapshot does NOT contain the new memory.
      const frozenText = getMessageText(secondRequest, 0);
      expect(frozenText).toContain("Frozen snapshot content");
      expect(frozenText).not.toContain("Live delta content");
    });

    test("skips re-scan when mtime unchanged", async () => {
      await writeFile(join(dir, "role.md"), makeMemoryFileContent("Role", "user", "Stable memory"));

      const scanSpy = spyOn(memoryModule, "scanMemoryDirectory");

      const mw = createMemoryRecallMiddleware(createRealFsConfig(dir));
      const request = createModelRequest();
      const next = async (req: ModelRequest): Promise<ModelResponse> => mockNext(req);

      // Call wrapModelCall multiple times without touching the dir.
      await mw.wrapModelCall?.(createTurnCtx(), request, next);
      const callsAfterInit = scanSpy.mock.calls.length;

      await mw.wrapModelCall?.(createTurnCtx(), request, next);
      await mw.wrapModelCall?.(createTurnCtx(), request, next);

      // mtime guard prevents additional scans on subsequent calls.
      expect(scanSpy.mock.calls.length).toBe(callsAfterInit);
    });

    test("live delta updates on subsequent mtime changes", async () => {
      await writeFile(
        join(dir, "role.md"),
        makeMemoryFileContent("Role", "user", "Original memory"),
      );

      const mw = createMemoryRecallMiddleware(createRealFsConfig(dir));
      const request = createModelRequest();

      // Init with 1 file.
      await mw.wrapModelCall?.(
        createTurnCtx(),
        request,
        async (req: ModelRequest): Promise<ModelResponse> => mockNext(req),
      );

      // Add 2nd file — delta should contain 1 new memory.
      await writeFile(
        join(dir, "second.md"),
        makeMemoryFileContent("Second", "feedback", "Second memory"),
      );
      const bump1 = new Date(Date.now() + 5000);
      await utimes(dir, bump1, bump1);

      let req2: ModelRequest | undefined;
      await mw.wrapModelCall?.(createTurnCtx(), request, async (r) => {
        req2 = r;
        return mockNext(r);
      });

      expect(req2).toBeDefined();
      if (req2 === undefined) return;
      // frozen + live (before user) + user
      expect(req2.messages.length).toBe(3);
      expect(req2.messages[1]?.senderId).toBe("system:memory-live");
      const live2 = getMessageText(req2, 1);
      expect(live2).toContain("Second memory");

      // Add 3rd file — delta should contain BOTH additions (second + third).
      await writeFile(
        join(dir, "third.md"),
        makeMemoryFileContent("Third", "reference", "Third memory"),
      );
      const bump2 = new Date(Date.now() + 10_000);
      await utimes(dir, bump2, bump2);

      let req3: ModelRequest | undefined;
      await mw.wrapModelCall?.(createTurnCtx(), request, async (r) => {
        req3 = r;
        return mockNext(r);
      });

      expect(req3).toBeDefined();
      if (req3 === undefined) return;
      expect(req3.messages.length).toBe(3);
      expect(req3.messages[1]?.senderId).toBe("system:memory-live");
      const live3 = getMessageText(req3, 1);
      expect(live3).toContain("Second memory");
      expect(live3).toContain("Third memory");
      expect(live3).not.toContain("Original memory"); // frozen-only, excluded from delta
    });

    test("live delta works in wrapModelStream", async () => {
      await writeFile(
        join(dir, "role.md"),
        makeMemoryFileContent("Role", "user", "Streaming frozen"),
      );

      const mw = createMemoryRecallMiddleware(createRealFsConfig(dir));
      const request = createModelRequest();

      // First stream call — establishes the frozen snapshot.
      async function* firstStream(_req: ModelRequest): AsyncIterable<ModelChunk> {
        yield { kind: "text_delta", delta: "hi" };
      }
      const firstIter = mw.wrapModelStream?.(createTurnCtx(), request, firstStream);
      if (firstIter !== undefined) {
        for await (const _c of firstIter) {
          // drain
        }
      }

      // Add a new memory mid-session.
      await writeFile(
        join(dir, "delta.md"),
        makeMemoryFileContent("Delta", "feedback", "Streaming delta"),
      );
      const future = new Date(Date.now() + 5000);
      await utimes(dir, future, future);

      // Second stream call — live delta should be appended.
      let capturedRequest: ModelRequest | undefined;
      async function* secondStream(req: ModelRequest): AsyncIterable<ModelChunk> {
        capturedRequest = req;
        yield { kind: "text_delta", delta: "hello" };
      }
      const chunks: ModelChunk[] = [];
      const stream = mw.wrapModelStream?.(createTurnCtx(), request, secondStream);
      if (stream !== undefined) {
        for await (const chunk of stream) {
          chunks.push(chunk);
        }
      }

      expect(capturedRequest).toBeDefined();
      if (capturedRequest === undefined) return;
      expect(capturedRequest.messages.length).toBe(3);
      expect(capturedRequest.messages[0]?.senderId).toBe("system:memory-recall");
      expect(capturedRequest.messages[1]?.senderId).toBe("system:memory-live");
      expect(capturedRequest.messages[2]?.senderId).toBe("user");

      const liveText = getMessageText(capturedRequest, 1);
      expect(liveText).toContain("Streaming delta");
      expect(liveText).not.toContain("Streaming frozen");

      // Stream chunks passed through.
      expect(chunks).toHaveLength(1);
      expect(chunks[0]?.kind).toBe("text_delta");
    });

    test("in-place overwrite of a frozen memory surfaces in live delta", async () => {
      // Seed one memory — it will be captured in the frozen snapshot.
      const originalPath = join(dir, "color.md");
      await writeFile(
        originalPath,
        makeMemoryFileContent("Color", "user", "Favorite color is blue"),
      );

      const mw = createMemoryRecallMiddleware(createRealFsConfig(dir));
      const request = createModelRequest();

      // Init — frozen snapshot contains "blue".
      let firstRequest: ModelRequest | undefined;
      const firstNext = async (req: ModelRequest): Promise<ModelResponse> => {
        firstRequest = req;
        return mockNext(req);
      };
      await mw.wrapModelCall?.(createTurnCtx(), request, firstNext);
      expect(firstRequest).toBeDefined();
      if (firstRequest === undefined) return;
      expect(firstRequest.messages.length).toBe(2);
      expect(getMessageText(firstRequest, 0)).toContain("blue");

      // Overwrite the SAME file mid-session (same filePath, new content).
      // This simulates `memory_store` with force=true.
      await writeFile(
        originalPath,
        makeMemoryFileContent("Color", "user", "Favorite color is green"),
      );
      const future = new Date(Date.now() + 5000);
      await utimes(originalPath, future, future);
      await utimes(dir, future, future);

      // Next turn — the live delta MUST surface the updated content.
      // Without the fix, the filter `!frozenPaths.has(filePath)` would
      // exclude this record (same path), leaving the model with stale "blue".
      let secondRequest: ModelRequest | undefined;
      const secondNext = async (req: ModelRequest): Promise<ModelResponse> => {
        secondRequest = req;
        return mockNext(req);
      };
      await mw.wrapModelCall?.(createTurnCtx(), request, secondNext);

      expect(secondRequest).toBeDefined();
      if (secondRequest === undefined) return;
      expect(secondRequest.messages.length).toBe(3);
      expect(secondRequest.messages[1]?.senderId).toBe("system:memory-live");
      expect(secondRequest.messages[2]?.senderId).toBe("user");
      const deltaText = getMessageText(secondRequest, 1);
      expect(deltaText).toContain("green");
    });

    test("live delta respects token budget and drops oldest when over cap", async () => {
      // Seed one frozen memory.
      await writeFile(
        join(dir, "frozen.md"),
        makeMemoryFileContent("Frozen", "user", "Frozen content"),
      );

      // Budget large enough to fit 1-2 medium memories once formatting
      // overhead (XML tags, section headers, JSON metadata) is included.
      const mw = createMemoryRecallMiddleware({
        ...createRealFsConfig(dir),
        liveDeltaMaxTokens: 300,
      });

      // Init — frozen snapshot only.
      const initNext = async (req: ModelRequest): Promise<ModelResponse> => mockNext(req);
      await mw.wrapModelCall?.(createTurnCtx(), createModelRequest(), initNext);

      // Add several new memories, each large enough that fitting all of
      // them would exceed the budget.
      const filler = "filler ".repeat(30); // ~60 tokens per memory content
      for (let i = 0; i < 5; i++) {
        const path = join(dir, `new${String(i)}.md`);
        await writeFile(path, makeMemoryFileContent(`New${String(i)}`, "user", filler));
        // Stagger updatedAt so we can predict which ones get kept (newest first).
        const mtime = new Date(Date.now() + 5000 + i * 1000);
        await utimes(path, mtime, mtime);
      }
      const future = new Date(Date.now() + 20_000);
      await utimes(dir, future, future);

      let capturedRequest: ModelRequest | undefined;
      const next = async (req: ModelRequest): Promise<ModelResponse> => {
        capturedRequest = req;
        return mockNext(req);
      };
      await mw.wrapModelCall?.(createTurnCtx(), createModelRequest(), next);

      expect(capturedRequest).toBeDefined();
      if (capturedRequest === undefined) return;
      // Live delta present — budget forces truncation, doesn't drop the block.
      expect(capturedRequest.messages[1]?.senderId).toBe("system:memory-live");
      const deltaText = getMessageText(capturedRequest, 1);
      // The NEWEST memory (New4) must be in the delta.
      expect(deltaText).toContain("New4");
      // At least one of the oldest must be DROPPED (5 memories with full
      // formatting overhead blow past 300 tokens, so at least one drops).
      const containsAllFive =
        deltaText.includes("New0") &&
        deltaText.includes("New1") &&
        deltaText.includes("New2") &&
        deltaText.includes("New3") &&
        deltaText.includes("New4");
      expect(containsAllFive).toBe(false);
    });

    test("detects in-place overwrite via real memory-fs store (mtime-preserving update)", async () => {
      // Regression: memory-fs update() does atomic write+rename+utimes,
      // stamping mtime BACK to the original createdAt to preserve it.
      // Size changes reliably, so the middleware must use mtime+size to
      // detect these overwrites. Uses the real store (not raw utimes).
      const { createMemoryStore } = await import("@koi/memory-fs");
      const store = createMemoryStore({ dir });

      // Seed via the real store — writes the original memory.
      const first = await store.write({
        name: "Color",
        description: "Favorite color",
        type: "user",
        content: "Favorite color is blue",
      });
      expect(first.action).toBe("created");
      if (first.action !== "created") return;

      const mw = createMemoryRecallMiddleware(createRealFsConfig(dir));
      const request = createModelRequest();

      // Init — frozen captures "blue".
      let firstReq: ModelRequest | undefined;
      await mw.wrapModelCall?.(createTurnCtx(), request, async (r) => {
        firstReq = r;
        return mockNext(r);
      });
      expect(firstReq).toBeDefined();
      if (firstReq === undefined) return;
      expect(getMessageText(firstReq, 0)).toContain("blue");

      // Overwrite via the real store's update() — this is what
      // memory_store force=true triggers in production. The update
      // stamps mtime back to createdAt, so mtime-only detection would miss
      // it. Size changes (blue=15 chars vs green-much-longer), so the
      // signature comparison catches it.
      await store.update(first.record.id, {
        content: "Favorite color is actually green and has always been",
      });

      // Next turn — live delta MUST include the updated memory.
      let secondReq: ModelRequest | undefined;
      await mw.wrapModelCall?.(createTurnCtx(), request, async (r) => {
        secondReq = r;
        return mockNext(r);
      });
      expect(secondReq).toBeDefined();
      if (secondReq === undefined) return;
      expect(secondReq.messages.length).toBe(3);
      expect(secondReq.messages[1]?.senderId).toBe("system:memory-live");
      const deltaText = getMessageText(secondReq, 1);
      expect(deltaText).toContain("green");
    });

    test("injection preserves canonical order: frozen -> prior -> live -> user", async () => {
      // Seed frozen memory.
      await writeFile(
        join(dir, "role.md"),
        makeMemoryFileContent("Role", "user", "Frozen context"),
      );

      const mw = createMemoryRecallMiddleware(createRealFsConfig(dir));

      // Prior conversation has a user turn + an assistant turn + current user.
      const request: ModelRequest = {
        messages: [
          {
            content: [{ kind: "text", text: "prior user question" }],
            senderId: "user",
            timestamp: Date.now() - 2000,
          },
          {
            content: [{ kind: "text", text: "prior assistant reply" }],
            senderId: "assistant",
            timestamp: Date.now() - 1000,
          },
          {
            content: [{ kind: "text", text: "current user question" }],
            senderId: "user",
            timestamp: Date.now(),
          },
        ],
      };

      // Init — frozen only, no delta.
      await mw.wrapModelCall?.(createTurnCtx(), request, async (r) => mockNext(r));

      // Store a new memory mid-session to force a delta.
      await writeFile(
        join(dir, "update.md"),
        makeMemoryFileContent("Update", "user", "Mid-session addition"),
      );
      const bump = new Date(Date.now() + 5000);
      await utimes(dir, bump, bump);

      let captured: ModelRequest | undefined;
      await mw.wrapModelCall?.(createTurnCtx(), request, async (r) => {
        captured = r;
        return mockNext(r);
      });

      expect(captured).toBeDefined();
      if (captured === undefined) return;
      // Expected order: frozen(0) -> prior_user(1) -> prior_assistant(2) ->
      //                 live_delta(3) -> current_user(4).
      // Crucially: live delta is BEFORE the current user message, not after.
      expect(captured.messages.length).toBe(5);
      expect(captured.messages[0]?.senderId).toBe("system:memory-recall");
      expect(captured.messages[1]?.senderId).toBe("user");
      expect(getMessageText(captured, 1)).toBe("prior user question");
      expect(captured.messages[2]?.senderId).toBe("assistant");
      expect(captured.messages[3]?.senderId).toBe("system:memory-live");
      expect(captured.messages[4]?.senderId).toBe("user");
      expect(getMessageText(captured, 4)).toBe("current user question");
    });
  });
});
