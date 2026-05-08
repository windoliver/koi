import { describe, expect, test } from "bun:test";
import type { InboundMessage, ModelRequest } from "@koi/core";
import { createDefaultPromptRewriter } from "./default-rewriter.js";
import type { RetryAction, RewriteContext } from "./types.js";

const baseMessage: InboundMessage = {
  senderId: "user",
  content: [{ kind: "text", text: "original prompt" }] as const,
  timestamp: 0,
};

const baseRequest: ModelRequest = {
  messages: [baseMessage],
  model: "gpt-4o-mini",
};

const ctx: RewriteContext = {
  attemptNumber: 2,
  previousFailure: { kind: "tool_misuse", details: "n/a" },
} as unknown as RewriteContext;

const rewriter = createDefaultPromptRewriter();

function rewrite(req: ModelRequest, action: RetryAction): ModelRequest {
  const out = rewriter.rewrite(req, action, ctx);
  if (out instanceof Promise) throw new Error("default rewriter must be sync");
  return out;
}

function firstInjectedText(req: ModelRequest): string {
  const head = req.messages[0];
  expect(head?.senderId).toBe("system:semantic-retry");
  const block = head?.content[0];
  expect(block?.kind).toBe("text");
  return block?.kind === "text" ? block.text : "";
}

describe("createDefaultPromptRewriter", () => {
  test("narrow_scope prepends focus guidance and preserves original messages", () => {
    const action: RetryAction = { kind: "narrow_scope", focusArea: "auth flow only" };
    const out = rewrite(baseRequest, action);
    expect(out.messages.length).toBe(2);
    expect(out.messages[1]).toBe(baseMessage);
    expect(firstInjectedText(out)).toContain("Focus specifically on: auth flow only");
    expect(out).not.toBe(baseRequest);
  });

  test("add_context prepends supplied context", () => {
    const action: RetryAction = { kind: "add_context", context: "API requires X-Key header" };
    const out = rewrite(baseRequest, action);
    expect(firstInjectedText(out)).toContain("Additional context: API requires X-Key header");
  });

  test("redirect prepends new approach", () => {
    const action: RetryAction = { kind: "redirect", newApproach: "use REST instead of GraphQL" };
    const out = rewrite(baseRequest, action);
    expect(firstInjectedText(out)).toContain(
      "Try a different approach: use REST instead of GraphQL",
    );
  });

  test("decompose prepends numbered subtask list", () => {
    const action: RetryAction = {
      kind: "decompose",
      subtasks: ["fetch token", "call api", "parse result"],
    };
    const out = rewrite(baseRequest, action);
    const text = firstInjectedText(out);
    expect(text).toContain("1. fetch token");
    expect(text).toContain("2. call api");
    expect(text).toContain("3. parse result");
  });

  test("escalate_model swaps the model and injects guidance", () => {
    const action: RetryAction = { kind: "escalate_model", targetModel: "gpt-4o" };
    const out = rewrite(baseRequest, action);
    expect(out.model).toBe("gpt-4o");
    expect(firstInjectedText(out)).toContain("Escalating to a more capable model");
  });

  test("abort throws with the supplied reason", () => {
    const action: RetryAction = { kind: "abort", reason: "budget exhausted" };
    expect(() => rewriter.rewrite(baseRequest, action, ctx)).toThrow("budget exhausted");
  });

  test("does not mutate the original request", () => {
    const action: RetryAction = { kind: "narrow_scope", focusArea: "x" };
    const before = baseRequest.messages.length;
    rewrite(baseRequest, action);
    expect(baseRequest.messages.length).toBe(before);
  });

  test("injected messages use system:semantic-retry sender prefix", () => {
    const out = rewrite(baseRequest, { kind: "redirect", newApproach: "x" });
    expect(out.messages[0]?.senderId).toBe("system:semantic-retry");
  });
});
