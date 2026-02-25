import { describe, expect, it } from "bun:test";
import type { SessionContext } from "@koi/core";
import { runId, sessionId } from "@koi/core";
import {
  CONTEXT_ENV_KEYS,
  getExecutionContext,
  mapContextToEnv,
  runWithExecutionContext,
  type ToolExecutionContext,
} from "./execution-context.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTestSession(overrides?: Partial<SessionContext>): SessionContext {
  return {
    agentId: "agent-1",
    sessionId: sessionId("session-1"),
    runId: runId("run-1"),
    metadata: {},
    ...overrides,
  };
}

function createTestContext(overrides?: Partial<ToolExecutionContext>): ToolExecutionContext {
  return {
    session: createTestSession(),
    turnIndex: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("getExecutionContext", () => {
  it("returns undefined outside of runWithExecutionContext", () => {
    expect(getExecutionContext()).toBeUndefined();
  });

  it("returns correct context inside runWithExecutionContext", () => {
    const ctx = createTestContext({ turnIndex: 3 });
    const result = runWithExecutionContext(ctx, () => getExecutionContext());
    expect(result).toEqual(ctx);
  });

  it("returns undefined after runWithExecutionContext completes", () => {
    const ctx = createTestContext();
    runWithExecutionContext(ctx, () => {
      // noop
    });
    expect(getExecutionContext()).toBeUndefined();
  });
});

describe("runWithExecutionContext", () => {
  it("nested contexts do not leak to outer scope", () => {
    const outer = createTestContext({ turnIndex: 1 });
    const inner = createTestContext({ turnIndex: 2 });

    runWithExecutionContext(outer, () => {
      expect(getExecutionContext()?.turnIndex).toBe(1);

      runWithExecutionContext(inner, () => {
        expect(getExecutionContext()?.turnIndex).toBe(2);
      });

      // Outer context restored after inner completes
      expect(getExecutionContext()?.turnIndex).toBe(1);
    });
  });

  it("concurrent calls have isolated contexts", async () => {
    const ctxA = createTestContext({
      session: createTestSession({ agentId: "agent-A" }),
    });
    const ctxB = createTestContext({
      session: createTestSession({ agentId: "agent-B" }),
    });

    const results = await Promise.all([
      new Promise<string | undefined>((resolve) => {
        runWithExecutionContext(ctxA, () => {
          // Yield to event loop to allow interleaving
          setTimeout(() => {
            resolve(getExecutionContext()?.session.agentId);
          }, 10);
        });
      }),
      new Promise<string | undefined>((resolve) => {
        runWithExecutionContext(ctxB, () => {
          setTimeout(() => {
            resolve(getExecutionContext()?.session.agentId);
          }, 10);
        });
      }),
    ]);

    expect(results).toEqual(["agent-A", "agent-B"]);
  });

  it("returns the value from the callback", () => {
    const ctx = createTestContext();
    const result = runWithExecutionContext(ctx, () => 42);
    expect(result).toBe(42);
  });
});

describe("mapContextToEnv", () => {
  it("produces correct KOI_* keys for a full context", () => {
    const ctx = createTestContext({
      session: createTestSession({
        agentId: "agent-x",
        sessionId: sessionId("sess-x"),
        runId: runId("run-x"),
        userId: "user-x",
        channelId: "@koi/channel-telegram",
      }),
      turnIndex: 5,
    });

    const env = mapContextToEnv(ctx);

    expect(env[CONTEXT_ENV_KEYS.AGENT_ID]).toBe("agent-x");
    expect(env[CONTEXT_ENV_KEYS.SESSION_ID]).toBe("sess-x");
    expect(env[CONTEXT_ENV_KEYS.RUN_ID]).toBe("run-x");
    expect(env[CONTEXT_ENV_KEYS.USER_ID]).toBe("user-x");
    expect(env[CONTEXT_ENV_KEYS.CHANNEL]).toBe("@koi/channel-telegram");
    expect(env[CONTEXT_ENV_KEYS.TURN_INDEX]).toBe("5");
  });

  it("omits KOI_USER_ID when userId is undefined", () => {
    const ctx = createTestContext({
      session: createTestSession(),
    });

    const env = mapContextToEnv(ctx);

    expect(env[CONTEXT_ENV_KEYS.AGENT_ID]).toBe("agent-1");
    expect(CONTEXT_ENV_KEYS.USER_ID in env).toBe(false);
  });

  it("omits KOI_CHANNEL when channelId is undefined", () => {
    const ctx = createTestContext({
      session: createTestSession(),
    });

    const env = mapContextToEnv(ctx);

    expect(CONTEXT_ENV_KEYS.CHANNEL in env).toBe(false);
  });

  it("returns a frozen object", () => {
    const ctx = createTestContext();
    const env = mapContextToEnv(ctx);
    expect(Object.isFrozen(env)).toBe(true);
  });
});
