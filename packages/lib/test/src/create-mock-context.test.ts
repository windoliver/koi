import { describe, expect, test } from "bun:test";
import { sessionId } from "@koi/core";
import { createMockSessionContext, createMockTurnContext } from "./create-mock-context.js";

describe("createMockSessionContext", () => {
  test("returns defaults when no overrides", () => {
    const ctx = createMockSessionContext();
    expect(ctx.agentId).toBe("test-agent");
    expect(String(ctx.sessionId)).toBe("test-session");
    expect(String(ctx.runId)).toBe("test-run");
    expect(ctx.metadata).toEqual({});
  });

  test("overrides win over defaults", () => {
    const ctx = createMockSessionContext({
      agentId: "other",
      sessionId: sessionId("s-2"),
      metadata: { foo: "bar" },
    });
    expect(ctx.agentId).toBe("other");
    expect(String(ctx.sessionId)).toBe("s-2");
    expect(ctx.metadata).toEqual({ foo: "bar" });
  });
});

describe("createMockTurnContext", () => {
  test("returns defaults when no overrides", () => {
    const ctx = createMockTurnContext();
    expect(ctx.session.agentId).toBe("test-agent");
    expect(ctx.turnIndex).toBe(0);
    expect(String(ctx.turnId)).toBe("test-run:t0");
    expect(ctx.messages).toEqual([]);
  });

  test("session overrides are merged into the constructed session", () => {
    const ctx = createMockTurnContext({
      session: { agentId: "override-agent" },
    });
    expect(ctx.session.agentId).toBe("override-agent");
    // Other session fields fall back to defaults
    expect(String(ctx.session.sessionId)).toBe("test-session");
  });

  test("turnIndex change propagates to turnId", () => {
    const ctx = createMockTurnContext({ turnIndex: 3 });
    expect(ctx.turnIndex).toBe(3);
    expect(String(ctx.turnId)).toBe("test-run:t3");
  });

  test("explicit overrides win over defaults", () => {
    const ctx = createMockTurnContext({
      metadata: { trace: "xyz" },
    });
    expect(ctx.metadata).toEqual({ trace: "xyz" });
  });
});
