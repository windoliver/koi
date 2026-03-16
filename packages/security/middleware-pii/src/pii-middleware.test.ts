import { describe, expect, mock, test } from "bun:test";
import type { JsonObject } from "@koi/core/common";
import type { InboundMessage } from "@koi/core/message";
import type { ModelChunk, ModelRequest, ModelResponse, ToolResponse } from "@koi/core/middleware";
import { createMockTurnContext, testMiddlewareContract } from "@koi/test-utils";
import { createPIIMiddleware } from "./pii-middleware.js";

function createRequest(text: string): ModelRequest {
  return {
    messages: [
      {
        senderId: "user",
        timestamp: Date.now(),
        content: [{ kind: "text" as const, text }],
      },
    ] satisfies readonly InboundMessage[],
    model: "test-model",
  };
}

function createResponse(content: string): ModelResponse {
  return { content, model: "test-model" };
}

/** Extract text from the first text block of the first message. */
function firstText(request: ModelRequest): string {
  return (request.messages[0]?.content[0] as { text: string }).text;
}

describe("createPIIMiddleware", () => {
  test("throws on invalid config", () => {
    expect(() => createPIIMiddleware({ strategy: "invalid" as "redact" })).toThrow();
  });

  test("throws when hash strategy missing hashSecret", () => {
    expect(() => createPIIMiddleware({ strategy: "hash" })).toThrow();
  });

  test("creates middleware with valid config", () => {
    const mw = createPIIMiddleware({ strategy: "redact" });
    expect(mw.name).toBe("pii");
    expect(mw.priority).toBe(340);
  });
});

describe("middleware contract", () => {
  testMiddlewareContract({
    createMiddleware: () => createPIIMiddleware({ strategy: "redact" }),
  });
});

describe("wrapModelCall — input scanning", () => {
  test("redacts PII in input messages (default scope)", async () => {
    const mw = createPIIMiddleware({ strategy: "redact" });
    const ctx = createMockTurnContext();
    const request = createRequest("Contact user@example.com");

    // let justified: captured inside callback for inspection
    let capturedRequest: ModelRequest | undefined;
    await mw.wrapModelCall?.(ctx, request, async (req) => {
      capturedRequest = req;
      return createResponse("ok");
    });

    expect(capturedRequest).toBeDefined();
    if (capturedRequest === undefined) throw new Error("capturedRequest should be defined");
    expect(firstText(capturedRequest)).toBe("Contact [REDACTED_EMAIL]");
  });

  test("calls onDetection callback on input PII", async () => {
    // let justified: tracking callback args
    let detectionLocation = "";
    const onDetection = mock((_matches: readonly unknown[], location: string) => {
      detectionLocation = location;
    });
    const mw = createPIIMiddleware({ strategy: "redact", onDetection });
    const ctx = createMockTurnContext();

    await mw.wrapModelCall?.(ctx, createRequest("user@test.com"), async () => createResponse("ok"));
    expect(onDetection).toHaveBeenCalledTimes(1);
    expect(detectionLocation).toBe("input");
  });

  test("passes through clean messages unchanged", async () => {
    const mw = createPIIMiddleware({ strategy: "redact" });
    const ctx = createMockTurnContext();
    const request = createRequest("nothing special");

    // let justified: captured inside callback for inspection
    let capturedRequest: ModelRequest | undefined;
    await mw.wrapModelCall?.(ctx, request, async (req) => {
      capturedRequest = req;
      return createResponse("ok");
    });

    expect(capturedRequest).toBe(request);
  });
});

