import { describe, expect, test } from "bun:test";
import type { ModelChunk, ModelRequest, ModelResponse, ToolRequest } from "@koi/core/middleware";
import { KoiRuntimeError } from "@koi/errors";
import {
  createMockInboundMessage,
  createMockModelHandler,
  createMockModelStreamHandler,
  createMockToolHandler,
  createMockTurnContext,
  createSpyModelHandler,
  createSpyToolHandler,
} from "@koi/test-utils";
import type { SanitizeMiddlewareConfig } from "./config.js";
import { createSanitizeMiddleware } from "./sanitize-middleware.js";
import type { SanitizationEvent, SanitizeRule } from "./types.js";

const STRIP_RULE: SanitizeRule = {
  name: "test-strip",
  pattern: /badword/i,
  action: { kind: "strip", replacement: "[X]" },
};

const BLOCK_RULE: SanitizeRule = {
  name: "test-block",
  pattern: /evil/i,
  action: { kind: "block", reason: "blocked" },
};

const ctx = createMockTurnContext();

function makeModelRequest(text: string): ModelRequest {
  return { messages: [createMockInboundMessage({ text })] };
}

function makeToolRequest(input: Record<string, unknown>): ToolRequest {
  return { toolId: "test-tool", input };
}

function makeConfig(overrides?: Partial<SanitizeMiddlewareConfig>): SanitizeMiddlewareConfig {
  return { rules: [STRIP_RULE], ...overrides };
}

