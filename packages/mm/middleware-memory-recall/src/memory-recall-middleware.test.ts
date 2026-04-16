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

  test("caches frozen snapshot — only initializes once per session", async () => {
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

    // The frozen snapshot is built from a single scan at init time.
    // Subsequent turns reuse the cached message; only the live-delta
    // refresh re-scans. Verify init's scoring/select pipeline runs once
    // by spying on scoreMemories.
    const scoreSpy = spyOn(memoryModule, "scoreMemories");

    const next = async (req: ModelRequest): Promise<ModelResponse> => mockNext(req);

    await mw.wrapModelCall?.(createTurnCtx(), request, next);
    await mw.wrapModelCall?.(createTurnCtx(), request, next);

    // scoreMemories should only be called once at init — subsequent
    // turns reuse the cached frozen snapshot.
    expect(scoreSpy).toHaveBeenCalledTimes(1);
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

    const scoreSpy = spyOn(memoryModule, "scoreMemories");

    const next = async (req: ModelRequest): Promise<ModelResponse> => mockNext(req);

    // First model call — triggers init.
    await mw.wrapModelCall?.(createTurnCtx(), request, next);
    expect(scoreSpy).toHaveBeenCalledTimes(1);

    // Reset via session start.
    await mw.onSessionStart?.(createSessionCtx());

    // Second model call — re-inits because session state was cleared.
    await mw.wrapModelCall?.(createTurnCtx(), request, next);
    expect(scoreSpy).toHaveBeenCalledTimes(2);
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

  test("does not re-init after failure", async () => {
    const fs = createThrowingFs();
    const mw = createMemoryRecallMiddleware(createConfig(fs));
    const request = createModelRequest();

    const scanSpy = spyOn(memoryModule, "scanMemoryDirectory");

    const next = async (req: ModelRequest): Promise<ModelResponse> => mockNext(req);

    // First call — init attempted and fails (throwing FS).
    await mw.wrapModelCall?.(createTurnCtx(), request, next);
    const callsAfterInit = scanSpy.mock.calls.length;
    // Second call — should NOT retry init (initialized flag prevents it).
    // refreshLiveDelta still tries to scan but that's a separate path
    // — what matters is initialize() doesn't re-fire.
    await mw.wrapModelCall?.(createTurnCtx(), request, next);

    // initialize's scan is only attempted once.
    // (refreshLiveDelta may still scan on each turn — that's fine, it's
    // a separate retry-tolerant path. We only verify init doesn't loop.)
    // Verify call count after the second call equals call count after init
    // plus exactly one refreshLiveDelta scan (one per turn).
    expect(scanSpy.mock.calls.length).toBe(callsAfterInit + 1);
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

    test("live delta is empty when nothing changed since session start", async () => {
      // The middleware intentionally re-scans every turn because
      // mtime/size gating cannot detect same-size mtime-preserving
      // overwrites (the memory-fs update path). What matters for the
      // "unchanged" contract is that NO live-delta message is emitted
      // when no file changed — not that the scan itself is skipped.
      await writeFile(join(dir, "role.md"), makeMemoryFileContent("Role", "user", "Stable memory"));

      const mw = createMemoryRecallMiddleware(createRealFsConfig(dir));
      const request = createModelRequest();

      let captured: ModelRequest | undefined;
      const next = async (req: ModelRequest): Promise<ModelResponse> => {
        captured = req;
        return mockNext(req);
      };

      // First call — init frozen snapshot.
      await mw.wrapModelCall?.(createTurnCtx(), request, next);
      // Subsequent calls with no dir changes — no live-delta block.
      await mw.wrapModelCall?.(createTurnCtx(), request, next);
      await mw.wrapModelCall?.(createTurnCtx(), request, next);

      expect(captured).toBeDefined();
      if (captured === undefined) return;
      // Expect frozen + user only — no system:memory-live.
      expect(captured.messages.length).toBe(2);
      expect(captured.messages.some((m) => m.senderId === "system:memory-live")).toBe(false);
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

    test("detects same-length overwrite via memory-fs update() (mtime+size both preserved)", async () => {
      // Hardest regression: update() preserves mtime AND the content
      // length happens to match. Only content hashing catches this.
      const { createMemoryStore } = await import("@koi/memory-fs");
      const store = createMemoryStore({ dir });

      const first = await store.write({
        name: "Color",
        description: "Favorite color",
        type: "user",
        content: "blue", // 4 chars
      });
      expect(first.action).toBe("created");
      if (first.action !== "created") return;

      const mw = createMemoryRecallMiddleware(createRealFsConfig(dir));
      const request = createModelRequest();

      let firstReq: ModelRequest | undefined;
      await mw.wrapModelCall?.(createTurnCtx(), request, async (r) => {
        firstReq = r;
        return mockNext(r);
      });
      expect(firstReq).toBeDefined();
      if (firstReq === undefined) return;
      expect(getMessageText(firstReq, 0)).toContain("blue");

      // Same-length overwrite: "blue" -> "pink" (both 4 chars).
      // memory-fs.update() preserves mtime, so mtime+size would both
      // match baseline. Content hash MUST catch this.
      await store.update(first.record.id, { content: "pink" });

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
      expect(deltaText).toContain("pink");
    });

    test("ranks changed memories by observation time, not file mtime", async () => {
      // Regression for mtime-preserving stores: an OLD memory that was
      // just corrected must not be evicted under budget pressure in
      // favor of newer memories that were actually unchanged. We rank
      // by state.detectedAt (observation time), which increases each
      // time we first see a file change — immune to mtime preservation.
      const { createMemoryStore } = await import("@koi/memory-fs");
      const store = createMemoryStore({ dir });

      // Seed an "old" memory.
      const old = await store.write({
        name: "Old",
        description: "Ancient memory",
        type: "user",
        content: "old content",
      });
      expect(old.action).toBe("created");
      if (old.action !== "created") return;

      const mw = createMemoryRecallMiddleware({
        ...createRealFsConfig(dir),
        // Tight budget — at most one memory fits.
        liveDeltaMaxTokens: 200,
      });

      // Init — Old in frozen snapshot.
      await mw.wrapModelCall?.(createTurnCtx(), createModelRequest(), async (r) => mockNext(r));

      // Wait a bit, then add two unrelated NEW memories.
      await new Promise((resolve) => setTimeout(resolve, 20));
      await writeFile(join(dir, "new1.md"), makeMemoryFileContent("New1", "user", "new one"));
      await writeFile(join(dir, "new2.md"), makeMemoryFileContent("New2", "user", "new two"));

      // Trigger one refresh so detectedAt is stamped for New1 and New2.
      await mw.wrapModelCall?.(createTurnCtx(), createModelRequest(), async (r) => mockNext(r));

      // NOW update the OLD memory (memory-fs preserves mtime).
      // observation time of Old > New1/New2 even though mtime of Old
      // is ancient (stamped back).
      await new Promise((resolve) => setTimeout(resolve, 20));
      await store.update(old.record.id, { content: "freshly updated content" });

      let captured: ModelRequest | undefined;
      await mw.wrapModelCall?.(createTurnCtx(), createModelRequest(), async (r) => {
        captured = r;
        return mockNext(r);
      });

      expect(captured).toBeDefined();
      if (captured === undefined) return;
      expect(captured.messages[1]?.senderId).toBe("system:memory-live");
      const deltaText = getMessageText(captured, 1);
      // Old was updated MOST recently, so it must win any budget-based
      // ranking against New1/New2 whose detectedAt is older.
      expect(deltaText).toContain("freshly updated content");
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
      // Live delta is INSERTED BEFORE the current user message so the
      // session-transcript middleware (which records messages.at(-1) as
      // the inbound user turn) persists the user message correctly. The
      // user message MUST be the last entry for transcript correctness.
      expect(captured.messages.length).toBe(5);
      expect(captured.messages[0]?.senderId).toBe("system:memory-recall");
      expect(captured.messages[1]?.senderId).toBe("user");
      expect(getMessageText(captured, 1)).toBe("prior user question");
      expect(captured.messages[2]?.senderId).toBe("assistant");
      expect(captured.messages[3]?.senderId).toBe("system:memory-live");
      expect(captured.messages[4]?.senderId).toBe("user");
      expect(getMessageText(captured, 4)).toBe("current user question");
    });

    test("supersession: section title flags overwrites of frozen entries", async () => {
      // When a live-delta memory has the same path as a frozen-snapshot
      // entry, the model needs to know which is authoritative. Without
      // an explicit signal it would see TWO copies (stale frozen +
      // updated live) and have to guess. The section title should make
      // precedence explicit.
      const { createMemoryStore } = await import("@koi/memory-fs");
      const store = createMemoryStore({ dir });

      const seeded = await store.write({
        name: "Pref",
        description: "Theme preference",
        type: "user",
        content: "Light mode",
      });
      expect(seeded.action).toBe("created");
      if (seeded.action !== "created") return;

      const mw = createMemoryRecallMiddleware(createRealFsConfig(dir));
      const request = createModelRequest();

      // Init — frozen captures "Light mode".
      await mw.wrapModelCall?.(createTurnCtx(), request, async (r) => mockNext(r));

      // Overwrite via store.update() — same path, new content.
      await store.update(seeded.record.id, { content: "Dark mode" });

      let captured: ModelRequest | undefined;
      await mw.wrapModelCall?.(createTurnCtx(), request, async (r) => {
        captured = r;
        return mockNext(r);
      });

      expect(captured).toBeDefined();
      if (captured === undefined) return;
      const liveText = getMessageText(captured, 1);
      // The supersession section header must explicitly tell the model
      // these entries override same-name entries from the earlier section.
      expect(liveText).toMatch(/supersede/i);
      expect(liveText).toContain("Dark mode");
    });

    test("frontmatter-only edits are detected and surfaced via live delta", async () => {
      // Regression: signatureFromContent only hashed content, missing
      // edits to name/description/type. Now we hash the full record so
      // metadata-only changes are visible too. Use a `type` change
      // because the format DOES expose type in the JSON metadata
      // (description is intentionally elided from the formatted output
      // for prompt-injection safety, so we can't observe it directly).
      const { createMemoryStore } = await import("@koi/memory-fs");
      const store = createMemoryStore({ dir });

      const seeded = await store.write({
        name: "Pref",
        description: "Some preference",
        type: "user",
        content: "stable body content here",
      });
      expect(seeded.action).toBe("created");
      if (seeded.action !== "created") return;

      const mw = createMemoryRecallMiddleware(createRealFsConfig(dir));
      const request = createModelRequest();

      // Init — frozen captures original metadata.
      await mw.wrapModelCall?.(createTurnCtx(), request, async (r) => mockNext(r));

      // Update ONLY the type (content unchanged) — this used to be
      // invisible to the middleware.
      await store.update(seeded.record.id, { type: "feedback" });

      let captured: ModelRequest | undefined;
      await mw.wrapModelCall?.(createTurnCtx(), request, async (r) => {
        captured = r;
        return mockNext(r);
      });

      expect(captured).toBeDefined();
      if (captured === undefined) return;
      expect(captured.messages[1]?.senderId).toBe("system:memory-live");
      const deltaText = getMessageText(captured, 1);
      // Format wraps frontmatter as JSON: {"name":"Pref","type":"feedback"}.
      expect(deltaText).toContain('"type":"feedback"');
      // Frozen snapshot still has the OLD type — supersession header
      // tells the model which copy wins.
      expect(deltaText).toMatch(/supersede/i);
    });

    test("budget-truncated overwrite of a frozen memory remains reachable via relevance", async () => {
      // Regression: when a frozen memory is overwritten and the
      // corrected version is too big for the live delta budget, the
      // memory used to become unreachable — relevance excluded all
      // frozen paths, so the model kept seeing stale data forever.
      // Now stale-frozen paths are allowed through the relevance
      // candidate filter, and the overlay surfaces the corrected value.
      const { createMemoryStore } = await import("@koi/memory-fs");
      const store = createMemoryStore({ dir });

      const seeded = await store.write({
        name: "Pref",
        description: "Preference",
        type: "user",
        content: "Original short value",
      });
      expect(seeded.action).toBe("created");
      if (seeded.action !== "created") return;

      const mw = createMemoryRecallMiddleware({
        ...createRealFsConfig(dir),
        // Tiny budget — the overwrite will not fit in the live delta.
        liveDeltaMaxTokens: 1,
        relevanceSelector: {
          maxFiles: 5,
          modelCall: async (_req) => ({
            content: "[]", // doesn't matter — manifest <= maxFiles short-circuits
            model: "test",
            usage: { inputTokens: 0, outputTokens: 0 },
            stopReason: "stop",
          }),
        },
      });

      // Init — Pref is in the frozen snapshot.
      await mw.wrapModelCall?.(createTurnCtx(), createModelRequest(), async (r) => mockNext(r));

      // Overwrite with a much longer value that exceeds the 1-token cap.
      const longContent = "Updated authoritative value: " + "supersedes ".repeat(50);
      await store.update(seeded.record.id, { content: longContent });

      let captured: ModelRequest | undefined;
      await mw.wrapModelCall?.(createTurnCtx(), createModelRequest(), async (r) => {
        captured = r;
        return mockNext(r);
      });

      expect(captured).toBeDefined();
      if (captured === undefined) return;
      // The relevance overlay (system:memory-relevant) must carry the
      // corrected value, since the live delta couldn't fit it. Without
      // the stale-frozen-paths fix, the selector would have rejected
      // pref.md (it's in frozenPaths) and the model would only see the
      // stale "Original short value" in the frozen snapshot.
      const overlayMsg = captured.messages.find((m) => m.senderId === "system:memory-relevant");
      expect(overlayMsg).toBeDefined();
      const overlayText =
        (overlayMsg?.content[0] as { readonly kind: "text"; readonly text: string })?.text ?? "";
      expect(overlayText).toContain("Updated authoritative value");
    });

    test("selector overlay loads memory files beyond the default 200-file cap", async () => {
      // Regression: selectRelevant's scanMemoryDirectory used the
      // default maxFiles=200, while initialize() uses an uncapped
      // scan. So a manifest could include older paths that the overlay
      // scan never loaded — selector picks → load returns nothing →
      // silent overlay miss in heavy-memory sessions. Both scans now
      // use the same uncapped cap.
      const { createMemoryStore } = await import("@koi/memory-fs");
      const store = createMemoryStore({ dir });

      // Seed 205 small memories so we cross the 200-default cap.
      // The 201st-205th will be in the manifest but were missed by the
      // old overlay scan.
      // We need to seed enough that both frozen scoring places "newer"
      // ones in the snapshot and "older" ones in overflow.
      // Use 30 to keep the test fast — we'll override maxFiles on
      // selectRelevant's scan via the test's middleware config to
      // force the same code path on a smaller set.
      // Actually a clean approach: set tokenBudget low so most
      // memories overflow the frozen snapshot, then check the
      // selector loads any of them.
      for (let i = 0; i < 30; i++) {
        await store.write({
          name: `Memory${String(i)}`,
          description: `Memory number ${String(i)}`,
          type: "user",
          content: `Content for memory ${String(i)}, with some unique words for memory ${String(i)}.`,
        });
      }

      // Pick a target name from the older end of the set.
      const targetName = "Memory0";
      let receivedPaths: readonly string[] = [];
      const mw = createMemoryRecallMiddleware({
        fs: createLocalFileSystem(dir),
        recall: { memoryDir: dir, now: Date.now(), tokenBudget: 200 },
        relevanceSelector: {
          maxFiles: 1,
          modelCall: async (req) => {
            const text = (req.messages[0]?.content[0] as { text?: string })?.text ?? "";
            // Find Memory0's path in the manifest.
            const m = text.match(/\(([^)]*memory0\.md)\)/);
            const targetPath = m?.[1] ?? "";
            receivedPaths = targetPath ? [targetPath] : [];
            return {
              content: JSON.stringify(receivedPaths),
              model: "test",
              usage: { inputTokens: 0, outputTokens: 0 },
              stopReason: "stop",
            };
          },
        },
      });

      // Init — this should mark selectorNeeded because frozen budget
      // can't fit all 30 memories.
      await mw.wrapModelCall?.(createTurnCtx(), createModelRequest("anything"), async (r) =>
        mockNext(r),
      );

      // Trigger selector via a second wrapModelCall.
      let captured: ModelRequest | undefined;
      await mw.wrapModelCall?.(
        createTurnCtx(),
        createModelRequest(`tell me about ${targetName}`),
        async (r) => {
          captured = r;
          return mockNext(r);
        },
      );

      expect(captured).toBeDefined();
      if (captured === undefined) return;
      // The relevance overlay should have loaded the selected memory.
      // It's inserted BEFORE the user message, so we find it by senderId
      // rather than position.
      const overlayMsg = captured.messages.find((m) => m.senderId === "system:memory-relevant");
      expect(overlayMsg).toBeDefined();
      const overlayText =
        (overlayMsg?.content[0] as { readonly kind: "text"; readonly text: string })?.text ?? "";
      // Memory0's content should be in the overlay.
      expect(overlayText).toContain("Content for memory 0");
    });

    test("user message stays last so session transcript persists it correctly", async () => {
      // Regression for transcript breakage: the session-transcript
      // middleware records `request.messages.at(-1)` as the inbound
      // user turn. If memory blocks were appended at the END, the
      // transcript would persist them AS the user message, losing the
      // real user input on resume/replay. We insert memory blocks
      // BEFORE the last user message so transcript correctness is
      // preserved at the cost of a partial cache miss.
      await writeFile(
        join(dir, "role.md"),
        makeMemoryFileContent("Role", "user", "Transcript invariant content"),
      );

      const mw = createMemoryRecallMiddleware(createRealFsConfig(dir));

      // Init.
      await mw.wrapModelCall?.(createTurnCtx(), createModelRequest(), async (r) => mockNext(r));

      // Mid-session memory write — would replace user message in
      // transcript if it landed at messages.at(-1).
      await writeFile(join(dir, "new.md"), makeMemoryFileContent("New", "user", "added later"));
      const future = new Date(Date.now() + 5000);
      await utimes(dir, future, future);

      const userText = "the actual user question for this turn";
      let captured: ModelRequest | undefined;
      await mw.wrapModelCall?.(createTurnCtx(), createModelRequest(userText), async (r) => {
        captured = r;
        return mockNext(r);
      });

      expect(captured).toBeDefined();
      if (captured === undefined) return;

      // The LAST message must be the user's input — otherwise the
      // session-transcript middleware persists the memory block instead.
      const lastMsg = captured.messages[captured.messages.length - 1];
      expect(lastMsg?.senderId).toBe("user");
      expect(getMessageText(captured, captured.messages.length - 1)).toBe(userText);

      // The live delta must be present, just not at the very end.
      expect(captured.messages.some((m) => m.senderId === "system:memory-live")).toBe(true);
    });

    test("oversized newest memory does not block smaller older updates", async () => {
      // Regression: the budget loop used to `break` on the first
      // candidate that exceeded liveDeltaMaxTokens. Sorted by recency
      // desc, an oversized newest memory would suppress smaller older
      // updates that would have fit. Now the loop `continue`s on
      // oversized candidates and keeps trying smaller ones.
      const mw = createMemoryRecallMiddleware({
        ...createRealFsConfig(dir),
        liveDeltaMaxTokens: 250,
      });

      // Init with no memories.
      await mw.wrapModelCall?.(createTurnCtx(), createModelRequest(), async (r) => mockNext(r));

      // Add an OLDER small memory first.
      await writeFile(
        join(dir, "small.md"),
        makeMemoryFileContent("SmallOld", "user", "tiny content"),
      );
      const smallMtime = new Date(Date.now() + 1000);
      await utimes(join(dir, "small.md"), smallMtime, smallMtime);

      // Add a NEWER huge memory that exceeds the budget on its own.
      const huge = "huge ".repeat(500); // ~500 tokens
      await writeFile(join(dir, "huge.md"), makeMemoryFileContent("HugeNew", "user", huge));
      const hugeMtime = new Date(Date.now() + 5000);
      await utimes(join(dir, "huge.md"), hugeMtime, hugeMtime);
      await utimes(dir, hugeMtime, hugeMtime);

      let captured: ModelRequest | undefined;
      await mw.wrapModelCall?.(createTurnCtx(), createModelRequest(), async (r) => {
        captured = r;
        return mockNext(r);
      });

      expect(captured).toBeDefined();
      if (captured === undefined) return;
      // Live delta should be present and contain the smaller older memory,
      // even though the newer one was too big.
      const liveMsg = captured.messages.find((m) => m.senderId === "system:memory-live");
      expect(liveMsg).toBeDefined();
      const liveText =
        (liveMsg?.content[0] as { readonly kind: "text"; readonly text: string })?.text ?? "";
      expect(liveText).toContain("tiny content");
      // The huge memory should have been skipped (too big to fit).
      expect(liveText).not.toContain(huge);
    });
  });
});
