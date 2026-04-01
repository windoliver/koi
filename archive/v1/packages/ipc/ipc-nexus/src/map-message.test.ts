import { describe, expect, test } from "bun:test";
import type { AgentMessageInput } from "@koi/core";
import { agentId, messageId } from "@koi/core";
import { mapKoiToNexus, mapNexusToKoi, mapSendResponseToKoi } from "./map-message.js";
import type { NexusMessageEnvelope, NexusSendResponse } from "./nexus-client.js";

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

    expect(result.sender).toBe("agent-a");
    expect(result.recipient).toBe("agent-b");
    expect(result.type).toBe("task"); // request → task
    expect(result.payload).toEqual({ file: "main.ts", subType: "code-review" });
    // No "kind" field on NexusSendRequest
    expect("kind" in result).toBe(false);
  });

  test("maps all MessageKinds to Nexus type values", () => {
    const base: AgentMessageInput = {
      from: agentId("a"),
      to: agentId("b"),
      kind: "request",
      type: "t",
      payload: {},
    };

    expect(mapKoiToNexus({ ...base, kind: "request" }).type).toBe("task");
    expect(mapKoiToNexus({ ...base, kind: "response" }).type).toBe("response");
    expect(mapKoiToNexus({ ...base, kind: "event" }).type).toBe("event");
    expect(mapKoiToNexus({ ...base, kind: "cancel" }).type).toBe("cancel");
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

    expect(result.correlation_id).toBe("req-1");
    expect(result.ttl_seconds).toBe(300);
    // Metadata goes inside payload as _metadata
    expect(result.payload._metadata).toEqual({ trace: "xyz" });
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

    expect("correlation_id" in result).toBe(false);
    expect("ttl_seconds" in result).toBe(false);
    // No top-level metadata field on NexusSendRequest
    expect("metadata" in result).toBe(false);
  });
});

describe("mapNexusToKoi", () => {
  test("maps Nexus envelope to AgentMessage", () => {
    const envelope: NexusMessageEnvelope = {
      id: "msg-1",
      from: "agent-a",
      to: "agent-b",
      type: "task",
      timestamp: "2026-01-01T00:00:00Z",
      payload: { file: "main.ts", subType: "code-review" },
    };

    const result = mapNexusToKoi(envelope);

    expect(result).toBeDefined();
    expect(result?.id).toBe(messageId("msg-1"));
    expect(result?.from).toBe(agentId("agent-a"));
    expect(result?.to).toBe(agentId("agent-b"));
    expect(result?.kind).toBe("request"); // task → request
    expect(result?.type).toBe("code-review"); // subType extracted from payload
    expect(result?.payload).toEqual({ file: "main.ts" });
  });

  test("maps all Nexus types to MessageKinds", () => {
    const base: NexusMessageEnvelope = {
      id: "m",
      from: "a",
      to: "b",
      type: "task",
      timestamp: "2026-01-01T00:00:00Z",
      payload: {},
    };

    expect(mapNexusToKoi({ ...base, type: "task" })?.kind).toBe("request");
    expect(mapNexusToKoi({ ...base, type: "response" })?.kind).toBe("response");
    expect(mapNexusToKoi({ ...base, type: "event" })?.kind).toBe("event");
    expect(mapNexusToKoi({ ...base, type: "cancel" })?.kind).toBe("cancel");
  });

  test("returns undefined for unknown types", () => {
    const envelope: NexusMessageEnvelope = {
      id: "m",
      from: "a",
      to: "b",
      type: "unknown_type",
      timestamp: "2026-01-01T00:00:00Z",
      payload: {},
    };

    expect(mapNexusToKoi(envelope)).toBeUndefined();
  });

  test("includes optional fields from envelope", () => {
    const envelope: NexusMessageEnvelope = {
      id: "m",
      from: "a",
      to: "b",
      type: "response",
      correlation_id: "req-1",
      timestamp: "2026-01-01T00:00:00Z",
      ttl_seconds: 60,
      payload: { _metadata: { routing: "priority" } },
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

    // Simulate server adding id + timestamp (wire format uses from/to already)
    const envelope: NexusMessageEnvelope = {
      id: "msg-gen",
      from: nexus.sender,
      to: nexus.recipient,
      type: nexus.type,
      timestamp: "2026-01-01T00:00:00Z",
      payload: nexus.payload,
      ...(nexus.correlation_id !== undefined ? { correlation_id: nexus.correlation_id } : {}),
      ...(nexus.ttl_seconds !== undefined ? { ttl_seconds: nexus.ttl_seconds } : {}),
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

describe("mapSendResponseToKoi", () => {
  test("maps send response + original input to AgentMessage", () => {
    const response: NexusSendResponse = {
      message_id: "msg-gen-1",
      path: "/ipc/agent-a/inbox/msg-gen-1.json",
      sender: "agent-a",
      recipient: "agent-b",
      type: "task",
    };

    const input: AgentMessageInput = {
      from: agentId("agent-a"),
      to: agentId("agent-b"),
      kind: "request",
      type: "code-review",
      payload: { file: "main.ts" },
    };

    const result = mapSendResponseToKoi(response, input);

    expect(result.id).toBe(messageId("msg-gen-1"));
    expect(result.from).toBe(agentId("agent-a"));
    expect(result.to).toBe(agentId("agent-b"));
    expect(result.kind).toBe("request");
    expect(result.type).toBe("code-review");
    expect(result.payload).toEqual({ file: "main.ts" });
    expect(result.createdAt).toBeTruthy();
  });

  test("preserves optional fields from original input", () => {
    const response: NexusSendResponse = {
      message_id: "msg-gen-2",
      path: "/ipc/a/inbox/msg-gen-2.json",
      sender: "a",
      recipient: "b",
      type: "response",
    };

    const input: AgentMessageInput = {
      from: agentId("a"),
      to: agentId("b"),
      kind: "response",
      type: "t",
      payload: {},
      correlationId: messageId("req-1"),
      metadata: { trace: "xyz" },
    };

    const result = mapSendResponseToKoi(response, input);

    expect(result.correlationId).toBe(messageId("req-1"));
    expect(result.metadata).toEqual({ trace: "xyz" });
  });

  test("preserves ttlSeconds from original input", () => {
    const response: NexusSendResponse = {
      message_id: "msg-ttl",
      path: "/ipc/a/inbox/msg-ttl.json",
      sender: "a",
      recipient: "b",
      type: "task",
    };

    const input: AgentMessageInput = {
      from: agentId("a"),
      to: agentId("b"),
      kind: "request",
      type: "t",
      payload: {},
      ttlSeconds: 3600,
    };

    const result = mapSendResponseToKoi(response, input);

    expect(result.ttlSeconds).toBe(3600);
  });
});
