import { describe, expect, test } from "bun:test";
import type { ApprovalRequest } from "@koi/core";
import { agentGroupId, runId } from "@koi/core";
import { createTurnContext, generatePid, unrefTimer } from "./koi-helpers.js";

describe("generatePid", () => {
  test("creates copilot pid for top-level agent", () => {
    const pid = generatePid({ name: "test-agent" });
    expect(pid.name).toBe("test-agent");
    expect(pid.type).toBe("copilot");
    expect(pid.depth).toBe(0);
    expect(pid.parent).toBeUndefined();
  });

  test("creates worker pid when parent is provided", () => {
    const parent = generatePid({ name: "parent" });
    const child = generatePid({ name: "child" }, { parent });
    expect(child.type).toBe("worker");
    expect(child.depth).toBe(1);
    expect(child.parent).toBe(parent.id);
  });

  test("respects explicit lifecycle over defaults", () => {
    const parent = generatePid({ name: "parent" });
    const pid = generatePid({ name: "forced-copilot", lifecycle: "copilot" }, { parent });
    expect(pid.type).toBe("copilot");
  });

  test("includes groupId when provided", () => {
    const gid = agentGroupId("group-1");
    const pid = generatePid({ name: "grouped" }, { groupId: gid });
    expect(pid.groupId).toBe(gid);
  });
});

describe("unrefTimer", () => {
  test("calls unref on timer-like objects", () => {
    // let justified: tracking whether unref was called
    let called = false;
    const timer = {
      unref: () => {
        called = true;
      },
    } as unknown as ReturnType<typeof setInterval>;
    unrefTimer(timer);
    expect(called).toBe(true);
  });

  test("does nothing for plain numbers", () => {
    // Should not throw
    unrefTimer(42 as unknown as ReturnType<typeof setInterval>);
  });
});

describe("createTurnContext", () => {
  test("creates context with hierarchical turnId", () => {
    const rid = runId("test-run-123");
    const session = {
      agentId: "agent-1" as never,
      sessionId: "session-1" as never,
      runId: rid,
      metadata: {},
    };
    const ctx = createTurnContext({
      session,
      turnIndex: 3,
      messages: [],
    });
    expect(ctx.session).toBe(session);
    expect(ctx.turnIndex).toBe(3);
    expect(ctx.turnId).toContain("test-run-123");
    expect(ctx.messages).toEqual([]);
    expect(ctx.metadata).toEqual({});
  });

  test("includes optional signal and approvalHandler", () => {
    const rid = runId("run-456");
    const session = {
      agentId: "agent-1" as never,
      sessionId: "session-1" as never,
      runId: rid,
      metadata: {},
    };
    const controller = new AbortController();
    const handler = async (_req: ApprovalRequest) => ({ kind: "allow" }) as const;

    const ctx = createTurnContext({
      session,
      turnIndex: 0,
      messages: [],
      signal: controller.signal,
      approvalHandler: handler,
    });
    expect(ctx.signal).toBe(controller.signal);
    expect(ctx.requestApproval).toBeDefined();
  });
});
