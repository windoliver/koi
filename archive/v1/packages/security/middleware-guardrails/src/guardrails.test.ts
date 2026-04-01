/**
 * Unit tests for the guardrails middleware factory.
 */

import { describe, expect, test } from "bun:test";
import type { ModelChunk, ModelRequest, ModelResponse } from "@koi/core/middleware";
import { KoiRuntimeError } from "@koi/errors";
import {
  createMockModelHandler,
  createMockToolHandler,
  createMockTurnContext,
  createSpyModelHandler,
  createSpyModelStreamHandler,
} from "@koi/test-utils";
import { z } from "zod";
import { createGuardrailsMiddleware } from "./guardrails.js";
import type { GuardrailRule, GuardrailViolationEvent } from "./types.js";

const ctx = createMockTurnContext();
const request: ModelRequest = { messages: [] };

const jsonSchema = z.object({ message: z.string(), score: z.number().min(0).max(100) });

const blockRule: GuardrailRule = {
  name: "json-format",
  schema: jsonSchema,
  target: "modelOutput",
  action: "block",
};

const warnRule: GuardrailRule = {
  name: "json-warn",
  schema: jsonSchema,
  target: "modelOutput",
  action: "warn",
};

const retryRule: GuardrailRule = {
  name: "json-retry",
  schema: jsonSchema,
  target: "modelOutput",
  action: "retry",
};

const toolSchema = z.object({ result: z.string() });
const toolRule: GuardrailRule = {
  name: "tool-format",
  schema: toolSchema,
  target: "toolOutput",
  action: "block",
};

