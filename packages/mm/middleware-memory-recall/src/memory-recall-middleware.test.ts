import { beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
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
});
