import { describe, expect, test } from "bun:test";
import { createMockTurnContext, createMockValidator } from "@koi/test-utils";
import { createFeedbackLoopMiddleware } from "./feedback-loop.js";

describe("createFeedbackLoopMiddleware", () => {
  test("returns middleware with correct name", () => {
    const { middleware: mw } = createFeedbackLoopMiddleware({});
    expect(mw.name).toBe("feedback-loop");
  });

  test("returns middleware with priority 450", () => {
    const { middleware: mw } = createFeedbackLoopMiddleware({});
    expect(mw.priority).toBe(450);
  });

  test("includes wrapModelCall hook", () => {
    const { middleware: mw } = createFeedbackLoopMiddleware({
      validators: [createMockValidator()],
    });
    expect(mw.wrapModelCall).toBeDefined();
    expect(typeof mw.wrapModelCall).toBe("function");
  });

  test("includes wrapToolCall hook", () => {
    const { middleware: mw } = createFeedbackLoopMiddleware({
      toolValidators: [createMockValidator()],
    });
    expect(mw.wrapToolCall).toBeDefined();
    expect(typeof mw.wrapToolCall).toBe("function");
  });

  test("hooks are always present even with empty config", () => {
    const { middleware: mw } = createFeedbackLoopMiddleware({});
    expect(mw.wrapModelCall).toBeDefined();
    expect(mw.wrapToolCall).toBeDefined();
  });

  test("does not include session hooks", () => {
    const { middleware: mw } = createFeedbackLoopMiddleware({});
    expect(mw.onSessionStart).toBeUndefined();
    expect(mw.onSessionEnd).toBeUndefined();
    expect(mw.onBeforeTurn).toBeUndefined();
    expect(mw.onAfterTurn).toBeUndefined();
  });

  describe("describeCapabilities", () => {
    test("is defined on the middleware", () => {
      const { middleware: mw } = createFeedbackLoopMiddleware({});
      expect(mw.describeCapabilities).toBeDefined();
    });

    test("returns label 'feedback' and description with validation details", () => {
      const { middleware: mw } = createFeedbackLoopMiddleware({});
      const ctx = createMockTurnContext();
      const result = mw.describeCapabilities?.(ctx);
      expect(result?.label).toBe("feedback");
      expect(result?.description).toContain("validation");
    });
  });
});