describe("createSanitizeMiddleware", () => {
  test("has correct name and priority", () => {
    const mw = createSanitizeMiddleware(makeConfig());
    expect(mw.name).toBe("sanitize");
    expect(mw.priority).toBe(350);
  });

  describe("wrapModelCall", () => {
    test("sanitizes input messages", async () => {
      const mw = createSanitizeMiddleware(makeConfig());
      const spy = createSpyModelHandler({ content: "clean" });
      const request = makeModelRequest("hello badword");

      await mw.wrapModelCall?.(ctx, request, spy.handler);

      expect(spy.calls[0]?.messages[0]?.content[0]).toEqual({
        kind: "text",
        text: "hello [X]",
      });
    });

    test("sanitizes output content", async () => {
      const mw = createSanitizeMiddleware(makeConfig());
      const handler = createMockModelHandler({ content: "response badword" });

      const response = await mw.wrapModelCall?.(ctx, makeModelRequest("clean"), handler);

      expect(response?.content).toBe("response [X]");
    });

    test("throws on input block", async () => {
      const mw = createSanitizeMiddleware(makeConfig({ rules: [BLOCK_RULE] }));
      const handler = createMockModelHandler();

      try {
        await mw.wrapModelCall?.(ctx, makeModelRequest("evil input"), handler);
        expect(true).toBe(false);
      } catch (e: unknown) {
        expect(e).toBeInstanceOf(KoiRuntimeError);
        expect((e as KoiRuntimeError).code).toBe("VALIDATION");
      }
    });

    test("throws on output block", async () => {
      const mw = createSanitizeMiddleware(makeConfig({ rules: [BLOCK_RULE] }));
      const handler = createMockModelHandler({ content: "evil output" });

      try {
        await mw.wrapModelCall?.(ctx, makeModelRequest("clean input"), handler);
        expect(true).toBe(false);
      } catch (e: unknown) {
        expect(e).toBeInstanceOf(KoiRuntimeError);
      }
    });

    test("passes through clean content unchanged", async () => {
      const mw = createSanitizeMiddleware(makeConfig());
      const handler = createMockModelHandler({ content: "clean response" });

      const response = await mw.wrapModelCall?.(ctx, makeModelRequest("clean input"), handler);

      expect(response?.content).toBe("clean response");
    });
  });

  describe("wrapModelStream", () => {
    async function collectChunks(
      stream: AsyncIterable<ModelChunk>,
    ): Promise<readonly ModelChunk[]> {
      const chunks: ModelChunk[] = [];
      for await (const chunk of stream) {
        chunks.push(chunk);
      }
      return chunks;
    }

    test("sanitizes input messages", async () => {
      const mw = createSanitizeMiddleware(makeConfig());
      const doneResponse: ModelResponse = { content: "done", model: "test" };
      const handler = createMockModelStreamHandler([
        { kind: "text_delta", delta: "clean" },
        { kind: "done", response: doneResponse },
      ]);

      const request = makeModelRequest("hello badword");
      const stream = mw.wrapModelStream?.(ctx, request, handler);
      expect(stream).toBeDefined();
      if (stream) {
        const chunks = await collectChunks(stream);
        expect(chunks.length).toBeGreaterThan(0);
      }
    });

    test("passes non-text chunks through", async () => {
      const mw = createSanitizeMiddleware(makeConfig());
      const doneResponse: ModelResponse = { content: "done", model: "test" };
      const handler = createMockModelStreamHandler([
        { kind: "tool_call_start", toolName: "test", callId: "call-1" as never },
        { kind: "tool_call_end", callId: "call-1" as never },
        { kind: "usage", inputTokens: 10, outputTokens: 20 },
        { kind: "done", response: doneResponse },
      ]);

      const stream = mw.wrapModelStream?.(ctx, makeModelRequest("clean"), handler);
      if (stream) {
        const chunks = await collectChunks(stream);
        const kinds = chunks.map((c) => c.kind);
        expect(kinds).toContain("tool_call_start");
        expect(kinds).toContain("tool_call_end");
        expect(kinds).toContain("usage");
        expect(kinds).toContain("done");
      }
    });

    test("flushes buffer on done", async () => {
      const mw = createSanitizeMiddleware(makeConfig({ streamBufferSize: 256 }));
      const doneResponse: ModelResponse = { content: "short text", model: "test" };
      const handler = createMockModelStreamHandler([
        { kind: "text_delta", delta: "short" },
        { kind: "done", response: doneResponse },
      ]);

      const stream = mw.wrapModelStream?.(ctx, makeModelRequest("clean"), handler);
      if (stream) {
        const chunks = await collectChunks(stream);
        const textDeltas = chunks
          .filter(
            (c): c is { readonly kind: "text_delta"; readonly delta: string } =>
              c.kind === "text_delta",
          )
          .map((c) => c.delta)
          .join("");
        expect(textDeltas).toBe("short");
      }
    });

    test("sanitizes thinking_delta chunks", async () => {
      const mw = createSanitizeMiddleware(makeConfig({ streamBufferSize: 10 }));
      const doneResponse: ModelResponse = { content: "done", model: "test" };
      const handler = createMockModelStreamHandler([
        { kind: "thinking_delta", delta: "thinking about badword in reasoning" },
        { kind: "done", response: doneResponse },
      ]);

      const stream = mw.wrapModelStream?.(ctx, makeModelRequest("clean"), handler);
      if (stream) {
        const chunks = await collectChunks(stream);
        const thinkDeltas = chunks
          .filter(
            (c): c is { readonly kind: "thinking_delta"; readonly delta: string } =>
              c.kind === "thinking_delta",
          )
          .map((c) => c.delta)
          .join("");
        expect(thinkDeltas).not.toContain("badword");
        expect(thinkDeltas).toContain("[X]");
      }
    });

    test("fires onSanitization during stream flush", async () => {
      const events: SanitizationEvent[] = [];
      const mw = createSanitizeMiddleware(
        makeConfig({ streamBufferSize: 256, onSanitization: (e) => events.push(e) }),
      );
      const doneResponse: ModelResponse = { content: "done", model: "test" };
      // Content shorter than bufferSize — all sanitization happens on flush
      const handler = createMockModelStreamHandler([
        { kind: "text_delta", delta: "has badword" },
        { kind: "done", response: doneResponse },
      ]);

      const stream = mw.wrapModelStream?.(ctx, makeModelRequest("clean"), handler);
      if (stream) {
        await collectChunks(stream);
        const outputEvents = events.filter((e) => e.location === "output");
        expect(outputEvents.length).toBeGreaterThan(0);
        expect(outputEvents[0]?.rule.name).toBe("test-strip");
      }
    });

    test("flushes both text and thinking buffers on done", async () => {
      const mw = createSanitizeMiddleware(makeConfig({ streamBufferSize: 256 }));
      const doneResponse: ModelResponse = { content: "done", model: "test" };
      const handler = createMockModelStreamHandler([
        { kind: "text_delta", delta: "text content" },
        { kind: "thinking_delta", delta: "think content" },
        { kind: "done", response: doneResponse },
      ]);

      const stream = mw.wrapModelStream?.(ctx, makeModelRequest("clean"), handler);
      if (stream) {
        const chunks = await collectChunks(stream);
        const textDeltas = chunks
          .filter(
            (c): c is { readonly kind: "text_delta"; readonly delta: string } =>
              c.kind === "text_delta",
          )
          .map((c) => c.delta)
          .join("");
        const thinkDeltas = chunks
          .filter(
            (c): c is { readonly kind: "thinking_delta"; readonly delta: string } =>
              c.kind === "thinking_delta",
          )
          .map((c) => c.delta)
          .join("");
        expect(textDeltas).toBe("text content");
        expect(thinkDeltas).toBe("think content");
      }
    });
  });

  describe("wrapToolCall", () => {
    test("sanitizes tool input", async () => {
      const mw = createSanitizeMiddleware(makeConfig());
      const spy = createSpyToolHandler({ output: { result: "ok" } });
      const request = makeToolRequest({ query: "badword query" });

      await mw.wrapToolCall?.(ctx, request, spy.handler);

      const passedInput = spy.calls[0]?.input as Record<string, string>;
      expect(passedInput.query).toBe("[X] query");
    });

    test("sanitizes tool output", async () => {
      const mw = createSanitizeMiddleware(makeConfig());
      const handler = createMockToolHandler({ output: { data: "badword data" } });
      const request = makeToolRequest({ query: "clean" });

      const response = await mw.wrapToolCall?.(ctx, request, handler);

      expect((response?.output as Record<string, string>).data).toBe("[X] data");
    });

    test("throws on tool input block", async () => {
      const mw = createSanitizeMiddleware(makeConfig({ rules: [BLOCK_RULE] }));
      const handler = createMockToolHandler();

      try {
        await mw.wrapToolCall?.(ctx, makeToolRequest({ query: "evil input" }), handler);
        expect(true).toBe(false);
      } catch (e: unknown) {
        expect(e).toBeInstanceOf(KoiRuntimeError);
        expect((e as KoiRuntimeError).code).toBe("VALIDATION");
      }
    });

    test("throws on tool output block", async () => {
      const mw = createSanitizeMiddleware(makeConfig({ rules: [BLOCK_RULE] }));
      const handler = createMockToolHandler({ output: { data: "evil output" } });

      try {
        await mw.wrapToolCall?.(ctx, makeToolRequest({ query: "clean" }), handler);
        expect(true).toBe(false);
      } catch (e: unknown) {
        expect(e).toBeInstanceOf(KoiRuntimeError);
      }
    });

    test("skips tool input when sanitizeToolInput is false", async () => {
      const mw = createSanitizeMiddleware(makeConfig({ sanitizeToolInput: false }));
      const spy = createSpyToolHandler({ output: { result: "ok" } });
      const request = makeToolRequest({ query: "badword query" });

      await mw.wrapToolCall?.(ctx, request, spy.handler);

      // Input should NOT be sanitized
      const passedInput = spy.calls[0]?.input as Record<string, string>;
      expect(passedInput.query).toBe("badword query");
    });

    test("skips tool output when sanitizeToolOutput is false", async () => {
      const mw = createSanitizeMiddleware(makeConfig({ sanitizeToolOutput: false }));
      const handler = createMockToolHandler({ output: { data: "badword data" } });

      const response = await mw.wrapToolCall?.(ctx, makeToolRequest({ query: "clean" }), handler);

      // Output should NOT be sanitized
      expect((response?.output as Record<string, string>).data).toBe("badword data");
    });
  });

  describe("onSanitization callback", () => {
    test("fires callback on model input sanitization", async () => {
      const events: SanitizationEvent[] = [];
      const mw = createSanitizeMiddleware(makeConfig({ onSanitization: (e) => events.push(e) }));
      const handler = createMockModelHandler({ content: "clean" });

      await mw.wrapModelCall?.(ctx, makeModelRequest("hello badword"), handler);

      expect(events.length).toBeGreaterThan(0);
      expect(events[0]?.location).toBe("input");
    });

    test("fires callback on model output sanitization", async () => {
      const events: SanitizationEvent[] = [];
      const mw = createSanitizeMiddleware(makeConfig({ onSanitization: (e) => events.push(e) }));
      const handler = createMockModelHandler({ content: "badword response" });

      await mw.wrapModelCall?.(ctx, makeModelRequest("clean"), handler);

      const outputEvents = events.filter((e) => e.location === "output");
      expect(outputEvents.length).toBeGreaterThan(0);
    });

    test("fires callback on tool sanitization", async () => {
      const events: SanitizationEvent[] = [];
      const mw = createSanitizeMiddleware(makeConfig({ onSanitization: (e) => events.push(e) }));
      const handler = createMockToolHandler({ output: { data: "badword" } });

      await mw.wrapToolCall?.(ctx, makeToolRequest({ query: "badword" }), handler);

      const inputEvents = events.filter((e) => e.location === "tool-input");
      const outputEvents = events.filter((e) => e.location === "tool-output");
      expect(inputEvents.length).toBeGreaterThan(0);
      expect(outputEvents.length).toBeGreaterThan(0);
    });
  });

  describe("presets", () => {
    test("resolves preset rules", async () => {
      const mw = createSanitizeMiddleware({ presets: ["control-chars"] });
      const handler = createMockModelHandler({ content: "clean" });

      const response = await mw.wrapModelCall?.(ctx, makeModelRequest("hello\0world"), handler);

      // Input with null byte should be sanitized (no throw since it's strip, not block)
      expect(response).toBeDefined();
    });

    test("merges rules and presets", async () => {
      const mw = createSanitizeMiddleware({
        rules: [STRIP_RULE],
        presets: ["control-chars"],
      });
      const spy = createSpyModelHandler({ content: "clean" });

      await mw.wrapModelCall?.(ctx, makeModelRequest("badword \0"), spy.handler);

      const sanitizedText = (spy.calls[0]?.messages[0]?.content[0] as { readonly text: string })
        .text;
      expect(sanitizedText).not.toContain("badword");
      expect(sanitizedText).not.toContain("\0");
    });
  });

  describe("describeCapabilities", () => {
    test("is defined on the middleware", () => {
      const mw = createSanitizeMiddleware(makeConfig());
      expect(mw.describeCapabilities).toBeDefined();
    });

    test("returns label 'sanitize' and description containing 'sanitization'", () => {
      const mw = createSanitizeMiddleware(makeConfig());
      const result = mw.describeCapabilities?.(ctx);
      expect(result?.label).toBe("sanitize");
      expect(result?.description).toContain("Sanitization");
    });
  });
});
