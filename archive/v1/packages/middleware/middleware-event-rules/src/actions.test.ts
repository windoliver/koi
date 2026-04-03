import { describe, expect, mock, test } from "bun:test";
import { executeActions } from "./actions.js";
import type { ActionContext, ResolvedAction, RuleLogger } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockLogger(): RuleLogger & {
  readonly calls: readonly { readonly level: string; readonly message: string }[];
} {
  const calls: { level: string; message: string }[] = [];
  return {
    calls,
    info: (msg) => {
      calls.push({ level: "info", message: msg });
    },
    warn: (msg) => {
      calls.push({ level: "warn", message: msg });
    },
    error: (msg) => {
      calls.push({ level: "error", message: msg });
    },
    debug: (msg) => {
      calls.push({ level: "debug", message: msg });
    },
  };
}

function action(type: string, extra: Record<string, unknown> = {}): ResolvedAction {
  return { ruleName: "test-rule", action: { type, ...extra } as ResolvedAction["action"] };
}

// ---------------------------------------------------------------------------
// Action execution
// ---------------------------------------------------------------------------

describe("executeActions", () => {
  test("executes log action with interpolated message", async () => {
    const logger = createMockLogger();
    const ctx: ActionContext = { logger };

    await executeActions(
      [action("log", { level: "warn", message: "Tool {{toolId}} failed" })],
      { toolId: "shell_exec" },
      ctx,
    );

    expect(logger.calls).toHaveLength(1);
    expect(logger.calls[0]).toEqual({ level: "warn", message: "Tool shell_exec failed" });
  });

  test("executes escalate action with dependency", async () => {
    const logger = createMockLogger();
    const requestEscalation = mock(() => {});
    const ctx: ActionContext = { logger, requestEscalation };

    await executeActions([action("escalate", { message: "Help needed" })], {}, ctx);

    expect(requestEscalation).toHaveBeenCalledWith("Help needed");
  });

  test("degrades escalate to log.error when dependency missing", async () => {
    const logger = createMockLogger();
    const ctx: ActionContext = { logger };

    await executeActions([action("escalate", { message: "Help needed" })], {}, ctx);

    expect(logger.calls).toHaveLength(1);
    expect(logger.calls[0]?.level).toBe("error");
    expect(logger.calls[0]?.message).toContain("Help needed");
  });

  test("executes notify action with dependency", async () => {
    const logger = createMockLogger();
    const sendNotification = mock(() => {});
    const ctx: ActionContext = { logger, sendNotification };

    await executeActions(
      [action("notify", { channel: "ops", message: "Alert: {{msg}}" })],
      { msg: "high turns" },
      ctx,
    );

    expect(sendNotification).toHaveBeenCalledWith("ops", "Alert: high turns");
  });

  test("degrades notify to log.warn when dependency missing", async () => {
    const logger = createMockLogger();
    const ctx: ActionContext = { logger };

    await executeActions([action("notify", { channel: "ops", message: "Alert" })], {}, ctx);

    expect(logger.calls).toHaveLength(1);
    expect(logger.calls[0]?.level).toBe("warn");
    expect(logger.calls[0]?.message).toContain("ops");
  });

  test("executes emit action with dependency", async () => {
    const logger = createMockLogger();
    const emitEvent = mock(() => {});
    const ctx: ActionContext = { logger, emitEvent };

    await executeActions([action("emit", { event: "custom.alert", message: "hi" })], {}, ctx);

    expect(emitEvent).toHaveBeenCalledWith("custom.alert", { message: "hi" });
  });

  test("degrades emit to log.info when dependency missing", async () => {
    const logger = createMockLogger();
    const ctx: ActionContext = { logger };

    await executeActions([action("emit", { event: "custom.alert", message: "hi" })], {}, ctx);

    expect(logger.calls).toHaveLength(1);
    expect(logger.calls[0]?.level).toBe("info");
  });

  test("catches and logs action errors without propagating", async () => {
    const logger = createMockLogger();
    const requestEscalation = mock(() => {
      throw new Error("escalation service down");
    });
    const ctx: ActionContext = { logger, requestEscalation };

    // Should not throw
    await executeActions(
      [
        action("escalate", { message: "first" }),
        action("log", { level: "info", message: "second" }),
      ],
      {},
      ctx,
    );

    // First action error logged, second action still executes
    const errorCalls = logger.calls.filter((c) => c.level === "error");
    expect(errorCalls).toHaveLength(1);
    expect(errorCalls[0]?.message).toContain("escalation service down");

    const infoCalls = logger.calls.filter((c) => c.level === "info");
    expect(infoCalls).toHaveLength(1);
    expect(infoCalls[0]?.message).toBe("second");
  });

  test("skip_tool action is a no-op (handled by caller)", async () => {
    const logger = createMockLogger();
    const ctx: ActionContext = { logger };

    await executeActions([action("skip_tool", { toolId: "shell_exec" })], {}, ctx);

    expect(logger.calls).toHaveLength(0);
  });
});