describe("wrapModelCall — output scanning", () => {
  test("redacts PII in output when output scope enabled", async () => {
    const mw = createPIIMiddleware({
      strategy: "redact",
      scope: { input: false, output: true },
    });
    const ctx = createMockTurnContext();

    const response = await mw.wrapModelCall?.(ctx, createRequest("hi"), async () =>
      createResponse("Reply to user@test.com"),
    );
    expect(response?.content).toBe("Reply to [REDACTED_EMAIL]");
  });

  test("throws on block strategy with output PII", async () => {
    const mw = createPIIMiddleware({
      strategy: "block",
      scope: { input: false, output: true },
    });
    const ctx = createMockTurnContext();

    expect(
      mw.wrapModelCall?.(ctx, createRequest("hi"), async () =>
        createResponse("Secret: user@test.com"),
      ),
    ).rejects.toThrow("Model output contains PII");
  });
});

describe("wrapToolCall — tool results scanning", () => {
  test("redacts PII in tool output when toolResults scope enabled", async () => {
    const mw = createPIIMiddleware({
      strategy: "redact",
      scope: { input: false, toolResults: true },
    });
    const ctx = createMockTurnContext();
    const toolRequest = { toolId: "search", input: {} satisfies JsonObject };
    const toolResponse: ToolResponse = {
      output: { result: "Found user@test.com" },
    };

    const response = await mw.wrapToolCall?.(ctx, toolRequest, async () => toolResponse);
    expect((response?.output as Record<string, unknown>).result).toBe("Found [REDACTED_EMAIL]");
  });

  test("passes through when toolResults scope disabled", async () => {
    const mw = createPIIMiddleware({
      strategy: "redact",
      scope: { input: false, toolResults: false },
    });
    const ctx = createMockTurnContext();
    const toolRequest = { toolId: "search", input: {} satisfies JsonObject };
    const toolResponse: ToolResponse = {
      output: { result: "Found user@test.com" },
    };

    const response = await mw.wrapToolCall?.(ctx, toolRequest, async () => toolResponse);
    expect(response).toBe(toolResponse);
  });
});

describe("wrapModelStream — output scanning", () => {
  test("scans streaming text deltas when output scope enabled", async () => {
    const mw = createPIIMiddleware({
      strategy: "redact",
      scope: { input: false, output: true },
    });
    const ctx = createMockTurnContext();

    async function* mockStream(): AsyncIterable<ModelChunk> {
      yield { kind: "text_delta", delta: "Email: user@" };
      yield { kind: "text_delta", delta: "example.com here" };
      yield { kind: "done", response: createResponse("Email: user@example.com here") };
    }

    const chunks: ModelChunk[] = [];
    // biome-ignore lint/style/noNonNullAssertion: hook is guaranteed to exist on created middleware
    for await (const chunk of mw.wrapModelStream!(ctx, createRequest("hi"), () => mockStream())) {
      chunks.push(chunk);
    }

    // Should have yielded at least one text_delta and a done chunk
    const textChunks = chunks.filter((c) => c.kind === "text_delta");
    const combined = textChunks.map((c) => (c as { delta: string }).delta).join("");
    expect(combined).toContain("[REDACTED_EMAIL]");
    expect(combined).not.toContain("user@example.com");
  });

  test("passes through when output scope disabled", async () => {
    const mw = createPIIMiddleware({
      strategy: "redact",
      scope: { input: true, output: false },
    });
    const ctx = createMockTurnContext();

    async function* mockStream(): AsyncIterable<ModelChunk> {
      yield { kind: "text_delta", delta: "user@example.com" };
      yield { kind: "done", response: createResponse("user@example.com") };
    }

    const chunks: ModelChunk[] = [];
    // biome-ignore lint/style/noNonNullAssertion: hook is guaranteed to exist on created middleware
    for await (const chunk of mw.wrapModelStream!(ctx, createRequest("hi"), () => mockStream())) {
      chunks.push(chunk);
    }

    const textChunks = chunks.filter((c) => c.kind === "text_delta");
    const combined = textChunks.map((c) => (c as { delta: string }).delta).join("");
    expect(combined).toBe("user@example.com");
  });

  test("block strategy downgrades to redact in streaming mode", async () => {
    const mw = createPIIMiddleware({
      strategy: "block",
      scope: { input: false, output: true },
    });
    const ctx = createMockTurnContext();

    async function* mockStream(): AsyncIterable<ModelChunk> {
      yield { kind: "text_delta", delta: "Email: user@" };
      yield { kind: "text_delta", delta: "example.com here" };
      yield { kind: "done", response: createResponse("Email: user@example.com here") };
    }

    // Should NOT throw — block is downgraded to redact for streaming
    const chunks: ModelChunk[] = [];
    // biome-ignore lint/style/noNonNullAssertion: hook is guaranteed to exist on created middleware
    for await (const chunk of mw.wrapModelStream!(ctx, createRequest("hi"), () => mockStream())) {
      chunks.push(chunk);
    }

    const textChunks = chunks.filter((c) => c.kind === "text_delta");
    const combined = textChunks.map((c) => (c as { delta: string }).delta).join("");
    expect(combined).toContain("[REDACTED_EMAIL]");
    expect(combined).not.toContain("user@example.com");
  });

  test("block strategy calls onDetection during streaming redact", async () => {
    const onDetection = mock((_matches: readonly unknown[], _location: string) => {});
    const mw = createPIIMiddleware({
      strategy: "block",
      scope: { input: false, output: true },
      onDetection,
    });
    const ctx = createMockTurnContext();

    async function* mockStream(): AsyncIterable<ModelChunk> {
      yield { kind: "text_delta", delta: "Secret: user@test.com is leaked" };
      yield { kind: "done", response: createResponse("Secret: user@test.com is leaked") };
    }

    const chunks: ModelChunk[] = [];
    // biome-ignore lint/style/noNonNullAssertion: hook is guaranteed to exist on created middleware
    for await (const chunk of mw.wrapModelStream!(ctx, createRequest("hi"), () => mockStream())) {
      chunks.push(chunk);
    }

    expect(onDetection).toHaveBeenCalled();
  });
});