async function collectStream(stream: AsyncIterable<ModelChunk>): Promise<readonly ModelChunk[]> {
  const chunks: ModelChunk[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return chunks;
}

function assertStream(stream: AsyncIterable<ModelChunk> | undefined): AsyncIterable<ModelChunk> {
  if (stream === undefined) throw new Error("Expected stream to be defined");
  return stream;
}

describe("createGuardrailsMiddleware", () => {
  test("has name 'guardrails' and priority 375", () => {
    const mw = createGuardrailsMiddleware({ rules: [blockRule] });
    expect(mw.name).toBe("guardrails");
    expect(mw.priority).toBe(375);
  });

  describe("wrapModelCall", () => {
    test("passes through valid JSON output", async () => {
      const validContent = JSON.stringify({ message: "hello", score: 42 });
      const handler = createMockModelHandler({ content: validContent });
      const mw = createGuardrailsMiddleware({ rules: [blockRule] });

      const response = await mw.wrapModelCall?.(ctx, request, handler);
      expect(response?.content).toBe(validContent);
    });

    test("block action throws KoiRuntimeError on invalid output", async () => {
      const handler = createMockModelHandler({ content: "not json" });
      const mw = createGuardrailsMiddleware({ rules: [blockRule] });

      await expect(mw.wrapModelCall?.(ctx, request, handler)).rejects.toBeInstanceOf(
        KoiRuntimeError,
      );
    });

    test("block action throws with VALIDATION code", async () => {
      const handler = createMockModelHandler({ content: "not json" });
      const mw = createGuardrailsMiddleware({ rules: [blockRule] });

      try {
        await mw.wrapModelCall?.(ctx, request, handler);
        expect(true).toBe(false); // Should not reach
      } catch (e: unknown) {
        expect(e).toBeInstanceOf(KoiRuntimeError);
        expect((e as KoiRuntimeError).code).toBe("VALIDATION");
      }
    });

    test("warn action fires callback and passes through", async () => {
      const handler = createMockModelHandler({ content: "not json" });
      const events: GuardrailViolationEvent[] = [];
      const mw = createGuardrailsMiddleware({
        rules: [warnRule],
        onViolation: (e) => events.push(e),
      });

      const response = await mw.wrapModelCall?.(ctx, request, handler);
      expect(response?.content).toBe("not json");
      expect(events).toHaveLength(1);
      expect(events[0]?.action).toBe("warn");
      expect(events[0]?.rule).toBe("json-warn");
    });

    test("retry re-calls next with error context in messages", async () => {
      const spy = createSpyModelHandler({
        content: JSON.stringify({ message: "hello", score: 42 }),
      });
      // First call returns invalid, second returns valid
      // let justified: counter tracks call attempts
      let callCount = 0;
      const handler = async (req: ModelRequest): Promise<ModelResponse> => {
        callCount++;
        if (callCount === 1) {
          return { content: "not json", model: "test" };
        }
        return spy.handler(req);
      };

      const mw = createGuardrailsMiddleware({
        rules: [retryRule],
        retry: { maxAttempts: 3 },
      });

      const response = await mw.wrapModelCall?.(ctx, request, handler);
      expect(callCount).toBe(2);
      expect(response?.content).toBe(JSON.stringify({ message: "hello", score: 42 }));
    });

    test("retry exhausts attempts and throws", async () => {
      const handler = createMockModelHandler({ content: "always invalid" });
      const mw = createGuardrailsMiddleware({
        rules: [retryRule],
        retry: { maxAttempts: 2 },
      });

      await expect(mw.wrapModelCall?.(ctx, request, handler)).rejects.toBeInstanceOf(
        KoiRuntimeError,
      );
    });

    test("retry fires onViolation for each attempt", async () => {
      const handler = createMockModelHandler({ content: "not json" });
      const events: GuardrailViolationEvent[] = [];
      const mw = createGuardrailsMiddleware({
        rules: [retryRule],
        retry: { maxAttempts: 2 },
        onViolation: (e) => events.push(e),
      });

      await expect(mw.wrapModelCall?.(ctx, request, handler)).rejects.toThrow();

      expect(events).toHaveLength(2);
      expect(events[0]?.attempt).toBe(1);
      expect(events[1]?.attempt).toBe(2);
    });

    test("multiple rules: first block wins", async () => {
      const rule1: GuardrailRule = {
        name: "strict-schema",
        schema: z.object({ a: z.string(), b: z.number() }),
        target: "modelOutput",
        action: "block",
      };
      const rule2: GuardrailRule = {
        name: "loose-schema",
        schema: z.object({ a: z.string() }),
        target: "modelOutput",
        action: "block",
      };
      const handler = createMockModelHandler({
        content: JSON.stringify({ a: "ok" }),
      });
      const mw = createGuardrailsMiddleware({ rules: [rule1, rule2] });

      try {
        await mw.wrapModelCall?.(ctx, request, handler);
        expect(true).toBe(false);
      } catch (e: unknown) {
        expect(e).toBeInstanceOf(KoiRuntimeError);
        expect((e as KoiRuntimeError).message).toContain("strict-schema");
      }
    });

    test("text mode rule validates text wrapping", async () => {
      const textRule: GuardrailRule = {
        name: "text-check",
        schema: z.object({ text: z.string().min(5) }),
        target: "modelOutput",
        action: "block",
        parseMode: "text",
      };
      const handler = createMockModelHandler({ content: "hi" });
      const mw = createGuardrailsMiddleware({ rules: [textRule] });

      await expect(mw.wrapModelCall?.(ctx, request, handler)).rejects.toBeInstanceOf(
        KoiRuntimeError,
      );
    });

    test("text mode passes valid content", async () => {
      const textRule: GuardrailRule = {
        name: "text-check",
        schema: z.object({ text: z.string().min(5) }),
        target: "modelOutput",
        action: "block",
        parseMode: "text",
      };
      const handler = createMockModelHandler({ content: "hello world" });
      const mw = createGuardrailsMiddleware({ rules: [textRule] });

      const response = await mw.wrapModelCall?.(ctx, request, handler);
      expect(response?.content).toBe("hello world");
    });
  });

  describe("wrapModelStream", () => {
    test("buffers text_delta and validates on done", async () => {
      const validJson = JSON.stringify({ message: "hello", score: 42 });
      const doneResponse: ModelResponse = { content: validJson, model: "test" };
      const chunks: readonly ModelChunk[] = [
        { kind: "text_delta", delta: '{"message":' },
        { kind: "text_delta", delta: '"hello","score":42}' },
        { kind: "done", response: doneResponse },
      ];
      const handler = createSpyModelStreamHandler(chunks);
      const mw = createGuardrailsMiddleware({ rules: [blockRule] });

      const stream = assertStream(mw.wrapModelStream?.(ctx, request, handler.handler));
      const collected = await collectStream(stream);

      // All chunks passed through (validation on done)
      expect(collected).toHaveLength(3);
      expect(collected[0]?.kind).toBe("text_delta");
      expect(collected[2]?.kind).toBe("done");
    });

    test("block rule throws on invalid streamed output", async () => {
      const doneResponse: ModelResponse = { content: "not json", model: "test" };
      const chunks: readonly ModelChunk[] = [
        { kind: "text_delta", delta: "not json" },
        { kind: "done", response: doneResponse },
      ];
      const handler = createSpyModelStreamHandler(chunks);
      const mw = createGuardrailsMiddleware({ rules: [blockRule] });

      const stream = assertStream(mw.wrapModelStream?.(ctx, request, handler.handler));
      await expect(collectStream(stream)).rejects.toBeInstanceOf(KoiRuntimeError);
    });

    test("warn rule fires callback but does not throw", async () => {
      const doneResponse: ModelResponse = { content: "not json", model: "test" };
      const chunks: readonly ModelChunk[] = [
        { kind: "text_delta", delta: "not json" },
        { kind: "done", response: doneResponse },
      ];
      const handler = createSpyModelStreamHandler(chunks);
      const events: GuardrailViolationEvent[] = [];
      const mw = createGuardrailsMiddleware({
        rules: [warnRule],
        onViolation: (e) => events.push(e),
      });

      const stream = assertStream(mw.wrapModelStream?.(ctx, request, handler.handler));
      const collected = await collectStream(stream);
      expect(collected).toHaveLength(2);
      expect(events).toHaveLength(1);
      expect(events[0]?.action).toBe("warn");
    });

    test("stream buffer overflow with block rules throws instead of flushing unvalidated", async () => {
      const longContent = "x".repeat(300);
      const doneResponse: ModelResponse = { content: longContent, model: "test" };
      const chunks: readonly ModelChunk[] = [
        { kind: "text_delta", delta: longContent },
        { kind: "done", response: doneResponse },
      ];
      const handler = createSpyModelStreamHandler(chunks);
      const events: GuardrailViolationEvent[] = [];
      const mw = createGuardrailsMiddleware({
        rules: [blockRule],
        maxBufferSize: 100,
        onViolation: (e) => events.push(e),
      });

      const stream = assertStream(mw.wrapModelStream?.(ctx, request, handler.handler));
      await expect(collectStream(stream)).rejects.toBeInstanceOf(KoiRuntimeError);

      // Overflow event fired with block action
      const overflowEvent = events.find((e) => e.rule === "stream-buffer-overflow");
      expect(overflowEvent).toBeDefined();
      expect(overflowEvent?.action).toBe("block");
    });

    test("stream buffer overflow with warn-only rules passes through", async () => {
      const longContent = "x".repeat(300);
      const doneResponse: ModelResponse = { content: longContent, model: "test" };
      const chunks: readonly ModelChunk[] = [
        { kind: "text_delta", delta: longContent },
        { kind: "done", response: doneResponse },
      ];
      const handler = createSpyModelStreamHandler(chunks);
      const events: GuardrailViolationEvent[] = [];
      const mw = createGuardrailsMiddleware({
        rules: [warnRule],
        maxBufferSize: 100,
        onViolation: (e) => events.push(e),
      });

      const stream = assertStream(mw.wrapModelStream?.(ctx, request, handler.handler));
      const collected = await collectStream(stream);

      // Overflow warning fired
      const overflowEvent = events.find((e) => e.rule === "stream-buffer-overflow");
      expect(overflowEvent).toBeDefined();
      expect(overflowEvent?.action).toBe("warn");

      // All chunks still yielded (validation skipped — no block rules)
      expect(collected).toHaveLength(2);
    });

    test("passes through non-text chunks unchanged", async () => {
      const validJson = JSON.stringify({ message: "hello", score: 42 });
      const doneResponse: ModelResponse = { content: validJson, model: "test" };
      const chunks: readonly ModelChunk[] = [
        { kind: "text_delta", delta: validJson },
        { kind: "usage", inputTokens: 10, outputTokens: 20 },
        { kind: "done", response: doneResponse },
      ];
      const handler = createSpyModelStreamHandler(chunks);
      const mw = createGuardrailsMiddleware({ rules: [blockRule] });

      const stream = assertStream(mw.wrapModelStream?.(ctx, request, handler.handler));
      const collected = await collectStream(stream);
      const usageChunk = collected.find((c) => c.kind === "usage");
      expect(usageChunk).toBeDefined();
    });

    test("empty buffer skips validation on done", async () => {
      const doneResponse: ModelResponse = { content: "", model: "test" };
      const chunks: readonly ModelChunk[] = [{ kind: "done", response: doneResponse }];
      const handler = createSpyModelStreamHandler(chunks);
      const mw = createGuardrailsMiddleware({ rules: [blockRule] });

      const stream = assertStream(mw.wrapModelStream?.(ctx, request, handler.handler));
      const collected = await collectStream(stream);
      expect(collected).toHaveLength(1);
      expect(collected[0]?.kind).toBe("done");
    });
  });

  describe("wrapToolCall", () => {
    test("passes through valid tool output", async () => {
      const handler = createMockToolHandler({ output: { result: "ok" } });
      const mw = createGuardrailsMiddleware({ rules: [toolRule] });

      const response = await mw.wrapToolCall?.(ctx, { toolId: "test-tool", input: {} }, handler);
      expect((response?.output as Record<string, string>).result).toBe("ok");
    });

    test("block action throws on invalid tool output", async () => {
      const handler = createMockToolHandler({ output: { bad: 123 } });
      const mw = createGuardrailsMiddleware({ rules: [toolRule] });

      await expect(
        mw.wrapToolCall?.(ctx, { toolId: "test-tool", input: {} }, handler),
      ).rejects.toBeInstanceOf(KoiRuntimeError);
    });

    test("warn action fires callback and passes through", async () => {
      const warnToolRule: GuardrailRule = { ...toolRule, action: "warn", name: "tool-warn" };
      const handler = createMockToolHandler({ output: { bad: 123 } });
      const events: GuardrailViolationEvent[] = [];
      const mw = createGuardrailsMiddleware({
        rules: [warnToolRule],
        onViolation: (e) => events.push(e),
      });

      const response = await mw.wrapToolCall?.(ctx, { toolId: "test-tool", input: {} }, handler);
      expect(response).toBeDefined();
      expect(events).toHaveLength(1);
      expect(events[0]?.target).toBe("toolOutput");
    });

    test("includes toolId in error context", async () => {
      const handler = createMockToolHandler({ output: "wrong" });
      const mw = createGuardrailsMiddleware({ rules: [toolRule] });

      try {
        await mw.wrapToolCall?.(ctx, { toolId: "my-tool", input: {} }, handler);
        expect(true).toBe(false);
      } catch (e: unknown) {
        expect(e).toBeInstanceOf(KoiRuntimeError);
        expect((e as KoiRuntimeError).message).toContain("my-tool");
      }
    });
  });

  describe("conditional hook registration", () => {
    test("no wrapModelCall/wrapModelStream when only toolOutput rules", () => {
      const mw = createGuardrailsMiddleware({ rules: [toolRule] });
      expect(mw.wrapModelCall).toBeUndefined();
      expect(mw.wrapModelStream).toBeUndefined();
      expect(mw.wrapToolCall).toBeDefined();
    });

    test("no wrapToolCall when only modelOutput rules", () => {
      const mw = createGuardrailsMiddleware({ rules: [blockRule] });
      expect(mw.wrapModelCall).toBeDefined();
      expect(mw.wrapModelStream).toBeDefined();
      expect(mw.wrapToolCall).toBeUndefined();
    });

    test("all hooks registered when both targets present", () => {
      const mw = createGuardrailsMiddleware({ rules: [blockRule, toolRule] });
      expect(mw.wrapModelCall).toBeDefined();
      expect(mw.wrapModelStream).toBeDefined();
      expect(mw.wrapToolCall).toBeDefined();
    });
  });

  describe("edge cases", () => {
    test("empty string model output fails JSON parse", async () => {
      const handler = createMockModelHandler({ content: "" });
      const mw = createGuardrailsMiddleware({ rules: [blockRule] });

      await expect(mw.wrapModelCall?.(ctx, request, handler)).rejects.toBeInstanceOf(
        KoiRuntimeError,
      );
    });

    test("default retry maxAttempts is 2", async () => {
      const handler = createMockModelHandler({ content: "invalid" });
      const events: GuardrailViolationEvent[] = [];
      const mw = createGuardrailsMiddleware({
        rules: [retryRule],
        onViolation: (e) => events.push(e),
      });

      await expect(mw.wrapModelCall?.(ctx, request, handler)).rejects.toThrow();

      expect(events).toHaveLength(2);
    });
  });

  describe("describeCapabilities", () => {
    test("is defined on the middleware", () => {
      const mw = createGuardrailsMiddleware({ rules: [blockRule] });
      expect(mw.describeCapabilities).toBeDefined();
    });

    test("returns label 'guardrails' and description containing 'retries'", () => {
      const mw = createGuardrailsMiddleware({ rules: [blockRule] });
      const result = mw.describeCapabilities?.(ctx);
      expect(result?.label).toBe("guardrails");
      expect(result?.description).toContain("retries");
    });
  });
});
