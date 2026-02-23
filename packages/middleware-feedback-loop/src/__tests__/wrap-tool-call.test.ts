import { describe, expect, test } from "bun:test";
import type { ToolRequest } from "@koi/core/middleware";
import { KoiRuntimeError } from "@koi/errors";
import {
  createFailingValidator,
  createMockTurnContext,
  createMockValidator,
  createSpyToolHandler,
} from "@koi/test-utils";
import { createFeedbackLoopMiddleware } from "../feedback-loop.js";

const ctx = createMockTurnContext();

const baseToolRequest: ToolRequest = {
  toolId: "tool-1",
  input: { query: "test" },
};

describe("wrapToolCall integration", () => {
  test("happy path: tool input and output pass", async () => {
    const spy = createSpyToolHandler({ output: { result: "ok" } });
    const mw = createFeedbackLoopMiddleware({
      toolValidators: [createMockValidator("tv1")],
      toolGates: [createMockValidator("tg1")],
    });

    const result = await mw.wrapToolCall?.(ctx, baseToolRequest, spy.handler);
    expect(result).toBeDefined();
    expect(result?.output).toEqual({ result: "ok" });
    expect(spy.calls).toHaveLength(1);
  });

  test("bad tool input rejected before execution (next never called)", async () => {
    const spy = createSpyToolHandler();
    const mw = createFeedbackLoopMiddleware({
      toolValidators: [
        createFailingValidator([{ validator: "input-check", message: "bad input" }], "input-check"),
      ],
    });

    try {
      await mw.wrapToolCall?.(ctx, baseToolRequest, spy.handler);
      expect.unreachable("should have thrown");
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(KoiRuntimeError);
      if (e instanceof KoiRuntimeError) {
        expect(e.code).toBe("VALIDATION");
        expect(e.message).toContain("Tool input validation failed");
      }
    }
    // Handler was never called
    expect(spy.calls).toHaveLength(0);
  });

  test("tool output gate fails -> throws after execution", async () => {
    const spy = createSpyToolHandler({ output: { data: "sensitive" } });
    const mw = createFeedbackLoopMiddleware({
      toolGates: [
        createFailingValidator([{ validator: "pii-gate", message: "PII detected" }], "pii-gate"),
      ],
    });

    try {
      await mw.wrapToolCall?.(ctx, baseToolRequest, spy.handler);
      expect.unreachable("should have thrown");
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(KoiRuntimeError);
      if (e instanceof KoiRuntimeError) {
        expect(e.message).toContain("pii-gate");
      }
    }
    // Handler WAS called (gate is post-flight)
    expect(spy.calls).toHaveLength(1);
  });

  test("onGateFail callback fires on tool gate failure", async () => {
    const gateFails: Array<{ name: string }> = [];
    const spy = createSpyToolHandler();
    const mw = createFeedbackLoopMiddleware({
      toolGates: [createFailingValidator([{ validator: "gate", message: "nope" }], "gate")],
      onGateFail: (name) => gateFails.push({ name }),
    });

    try {
      await mw.wrapToolCall?.(ctx, baseToolRequest, spy.handler);
    } catch {
      // Expected
    }
    expect(gateFails).toHaveLength(1);
    expect(gateFails[0]?.name).toBe("gate");
  });

  test("no tool validators or gates -> pass-through", async () => {
    const spy = createSpyToolHandler({ output: "raw" });
    const mw = createFeedbackLoopMiddleware({});

    const result = await mw.wrapToolCall?.(ctx, baseToolRequest, spy.handler);
    expect(result).toBeDefined();
    expect(result?.output).toBe("raw");
    expect(spy.calls).toHaveLength(1);
  });

  test("tool input passes, then output gate passes", async () => {
    const spy = createSpyToolHandler({ output: "clean" });
    const mw = createFeedbackLoopMiddleware({
      toolValidators: [createMockValidator("input-ok")],
      toolGates: [createMockValidator("output-ok")],
    });

    const result = await mw.wrapToolCall?.(ctx, baseToolRequest, spy.handler);
    expect(result).toBeDefined();
    expect(result?.output).toBe("clean");
  });
});