describe("hash strategy", () => {
  test("hashes PII with HMAC-SHA256", async () => {
    const mw = createPIIMiddleware({
      strategy: "hash",
      hashSecret: "my-secret-key",
    });
    const ctx = createMockTurnContext();
    const request = createRequest("user@test.com");

    // let justified: captured inside callback for inspection
    let capturedRequest: ModelRequest | undefined;
    await mw.wrapModelCall?.(ctx, request, async (req) => {
      capturedRequest = req;
      return createResponse("ok");
    });

    expect(capturedRequest).toBeDefined();
    if (capturedRequest === undefined) throw new Error("capturedRequest should be defined");
    expect(firstText(capturedRequest)).toMatch(/^<email:[0-9a-f]{16}>$/);
  });
});

describe("mask strategy", () => {
  test("masks PII preserving partial info", async () => {
    const mw = createPIIMiddleware({ strategy: "mask" });
    const ctx = createMockTurnContext();
    const request = createRequest("john@example.com");

    // let justified: captured inside callback for inspection
    let capturedRequest: ModelRequest | undefined;
    await mw.wrapModelCall?.(ctx, request, async (req) => {
      capturedRequest = req;
      return createResponse("ok");
    });

    expect(capturedRequest).toBeDefined();
    if (capturedRequest === undefined) throw new Error("capturedRequest should be defined");
    expect(firstText(capturedRequest)).toBe("j***@example.com");
  });
});

describe("describeCapabilities", () => {
  test("is defined on the middleware", () => {
    const mw = createPIIMiddleware({ strategy: "redact" });
    expect(mw.describeCapabilities).toBeDefined();
  });

  test("returns label 'pii' and description containing 'PII'", () => {
    const mw = createPIIMiddleware({ strategy: "redact" });
    const ctx = createMockTurnContext();
    const result = mw.describeCapabilities?.(ctx);
    expect(result?.label).toBe("pii");
    expect(result?.description).toContain("PII");
  });
});
