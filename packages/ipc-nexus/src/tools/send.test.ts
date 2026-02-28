import { describe, expect, test } from "bun:test";
import { createMockMailboxComponent } from "../test-helpers.js";
import { createSendTool } from "./send.js";

describe("createSendTool", () => {
  test("has correct descriptor", () => {
    const tool = createSendTool(createMockMailboxComponent(), "ipc", "verified");
    expect(tool.descriptor.name).toBe("ipc_send");
    expect(tool.descriptor.description).toBeTruthy();
    expect(tool.trustTier).toBe("verified");
  });

  test("sends message and returns result", async () => {
    const component = createMockMailboxComponent();
    const tool = createSendTool(component, "ipc", "verified");

    const result = await tool.execute({
      from: "agent-a",
      to: "agent-b",
      kind: "request",
      type: "code-review",
      payload: { file: "main.ts" },
    });

    const r = result as { message: { from: string; to: string; kind: string } };
    expect(r.message).toBeDefined();
    expect(r.message.from).toBe("agent-a");
    expect(r.message.to).toBe("agent-b");
    expect(r.message.kind).toBe("request");
  });

  test("validates required string fields", async () => {
    const tool = createSendTool(createMockMailboxComponent(), "ipc", "verified");

    const result = await tool.execute({
      from: 123,
      to: "b",
      kind: "request",
      type: "t",
      payload: {},
    });

    const r = result as { error: string; code: string };
    expect(r.code).toBe("VALIDATION");
  });

  test("validates kind is valid", async () => {
    const tool = createSendTool(createMockMailboxComponent(), "ipc", "verified");

    const result = await tool.execute({
      from: "a",
      to: "b",
      kind: "invalid_kind",
      type: "t",
      payload: {},
    });

    const r = result as { error: string; code: string };
    expect(r.code).toBe("VALIDATION");
    expect(r.error).toContain("Invalid kind");
  });

  test("validates payload is an object", async () => {
    const tool = createSendTool(createMockMailboxComponent(), "ipc", "verified");

    const result = await tool.execute({
      from: "a",
      to: "b",
      kind: "request",
      type: "t",
      payload: "not-an-object",
    });

    const r = result as { error: string; code: string };
    expect(r.code).toBe("VALIDATION");
  });

  test("includes optional correlationId and ttlSeconds", async () => {
    const component = createMockMailboxComponent();
    const tool = createSendTool(component, "ipc", "verified");

    const result = await tool.execute({
      from: "a",
      to: "b",
      kind: "response",
      type: "t",
      payload: {},
      correlationId: "req-1",
      ttlSeconds: 60,
    });

    const r = result as { message: { correlationId: string; ttlSeconds: number } };
    expect(r.message.correlationId).toBe("req-1");
    expect(r.message.ttlSeconds).toBe(60);
  });

  test("respects custom prefix", () => {
    const tool = createSendTool(createMockMailboxComponent(), "msg", "sandbox");
    expect(tool.descriptor.name).toBe("msg_send");
    expect(tool.trustTier).toBe("sandbox");
  });
});
