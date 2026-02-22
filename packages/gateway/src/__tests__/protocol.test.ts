import { describe, expect, test } from "bun:test";
import { encodeFrame, parseConnectFrame, parseFrame } from "../protocol.js";
import type { GatewayFrame } from "../types.js";

describe("parseFrame", () => {
  test("parses valid request frame", () => {
    const raw = JSON.stringify({
      kind: "request",
      id: "abc-123",
      seq: 0,
      timestamp: 1000,
      payload: { action: "ping" },
    });
    const result = parseFrame(raw);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.kind).toBe("request");
      expect(result.value.id).toBe("abc-123");
      expect(result.value.seq).toBe(0);
      expect(result.value.payload).toEqual({ action: "ping" });
    }
  });

  test("parses valid frame for each kind", () => {
    const kinds = ["request", "response", "event", "ack", "error"] as const;
    for (const kind of kinds) {
      const raw = JSON.stringify({
        kind,
        id: `id-${kind}`,
        seq: 1,
        timestamp: 1000,
        payload: null,
      });
      const result = parseFrame(raw);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.kind).toBe(kind);
      }
    }
  });

  test("parses frame with ref field", () => {
    const raw = JSON.stringify({
      kind: "response",
      id: "resp-1",
      seq: 1,
      ref: "req-1",
      timestamp: 1000,
      payload: null,
    });
    const result = parseFrame(raw);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.ref).toBe("req-1");
    }
  });

  test("rejects malformed JSON", () => {
    const result = parseFrame("{not valid json");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message).toBe("Malformed JSON");
    }
  });

  test("rejects non-object JSON", () => {
    expect(parseFrame('"hello"').ok).toBe(false);
    expect(parseFrame("42").ok).toBe(false);
    expect(parseFrame("[]").ok).toBe(false);
    expect(parseFrame("null").ok).toBe(false);
  });

  test("rejects missing required fields", () => {
    // Missing kind
    expect(parseFrame(JSON.stringify({ id: "a", seq: 0, timestamp: 1 })).ok).toBe(false);
    // Missing id
    expect(parseFrame(JSON.stringify({ kind: "request", seq: 0, timestamp: 1 })).ok).toBe(false);
    // Missing seq
    expect(parseFrame(JSON.stringify({ kind: "request", id: "a", timestamp: 1 })).ok).toBe(false);
    // Missing timestamp
    expect(parseFrame(JSON.stringify({ kind: "request", id: "a", seq: 0 })).ok).toBe(false);
  });

  test("rejects unknown kind value", () => {
    const raw = JSON.stringify({ kind: "unknown", id: "a", seq: 0, timestamp: 1, payload: null });
    const result = parseFrame(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("kind");
    }
  });

  test("rejects empty id", () => {
    const raw = JSON.stringify({ kind: "request", id: "", seq: 0, timestamp: 1, payload: null });
    const result = parseFrame(raw);
    expect(result.ok).toBe(false);
  });

  test("rejects negative seq", () => {
    const raw = JSON.stringify({ kind: "request", id: "a", seq: -1, timestamp: 1, payload: null });
    const result = parseFrame(raw);
    expect(result.ok).toBe(false);
  });

  test("rejects non-integer seq", () => {
    const raw = JSON.stringify({ kind: "request", id: "a", seq: 1.5, timestamp: 1, payload: null });
    const result = parseFrame(raw);
    expect(result.ok).toBe(false);
  });

  test("rejects non-string ref", () => {
    const raw = JSON.stringify({
      kind: "request",
      id: "a",
      seq: 0,
      timestamp: 1,
      ref: 123,
      payload: null,
    });
    const result = parseFrame(raw);
    expect(result.ok).toBe(false);
  });

  test("handles undefined payload", () => {
    const raw = JSON.stringify({ kind: "request", id: "a", seq: 0, timestamp: 1 });
    const result = parseFrame(raw);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.payload).toBeUndefined();
    }
  });
});

describe("parseConnectFrame", () => {
  test("parses valid connect frame", () => {
    const raw = JSON.stringify({
      type: "connect",
      protocol: 1,
      auth: { token: "my-token" },
    });
    const result = parseConnectFrame(raw);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.type).toBe("connect");
      expect(result.value.protocol).toBe(1);
      expect(result.value.auth.token).toBe("my-token");
    }
  });

  test("parses connect frame with client metadata", () => {
    const raw = JSON.stringify({
      type: "connect",
      protocol: 1,
      auth: { token: "tok" },
      client: { id: "cli-1", version: "2.0", platform: "web" },
    });
    const result = parseConnectFrame(raw);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.client?.id).toBe("cli-1");
      expect(result.value.client?.version).toBe("2.0");
      expect(result.value.client?.platform).toBe("web");
    }
  });

  test("rejects non-connect type", () => {
    const raw = JSON.stringify({ type: "request", protocol: 1, auth: { token: "t" } });
    const result = parseConnectFrame(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("connect");
    }
  });

  test("rejects missing type", () => {
    const raw = JSON.stringify({ protocol: 1, auth: { token: "t" } });
    expect(parseConnectFrame(raw).ok).toBe(false);
  });

  test("rejects missing protocol", () => {
    const raw = JSON.stringify({ type: "connect", auth: { token: "t" } });
    expect(parseConnectFrame(raw).ok).toBe(false);
  });

  test("rejects protocol < 1", () => {
    const raw = JSON.stringify({ type: "connect", protocol: 0, auth: { token: "t" } });
    expect(parseConnectFrame(raw).ok).toBe(false);
  });

  test("rejects missing auth", () => {
    const raw = JSON.stringify({ type: "connect", protocol: 1 });
    expect(parseConnectFrame(raw).ok).toBe(false);
  });

  test("rejects empty token", () => {
    const raw = JSON.stringify({ type: "connect", protocol: 1, auth: { token: "" } });
    expect(parseConnectFrame(raw).ok).toBe(false);
  });

  test("rejects malformed JSON", () => {
    const result = parseConnectFrame("not json");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
    }
  });

  test("rejects raw string (non-JSON)", () => {
    const result = parseConnectFrame("just-a-token");
    expect(result.ok).toBe(false);
  });

  test("accepts partial client object", () => {
    const raw = JSON.stringify({
      type: "connect",
      protocol: 1,
      auth: { token: "t" },
      client: { platform: "ios" },
    });
    const result = parseConnectFrame(raw);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.client?.platform).toBe("ios");
      expect(result.value.client?.id).toBeUndefined();
    }
  });
});

describe("encodeFrame", () => {
  test("round-trips a frame through encode/parse", () => {
    const frame: GatewayFrame = {
      kind: "event",
      id: "evt-1",
      seq: 42,
      timestamp: Date.now(),
      payload: { data: "hello" },
    };
    const encoded = encodeFrame(frame);
    const result = parseFrame(encoded);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual(frame);
    }
  });

  test("encodes frame with ref", () => {
    const frame: GatewayFrame = {
      kind: "response",
      id: "resp-1",
      seq: 1,
      ref: "req-1",
      timestamp: 1000,
      payload: null,
    };
    const encoded = encodeFrame(frame);
    const parsed = JSON.parse(encoded);
    expect(parsed.ref).toBe("req-1");
  });
});
