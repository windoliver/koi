/**
 * Integration tests — 6 end-to-end scenarios exercising the sanitize middleware.
 */

import { describe, expect, test } from "bun:test";
import type { ModelChunk, ModelHandler, ModelRequest, ModelResponse } from "@koi/core/middleware";
import {
  createMockInboundMessage,
  createMockModelHandler,
  createMockToolHandler,
  createMockTurnContext,
  createSpyModelHandler,
  createSpyModelStreamHandler,
} from "@koi/test-utils";
import { createSanitizeMiddleware } from "../sanitize-middleware.js";
import type { SanitizationEvent, SanitizeRule } from "../types.js";

const ctx = createMockTurnContext();

const STRIP_RULE: SanitizeRule = {
  name: "test-strip",
  pattern: /badword/i,
  action: { kind: "strip", replacement: "[X]" },
};

async function collectStream(stream: AsyncIterable<ModelChunk>): Promise<readonly ModelChunk[]> {
  const chunks: ModelChunk[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return chunks;
}

describe("integration", () => {
  test("scenario 1: wrapModelCall input + output sanitization", async () => {
    const mw = createSanitizeMiddleware({ rules: [STRIP_RULE] });
    const spy = createSpyModelHandler({ content: "response with badword" });

    const response = await mw.wrapModelCall?.(
      ctx,
      { messages: [createMockInboundMessage({ text: "input with badword" })] },
      spy.handler,
    );

    // Input was sanitized
    const passedText = (spy.calls[0]?.messages[0]?.content[0] as { readonly text: string }).text;
    expect(passedText).toBe("input with [X]");

    // Output was sanitized
    expect(response?.content).toBe("response with [X]");
  });

  test("scenario 2: wrapModelStream input + sliding window output", async () => {
    const mw = createSanitizeMiddleware({ rules: [STRIP_RULE], streamBufferSize: 10 });
    const doneResponse: ModelResponse = { content: "final", model: "test" };
    const streamChunks: readonly ModelChunk[] = [
      { kind: "text_delta", delta: "streaming response with " },
      { kind: "text_delta", delta: "badword in it plus more text" },
      { kind: "thinking_delta", delta: "badword in thinking" },
      { kind: "done", response: doneResponse },
    ];
    const spy = createSpyModelStreamHandler(streamChunks);

    const stream = mw.wrapModelStream?.(
      ctx,
      { messages: [createMockInboundMessage({ text: "clean input" })] },
      spy.handler,
    );
    expect(stream).toBeDefined();
    if (!stream) return;

    const chunks = await collectStream(stream);

    // Verify request was passed through (recorded during iteration)
    expect(spy.calls.length).toBe(1);
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

    expect(textDeltas).not.toContain("badword");
    expect(textDeltas).toContain("[X]");
    expect(thinkDeltas).not.toContain("badword");
    expect(thinkDeltas).toContain("[X]");
  });

  test("scenario 3: wrapToolCall input + output sanitization", async () => {
    const mw = createSanitizeMiddleware({ rules: [STRIP_RULE] });
    const handler = createMockToolHandler({
      output: { result: "tool output badword" },
    });

    const response = await mw.wrapToolCall?.(
      ctx,
      { toolId: "test-tool", input: { query: "tool input badword" } },
      handler,
    );

    expect((response?.output as Record<string, string>).result).toBe("tool output [X]");
  });

  test("scenario 4: middleware chaining (sanitize at 350 + mock audit at 300)", async () => {
    const sanitizeMw = createSanitizeMiddleware({ rules: [STRIP_RULE] });
    expect(sanitizeMw.priority).toBe(350);

    // Simulate an audit middleware at priority 300 that records what it sees
    const auditLog: string[] = [];
    const auditWrap = async (request: ModelRequest, next: ModelHandler): Promise<ModelResponse> => {
      // Audit sees the request BEFORE sanitize (lower priority runs first)
      const inputText = (request.messages[0]?.content[0] as { readonly text: string }).text;
      auditLog.push(`audit-input:${inputText}`);
      const response = await next(request);
      auditLog.push(`audit-output:${response.content}`);
      return response;
    };

    // Chain: audit(300) wraps sanitize(350) wraps model handler
    // Priority order: lower number = outer wrapper
    const modelHandler = createMockModelHandler({ content: "response with badword" });

    // Inner layer: sanitize wraps model handler
    const sanitizeHandler: ModelHandler = async (req) => {
      const result = await sanitizeMw.wrapModelCall?.(ctx, req, modelHandler);
      return result ?? { content: "", model: "test" };
    };

    // Outer layer: audit wraps sanitize
    const response = await auditWrap(
      { messages: [createMockInboundMessage({ text: "input with badword" })] },
      sanitizeHandler,
    );

    // Audit at 300 sees the raw input (before sanitize at 350)
    expect(auditLog[0]).toBe("audit-input:input with badword");
    // Audit sees sanitized output
    expect(auditLog[1]).toBe("audit-output:response with [X]");
    // Final response is sanitized
    expect(response.content).toBe("response with [X]");
  });

  test("scenario 5: onSanitization callback with correct event data", async () => {
    const events: SanitizationEvent[] = [];
    const mw = createSanitizeMiddleware({
      rules: [STRIP_RULE],
      onSanitization: (e) => events.push(e),
    });
    const handler = createMockModelHandler({ content: "response badword" });

    await mw.wrapModelCall?.(
      ctx,
      { messages: [createMockInboundMessage({ text: "input badword" })] },
      handler,
    );

    expect(events.length).toBeGreaterThanOrEqual(2);

    const inputEvent = events.find((e) => e.location === "input");
    expect(inputEvent).toBeDefined();
    expect(inputEvent?.rule.name).toBe("test-strip");
    expect(inputEvent?.original).toContain("badword");
    expect(inputEvent?.sanitized).toContain("[X]");

    const outputEvent = events.find((e) => e.location === "output");
    expect(outputEvent).toBeDefined();
    expect(outputEvent?.rule.name).toBe("test-strip");
  });

  test("scenario 6: no-op path (no rules match, content passes through)", async () => {
    const mw = createSanitizeMiddleware({ rules: [STRIP_RULE] });
    const handler = createMockModelHandler({ content: "perfectly clean response" });

    const response = await mw.wrapModelCall?.(
      ctx,
      { messages: [createMockInboundMessage({ text: "perfectly clean input" })] },
      handler,
    );

    expect(response?.content).toBe("perfectly clean response");
  });
});
