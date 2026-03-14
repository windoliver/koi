import { describe, expect, test } from "bun:test";
import type { ModelRequest } from "@koi/core";
import type { PromptRewriter, RetryAction, RewriteContext } from "./types.js";
import { createValidationRewriter } from "./validation-rewriter.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const baseRequest: ModelRequest = {
  messages: [
    {
      senderId: "user-1",
      content: [{ kind: "text", text: "Generate a JSON object" }],
      timestamp: 1700000000000,
    },
  ],
};

function makeRewriteContext(overrides: Partial<RewriteContext> = {}): RewriteContext {
  return {
    failureClass: { kind: "validation_failure", reason: "Validation failed: bad output" },
    records: [],
    turnIndex: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createValidationRewriter", () => {
  describe("validation_failure action", () => {
    test("injects actual error text as system message", async () => {
      const rewriter = createValidationRewriter();
      const action: RetryAction = {
        kind: "add_context",
        context: "Validation failed: Expected string at path 'name'",
      };
      const ctx = makeRewriteContext();

      const result = await rewriter.rewrite(baseRequest, action, ctx);

      expect(result.messages.length).toBeGreaterThan(baseRequest.messages.length);
      const injected = result.messages[0];
      expect(injected).toBeDefined();
      expect(injected?.senderId).toBe("system:validation-rewriter");
      const block = injected?.content[0];
      expect(block?.kind).toBe("text");
      if (block?.kind === "text") {
        expect(block.text).toContain("Expected string at path 'name'");
      }
    });

    test("message format includes [VALIDATION ERROR] prefix", async () => {
      const rewriter = createValidationRewriter();
      const action: RetryAction = {
        kind: "add_context",
        context: "Validation failed: missing required field",
      };
      const ctx = makeRewriteContext();

      const result = await rewriter.rewrite(baseRequest, action, ctx);

      const block = result.messages[0]?.content[0];
      if (block?.kind === "text") {
        expect(block.text).toContain("[VALIDATION ERROR]");
        expect(block.text).toContain("previous output failed validation");
      }
    });

    test("includes schema conformance guidance", async () => {
      const rewriter = createValidationRewriter();
      const action: RetryAction = { kind: "add_context", context: "bad output" };
      const ctx = makeRewriteContext();

      const result = await rewriter.rewrite(baseRequest, action, ctx);

      const block = result.messages[0]?.content[0];
      if (block?.kind === "text") {
        expect(block.text).toContain("Fix the output to conform");
      }
    });

    test("does not mutate original request", async () => {
      const rewriter = createValidationRewriter();
      const action: RetryAction = { kind: "add_context", context: "error details" };
      const ctx = makeRewriteContext();
      const originalLength = baseRequest.messages.length;

      await rewriter.rewrite(baseRequest, action, ctx);

      expect(baseRequest.messages.length).toBe(originalLength);
    });

    test("preserves original messages after injected message", async () => {
      const rewriter = createValidationRewriter();
      const action: RetryAction = { kind: "add_context", context: "error details" };
      const ctx = makeRewriteContext();

      const result = await rewriter.rewrite(baseRequest, action, ctx);

      const originals = result.messages.slice(1);
      expect(originals).toEqual([...baseRequest.messages]);
    });

    test("uses failureClass.reason when action is not add_context", async () => {
      const rewriter = createValidationRewriter();
      const action: RetryAction = {
        kind: "narrow_scope",
        focusArea: "output formatting",
      };
      const ctx = makeRewriteContext({
        failureClass: {
          kind: "validation_failure",
          reason: "Validation failed: Expected array, got object",
        },
      });

      const result = await rewriter.rewrite(baseRequest, action, ctx);

      const block = result.messages[0]?.content[0];
      if (block?.kind === "text") {
        expect(block.text).toContain("Expected array, got object");
      }
    });
  });

  describe("abort action for validation_failure", () => {
    test("throws with abort reason", () => {
      const rewriter = createValidationRewriter();
      const action: RetryAction = { kind: "abort", reason: "Budget exhausted" };
      const ctx = makeRewriteContext();

      expect(() => rewriter.rewrite(baseRequest, action, ctx)).toThrow(/budget exhausted/i);
    });
  });

  describe("non-validation action", () => {
    test("delegates to fallback rewriter", async () => {
      const fallback: PromptRewriter = {
        rewrite: (request) => ({
          ...request,
          messages: [
            { senderId: "fallback", content: [{ kind: "text", text: "fallback" }], timestamp: 0 },
            ...request.messages,
          ],
        }),
      };
      const rewriter = createValidationRewriter(fallback);
      const action: RetryAction = { kind: "add_context", context: "api error details" };
      const ctx = makeRewriteContext({
        failureClass: { kind: "api_error", reason: "server timeout" },
      });

      const result = await rewriter.rewrite(baseRequest, action, ctx);

      expect(result.messages[0]?.senderId).toBe("fallback");
    });

    test("returns request unchanged when no fallback is provided", async () => {
      const rewriter = createValidationRewriter();
      const action: RetryAction = { kind: "add_context", context: "api error" };
      const ctx = makeRewriteContext({
        failureClass: { kind: "api_error", reason: "timeout" },
      });

      const result = await rewriter.rewrite(baseRequest, action, ctx);

      expect(result.messages).toEqual(baseRequest.messages);
    });
  });
});
