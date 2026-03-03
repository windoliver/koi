import { describe, expect, test } from "bun:test";
import type { ModelRequest } from "@koi/core";
import { createDefaultPromptRewriter } from "./default-rewriter.js";
import type { RetryAction, RewriteContext } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const baseRequest: ModelRequest = {
  messages: [
    {
      senderId: "user-1",
      content: [{ kind: "text", text: "Hello" }],
      timestamp: 1700000000000,
    },
  ],
};

function makeRewriteContext(overrides: Partial<RewriteContext> = {}): RewriteContext {
  return {
    failureClass: { kind: "unknown", reason: "test" },
    records: [],
    turnIndex: 0,
    ...overrides,
  };
}

/** Asserts that the rewritten request has an injected message at position 0. */
function assertInjectedMessage(result: ModelRequest, pattern: RegExp): void {
  expect(result.messages.length).toBeGreaterThan(baseRequest.messages.length);
  const injected = result.messages[0];
  expect(injected).toBeDefined();
  expect(injected?.senderId).toBe("system:semantic-retry");
  const block = injected?.content[0];
  expect(block?.kind).toBe("text");
  if (block?.kind === "text") {
    expect(block.text).toMatch(pattern);
  }
}

/** Asserts that all original messages are preserved (shifted by 1 due to injection). */
function assertOriginalPreserved(result: ModelRequest): void {
  const originals = result.messages.slice(1);
  expect(originals).toEqual([...baseRequest.messages]);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createDefaultPromptRewriter", () => {
  const rewriter = createDefaultPromptRewriter();
  const ctx = makeRewriteContext();

  describe("narrow_scope", () => {
    const action: RetryAction = { kind: "narrow_scope", focusArea: "input validation" };

    test("prepends focus guidance to messages", async () => {
      const result = await rewriter.rewrite(baseRequest, action, ctx);
      assertInjectedMessage(result, /focus/i);
      assertInjectedMessage(result, /input validation/);
    });

    test("preserves original messages unchanged", async () => {
      const result = await rewriter.rewrite(baseRequest, action, ctx);
      assertOriginalPreserved(result);
    });

    test("does not mutate original request", async () => {
      const originalLength = baseRequest.messages.length;
      await rewriter.rewrite(baseRequest, action, ctx);
      expect(baseRequest.messages.length).toBe(originalLength);
    });
  });

  describe("add_context", () => {
    const action: RetryAction = {
      kind: "add_context",
      context: "The API returns 429 on burst traffic",
    };

    test("injects error context", async () => {
      const result = await rewriter.rewrite(baseRequest, action, ctx);
      assertInjectedMessage(result, /429/);
      assertInjectedMessage(result, /burst traffic/);
    });

    test("preserves original messages", async () => {
      const result = await rewriter.rewrite(baseRequest, action, ctx);
      assertOriginalPreserved(result);
    });
  });

  describe("redirect", () => {
    const action: RetryAction = { kind: "redirect", newApproach: "Use batch processing instead" };

    test("suggests new approach", async () => {
      const result = await rewriter.rewrite(baseRequest, action, ctx);
      assertInjectedMessage(result, /batch processing/i);
    });

    test("preserves original messages", async () => {
      const result = await rewriter.rewrite(baseRequest, action, ctx);
      assertOriginalPreserved(result);
    });
  });

  describe("decompose", () => {
    const action: RetryAction = {
      kind: "decompose",
      subtasks: ["Parse input", "Validate schema", "Transform output"],
    };

    test("lists subtasks", async () => {
      const result = await rewriter.rewrite(baseRequest, action, ctx);
      assertInjectedMessage(result, /Parse input/);
      assertInjectedMessage(result, /Validate schema/);
      assertInjectedMessage(result, /Transform output/);
    });

    test("preserves original messages", async () => {
      const result = await rewriter.rewrite(baseRequest, action, ctx);
      assertOriginalPreserved(result);
    });
  });

  describe("escalate_model", () => {
    const action: RetryAction = { kind: "escalate_model", targetModel: "claude-opus-4-6" };

    test("sets ModelRequest.model to target", async () => {
      const result = await rewriter.rewrite(baseRequest, action, ctx);
      expect(result.model).toBe("claude-opus-4-6");
    });

    test("prepends escalation explanation", async () => {
      const result = await rewriter.rewrite(baseRequest, action, ctx);
      assertInjectedMessage(result, /escalat/i);
    });

    test("preserves original messages", async () => {
      const result = await rewriter.rewrite(baseRequest, action, ctx);
      assertOriginalPreserved(result);
    });
  });

  describe("abort", () => {
    const action: RetryAction = { kind: "abort", reason: "Budget exhausted after 3 retries" };

    test("throws with abort reason", () => {
      expect(() => rewriter.rewrite(baseRequest, action, ctx)).toThrow(/budget exhausted/i);
    });
  });
});
