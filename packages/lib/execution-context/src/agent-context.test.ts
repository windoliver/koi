/**
 * Tests for AsyncLocalStorage-based agent execution context.
 */

import { describe, expect, test } from "bun:test";
import { getAgentContext, runWithAgentContext } from "./agent-context.js";
import { getExecutionContext, runWithExecutionContext } from "./execution-context.js";

describe("AgentExecutionContext", () => {
  test("returns undefined outside runWithAgentContext", () => {
    expect(getAgentContext()).toBeUndefined();
  });

  test("returns context inside runWithAgentContext", () => {
    const ctx = { agentId: "agent-1", sessionId: "session-1" };
    runWithAgentContext(ctx, () => {
      const result = getAgentContext();
      expect(result).toBeDefined();
      expect(result?.agentId).toBe("agent-1");
      expect(result?.sessionId).toBe("session-1");
    });
  });

  test("nested calls get inner context", () => {
    const outer = { agentId: "outer", sessionId: "s-outer" };
    const inner = { agentId: "inner", sessionId: "s-inner", parentAgentId: "outer" };

    runWithAgentContext(outer, () => {
      expect(getAgentContext()?.agentId).toBe("outer");
      runWithAgentContext(inner, () => {
        expect(getAgentContext()?.agentId).toBe("inner");
        expect(getAgentContext()?.parentAgentId).toBe("outer");
      });
      // Outer restored after inner exits
      expect(getAgentContext()?.agentId).toBe("outer");
    });
  });

  test("concurrent Promise.all runs get isolated contexts", async () => {
    const results: string[] = [];

    await Promise.all([
      runWithAgentContext({ agentId: "a", sessionId: "sa" }, async () => {
        await new Promise((r) => setTimeout(r, 10));
        results.push(getAgentContext()?.agentId ?? "missing");
      }),
      runWithAgentContext({ agentId: "b", sessionId: "sb" }, async () => {
        await new Promise((r) => setTimeout(r, 5));
        results.push(getAgentContext()?.agentId ?? "missing");
      }),
      runWithAgentContext({ agentId: "c", sessionId: "sc" }, async () => {
        results.push(getAgentContext()?.agentId ?? "missing");
      }),
    ]);

    // Each should have its own ID, regardless of timing
    expect(results).toContain("a");
    expect(results).toContain("b");
    expect(results).toContain("c");
    expect(results.length).toBe(3);
  });

  test("agent context does not interfere with tool execution context", () => {
    const agentCtx = { agentId: "agent-1", sessionId: "s-1" };
    // Cast to unknown first — SessionContext uses branded types (AgentId, RunId, etc.)
    // that are structurally identical to string at runtime. The test only needs to
    // verify context isolation, not type-safe construction.
    const toolCtx = {
      session: {
        agentId: "agent-1",
        sessionId: "s-1",
        runId: "run-1",
        conversationId: "conv-1",
      },
      turnIndex: 0,
    } as unknown as import("./execution-context.js").ToolExecutionContext;

    runWithAgentContext(agentCtx, () => {
      // Tool context is independent — not set yet
      expect(getExecutionContext()).toBeUndefined();

      runWithExecutionContext(toolCtx, () => {
        // Both contexts available simultaneously
        expect(getAgentContext()?.agentId).toBe("agent-1");
        // runId is a branded RunId — compare via String()
        expect(String(getExecutionContext()?.session.runId)).toBe("run-1");
      });

      // Tool context gone, agent context still here
      expect(getAgentContext()?.agentId).toBe("agent-1");
      expect(getExecutionContext()).toBeUndefined();
    });
  });
});
