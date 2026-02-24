import { describe, expect, it } from "bun:test";
import type { NodeFrame } from "../types.js";
import { decodeFrame, encodeFrame, generateCorrelationId } from "./protocol.js";

const validFrame: NodeFrame = {
  nodeId: "node-1",
  agentId: "agent-1",
  correlationId: "corr-1",
  kind: "agent:message",
  payload: { text: "hello" },
};

describe("encodeFrame", () => {
  it("serializes a valid frame to JSON string", () => {
    const encoded = encodeFrame(validFrame);
    const parsed = JSON.parse(encoded);
    expect(parsed.nodeId).toBe("node-1");
    expect(parsed.agentId).toBe("agent-1");
    expect(parsed.kind).toBe("agent:message");
  });

  it("includes optional ttl when provided", () => {
    const frame: NodeFrame = { ...validFrame, ttl: 5_000 };
    const encoded = encodeFrame(frame);
    const parsed = JSON.parse(encoded);
    expect(parsed.ttl).toBe(5_000);
  });
});

describe("decodeFrame", () => {
  it("decodes a valid JSON string", () => {
    const json = JSON.stringify(validFrame);
    const result = decodeFrame(json);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.nodeId).toBe("node-1");
      expect(result.value.agentId).toBe("agent-1");
      expect(result.value.kind).toBe("agent:message");
    }
  });

  it("decodes an ArrayBuffer", () => {
    const json = JSON.stringify(validFrame);
    const buffer = new TextEncoder().encode(json).buffer;
    const result = decodeFrame(buffer as ArrayBuffer);
    expect(result.ok).toBe(true);
  });

  it("rejects invalid JSON", () => {
    const result = decodeFrame("not json {{{");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message).toContain("not valid JSON");
    }
  });

  it("rejects non-object JSON (array)", () => {
    const result = decodeFrame("[1,2,3]");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("JSON object");
    }
  });

  it("rejects non-object JSON (string)", () => {
    const result = decodeFrame('"hello"');
    expect(result.ok).toBe(false);
  });

  it("rejects missing nodeId", () => {
    const result = decodeFrame(
      JSON.stringify({ agentId: "a", correlationId: "c", kind: "agent:message", payload: {} }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("nodeId");
    }
  });

  it("rejects empty nodeId", () => {
    const result = decodeFrame(
      JSON.stringify({ nodeId: "", agentId: "a", correlationId: "c", kind: "agent:message" }),
    );
    expect(result.ok).toBe(false);
  });

  it("rejects missing agentId", () => {
    const result = decodeFrame(
      JSON.stringify({ nodeId: "n", correlationId: "c", kind: "agent:message" }),
    );
    expect(result.ok).toBe(false);
  });

  it("rejects missing correlationId", () => {
    const result = decodeFrame(
      JSON.stringify({ nodeId: "n", agentId: "a", kind: "agent:message" }),
    );
    expect(result.ok).toBe(false);
  });

  it("rejects invalid frame kind", () => {
    const result = decodeFrame(
      JSON.stringify({ nodeId: "n", agentId: "a", correlationId: "c", kind: "invalid:kind" }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("invalid:kind");
    }
  });

  it("accepts all valid frame kinds", () => {
    const kinds = [
      "agent:dispatch",
      "agent:message",
      "agent:status",
      "agent:terminate",
      "node:handshake",
      "node:heartbeat",
      "node:capacity",
      "node:error",
    ] as const;
    for (const kind of kinds) {
      const result = decodeFrame(
        JSON.stringify({ nodeId: "n", agentId: "a", correlationId: "c", kind }),
      );
      expect(result.ok).toBe(true);
    }
  });

  it("rejects negative ttl", () => {
    const result = decodeFrame(JSON.stringify({ ...validFrame, ttl: -1 }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("ttl");
    }
  });

  it("accepts undefined ttl", () => {
    const json = JSON.stringify({ ...validFrame });
    const result = decodeFrame(json);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.ttl).toBeUndefined();
    }
  });

  it("accepts valid ttl", () => {
    const result = decodeFrame(JSON.stringify({ ...validFrame, ttl: 5_000 }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.ttl).toBe(5_000);
    }
  });

  it("rejects oversized frames", () => {
    const huge = "x".repeat(1_048_577);
    const result = decodeFrame(huge);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("maximum size");
    }
  });
});

describe("generateCorrelationId", () => {
  it("generates unique IDs", () => {
    const id1 = generateCorrelationId("node-1");
    const id2 = generateCorrelationId("node-1");
    expect(id1).not.toBe(id2);
  });

  it("includes nodeId prefix", () => {
    const id = generateCorrelationId("my-node");
    expect(id.startsWith("my-node-")).toBe(true);
  });
});
