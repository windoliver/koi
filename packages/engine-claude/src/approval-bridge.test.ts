import { describe, expect, test } from "bun:test";
import type { ApprovalDecision, ApprovalRequest } from "@koi/core";
import type { HitlEventEmitter } from "./approval-bridge.js";
import { createApprovalBridge } from "./approval-bridge.js";
import { HITL_EVENTS } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockEmitter(): {
  readonly emitter: HitlEventEmitter;
  readonly events: Array<{ readonly type: string; readonly data: unknown }>;
} {
  const events: Array<{ readonly type: string; readonly data: unknown }> = [];
  return {
    emitter: { emit: (event) => events.push(event) },
    events,
  };
}

// ---------------------------------------------------------------------------
// Approval decisions
// ---------------------------------------------------------------------------

describe("createApprovalBridge", () => {
  test("maps allow decision to SDK allow behavior", async () => {
    const handler = async (_req: ApprovalRequest): Promise<ApprovalDecision> => ({
      kind: "allow",
    });

    const canUseTool = createApprovalBridge(handler);
    const result = await canUseTool("search", { q: "test" });

    expect(result.behavior).toBe("allow");
    expect(result.updatedInput).toBeUndefined();
    expect(result.message).toBeUndefined();
  });

  test("maps deny decision to SDK deny behavior with reason", async () => {
    const handler = async (_req: ApprovalRequest): Promise<ApprovalDecision> => ({
      kind: "deny",
      reason: "Not allowed in sandbox",
    });

    const canUseTool = createApprovalBridge(handler);
    const result = await canUseTool("delete_file", { path: "/etc/passwd" });

    expect(result.behavior).toBe("deny");
    expect(result.message).toBe("Not allowed in sandbox");
  });

  test("maps modify decision to SDK allow with updatedInput", async () => {
    const handler = async (_req: ApprovalRequest): Promise<ApprovalDecision> => ({
      kind: "modify",
      updatedInput: { q: "sanitized query", limit: 10 },
    });

    const canUseTool = createApprovalBridge(handler);
    const result = await canUseTool("search", { q: "original query" });

    expect(result.behavior).toBe("allow");
    expect(result.updatedInput).toEqual({ q: "sanitized query", limit: 10 });
  });

  test("passes correct request shape to handler", async () => {
    let capturedRequest: ApprovalRequest | undefined;

    const handler = async (req: ApprovalRequest): Promise<ApprovalDecision> => {
      capturedRequest = req;
      return { kind: "allow" };
    };

    const canUseTool = createApprovalBridge(handler);
    await canUseTool("search", { q: "test", limit: 5 });

    expect(capturedRequest).toBeDefined();
    expect(capturedRequest?.toolId).toBe("search");
    expect(capturedRequest?.input).toEqual({ q: "test", limit: 5 });
    expect(capturedRequest?.reason).toBe('Tool "search" requires approval');
  });
});

// ---------------------------------------------------------------------------
// Error handling (fail-closed)
// ---------------------------------------------------------------------------

describe("fail-closed on handler error", () => {
  test("denies when handler throws an Error", async () => {
    const handler = async (): Promise<ApprovalDecision> => {
      throw new Error("Handler crashed");
    };

    const canUseTool = createApprovalBridge(handler);
    const result = await canUseTool("search", {});

    expect(result.behavior).toBe("deny");
    expect(result.message).toContain("Approval handler error");
    expect(result.message).toContain("Handler crashed");
  });

  test("denies when handler throws a string", async () => {
    const handler = async (): Promise<ApprovalDecision> => {
      throw "string error";
    };

    const canUseTool = createApprovalBridge(handler);
    const result = await canUseTool("search", {});

    expect(result.behavior).toBe("deny");
    expect(result.message).toContain("string error");
  });
});

// ---------------------------------------------------------------------------
// Event emission
// ---------------------------------------------------------------------------

describe("event emission", () => {
  test("emits request event before calling handler", async () => {
    const { emitter, events } = createMockEmitter();
    let handlerCalledAt = -1;

    const handler = async (): Promise<ApprovalDecision> => {
      handlerCalledAt = events.length;
      return { kind: "allow" };
    };

    const canUseTool = createApprovalBridge(handler, emitter);
    await canUseTool("search", { q: "test" });

    // Request event should be emitted before handler is called
    expect(handlerCalledAt).toBe(1); // 1 event (request) before handler
    expect(events[0]?.type).toBe(HITL_EVENTS.REQUEST);
    expect((events[0]?.data as Record<string, unknown>)?.toolName).toBe("search");
  });

  test("emits response event after handler returns", async () => {
    const { emitter, events } = createMockEmitter();

    const handler = async (): Promise<ApprovalDecision> => ({ kind: "allow" });

    const canUseTool = createApprovalBridge(handler, emitter);
    await canUseTool("search", {});

    expect(events).toHaveLength(2);
    expect(events[1]?.type).toBe(HITL_EVENTS.RESPONSE_RECEIVED);
    expect((events[1]?.data as Record<string, unknown>)?.decision).toBe("allow");
  });

  test("emits error event when handler throws", async () => {
    const { emitter, events } = createMockEmitter();

    const handler = async (): Promise<ApprovalDecision> => {
      throw new Error("Boom");
    };

    const canUseTool = createApprovalBridge(handler, emitter);
    await canUseTool("dangerous_tool", {});

    expect(events).toHaveLength(2); // request + error
    expect(events[0]?.type).toBe(HITL_EVENTS.REQUEST);
    expect(events[1]?.type).toBe(HITL_EVENTS.ERROR);
    expect((events[1]?.data as Record<string, unknown>)?.error).toBe("Boom");
  });

  test("works without emitter (no errors)", async () => {
    const handler = async (): Promise<ApprovalDecision> => ({ kind: "allow" });

    const canUseTool = createApprovalBridge(handler);
    const result = await canUseTool("search", {});

    expect(result.behavior).toBe("allow");
  });
});
