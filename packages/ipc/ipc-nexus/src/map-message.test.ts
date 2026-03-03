import { describe, expect, test } from "bun:test";
import type { AgentMessageInput } from "@koi/core";
import { agentId, messageId } from "@koi/core";
import { mapKoiToNexus, mapNexusToKoi } from "./map-message.js";
import type { NexusMessageEnvelope } from "./nexus-client.js";

describe("mapKoiToNexus", () => {
  test("maps required fields correctly", () => {
    const input: AgentMessageInput = {
      from: agentId("agent-a"),
      to: agentId("agent-b"),
      kind: "request",
      type: "code-review",
      payload: { file: "main.ts" },
    };

    const result = mapKoiToNexus(input);

    expect(result.from).toBe("agent-a");
    expect(result.to).toBe("agent-b");
    expect(result.kind).toBe("task"); // request → task
    expect(result.type).toBe("code-review");
    expect(result.payload).toEqual({ file: "main.ts" });
  });

  test("maps all MessageKinds to Nexus kinds", () => {
    const base: AgentMessageInput = {
      from: agentId("a"),
      to: agentId("b"),
      kind: "request",
      type: "t",
      payload: {},
    };

    expect(mapKoiToNexus({ ...base, kind: "request" }).kind).toBe("task");
    expect(mapKoiToNexus({ ...base, kind: "response" }).kind).toBe("response");
    expect(mapKoiToNexus({ ...base, kind: "event" }).kind).toBe("event");
    expect(mapKoiToNexus({ ...base, kind: "cancel" }).kind).toBe("cancel");
  });

  test("includes optional fields when present", () => {
    const input: AgentMessageInput = {
      from: agentId("a"),
      to: agentId("b"),
      kind: "response",
      type: "t",
      payload: {},
      correlationId: messageId("req-1"),
      ttlSeconds: 300,
      metadata: { trace: "xyz" },
    };

    const result = mapKoiToNexus(input);

    expect(result.correlationId).toBe("req-1");
    expect(result.ttlSeconds).toBe(300);
    expect(result.metadata).toEqual({ trace: "xyz" });
  });

  test("omits optional fields when undefined", () => {
    const input: AgentMessageInput = {
      from: agentId("a"),
      to: agentId("b"),
      kind: "event",
      type: "t",
      payload: {},
    };

    const result = mapKoiToNexus(input);

    expect("correlationId" in result).toBe(false);
    expect("ttlSeconds" in result).toBe(false);
    expect("metadata" in result).toBe(false);
  });
});

describe("mapNexusToKoi", () => {
  test("maps Nexus envelope to AgentMessage", () => {
    const envelope: NexusMessageEnvelope = {
      id: "msg-1",
      from: "agent-a",
      to: "agent-b",
      kind: "task",
      createdAt: "2026-01-01T00:00:00Z",
      type: "code-review",
      payload: { file: "main.ts" },
    };

    const result = mapNexusToKoi(envelope);

    expect(result).toBeDefined();
    expect(result?.id).toBe(messageId("msg-1"));
    expect(result?.from).toBe(agentId("agent-a"));
    expect(result?.to).toBe(agentId("agent-b"));
    expect(result?.kind).toBe("request"); // task → request
    expect(result?.type).toBe("code-review");
    expect(result?.payload).toEqual({ file: "main.ts" });
  });

  test("maps all Nexus kinds to MessageKinds", () => {
    const base: NexusMessageEnvelope = {
      id: "m",
      from: "a",
      to: "b",
      kind: "task",
      createdAt: "2026-01-01T00:00:00Z",
      type: "t",
      payload: {},
    };

    expect(mapNexusToKoi({ ...base, kind: "task" })?.kind).toBe("request");
    expect(mapNexusToKoi({ ...base, kind: "response" })?.kind).toBe("response");
    expect(mapNexusToKoi({ ...base, kind: "event" })?.kind).toBe("event");
    expect(mapNexusToKoi({ ...base, kind: "cancel" })?.kind).toBe("cancel");
  });

  test("returns undefined for unknown kinds", () => {
    const envelope: NexusMessageEnvelope = {
      id: "m",
      from: "a",
      to: "b",
      kind: "unknown_kind",
      createdAt: "2026-01-01T00:00:00Z",
      type: "t",
      payload: {},
    };

    expect(mapNexusToKoi(envelope)).toBeUndefined();
  });

  test("includes optional fields from envelope", () => {
    const envelope: NexusMessageEnvelope = {
      id: "m",
      from: "a",
      to: "b",
      kind: "response",
      correlationId: "req-1",
      createdAt: "2026-01-01T00:00:00Z",
      ttlSeconds: 60,
      type: "t",
      payload: {},
      metadata: { routing: "priority" },
    };

    const result = mapNexusToKoi(envelope);
    expect(result?.correlationId).toBe(messageId("req-1"));
    expect(result?.ttlSeconds).toBe(60);
    expect(result?.metadata).toEqual({ routing: "priority" });
  });

  test("round-trips through both maps", () => {
    const input: AgentMessageInput = {
      from: agentId("agent-a"),
      to: agentId("agent-b"),
      kind: "request",
      type: "deploy",
      payload: { env: "prod" },
      correlationId: messageId("corr-1"),
      ttlSeconds: 120,
    };

    const nexus = mapKoiToNexus(input);

    // Simulate server adding id + createdAt
    const envelope: NexusMessageEnvelope = {
      ...nexus,
      id: "msg-gen",
      createdAt: "2026-01-01T00:00:00Z",
    };

    const result = mapNexusToKoi(envelope);

    expect(result?.from).toBe(agentId("agent-a"));
    expect(result?.to).toBe(agentId("agent-b"));
    expect(result?.kind).toBe("request");
    expect(result?.type).toBe("deploy");
    expect(result?.payload).toEqual({ env: "prod" });
    expect(result?.correlationId).toBe(messageId("corr-1"));
    expect(result?.ttlSeconds).toBe(120);
  });
});
