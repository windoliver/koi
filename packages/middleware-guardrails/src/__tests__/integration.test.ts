/**
 * Integration tests — end-to-end scenarios exercising the guardrails middleware.
 */

import { describe, expect, test } from "bun:test";
import type { ModelChunk, ModelResponse } from "@koi/core/middleware";
import {
  createMockModelHandler,
  createMockToolHandler,
  createMockTurnContext,
  createSpyModelStreamHandler,
} from "@koi/test-utils";
import { z } from "zod";
import { createGuardrailsMiddleware } from "../guardrails.js";
import type { GuardrailRule, GuardrailViolationEvent } from "../types.js";

const ctx = createMockTurnContext();

const responseSchema = z.object({
  answer: z.string(),
  confidence: z.number().min(0).max(1),
});

const modelRule: GuardrailRule = {
  name: "response-format",
  schema: responseSchema,
  target: "modelOutput",
  action: "block",
};

const toolOutputSchema = z.object({ result: z.string() });
const toolRule: GuardrailRule = {
  name: "tool-format",
  schema: toolOutputSchema,
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

describe("integration", () => {
  test("scenario 1: full model call with valid JSON passes through", async () => {
    const validContent = JSON.stringify({ answer: "42", confidence: 0.95 });
    const handler = createMockModelHandler({ content: validContent });
    const events: GuardrailViolationEvent[] = [];
    const mw = createGuardrailsMiddleware({
      rules: [modelRule],
      onViolation: (e) => events.push(e),
    });

    const response = await mw.wrapModelCall?.(ctx, { messages: [] }, handler);
    expect(response?.content).toBe(validContent);
    expect(events).toHaveLength(0);
  });

  test("scenario 2: streaming with valid JSON validated at done", async () => {
    const validContent = JSON.stringify({ answer: "hello", confidence: 0.8 });
    const doneResponse: ModelResponse = { content: validContent, model: "test" };
    const chunks: readonly ModelChunk[] = [
      { kind: "text_delta", delta: '{"answer":"hello",' },
      { kind: "text_delta", delta: '"confidence":0.8}' },
      { kind: "done", response: doneResponse },
    ];
    const handler = createSpyModelStreamHandler(chunks);
    const mw = createGuardrailsMiddleware({ rules: [modelRule] });

    const stream = assertStream(mw.wrapModelStream?.(ctx, { messages: [] }, handler.handler));
    const collected = await collectStream(stream);

    expect(collected).toHaveLength(3);
    expect(collected[2]?.kind).toBe("done");
  });

  test("scenario 3: model + tool rules both enforced", async () => {
    const validModelContent = JSON.stringify({ answer: "ok", confidence: 0.5 });
    const modelHandler = createMockModelHandler({ content: validModelContent });
    const validToolHandler = createMockToolHandler({ output: { result: "success" } });
    const invalidToolHandler = createMockToolHandler({ output: { wrong: true } });

    const mw = createGuardrailsMiddleware({ rules: [modelRule, toolRule] });

    // Model call works
    const modelResponse = await mw.wrapModelCall?.(ctx, { messages: [] }, modelHandler);
    expect(modelResponse?.content).toBe(validModelContent);

    // Valid tool call works
    const toolResponse = await mw.wrapToolCall?.(
      ctx,
      { toolId: "t1", input: {} },
      validToolHandler,
    );
    expect((toolResponse?.output as Record<string, string>).result).toBe("success");

    // Invalid tool call blocked
    await expect(
      mw.wrapToolCall?.(ctx, { toolId: "t2", input: {} }, invalidToolHandler),
    ).rejects.toThrow();
  });
});
