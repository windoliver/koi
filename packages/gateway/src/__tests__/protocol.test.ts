import { describe, expect, test } from "bun:test";
import { encodeFrame, negotiateProtocol, parseConnectFrame, parseFrame } from "../protocol.js";
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
  test("parses valid range format (minProtocol/maxProtocol)", () => {
    const raw = JSON.stringify({
      kind: "connect",
      minProtocol: 1,
      maxProtocol: 3,
      auth: { token: "my-token" },
    });
    const result = parseConnectFrame(raw);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.kind).toBe("connect");
      expect(result.value.minProtocol).toBe(1);
      expect(result.value.maxProtocol).toBe(3);
      expect(result.value.auth.token).toBe("my-token");
    }
  });

  test("parses legacy protocol field normalized to range", () => {
    const raw = JSON.stringify({
      kind: "connect",
      protocol: 2,
      auth: { token: "my-token" },
    });
    const result = parseConnectFrame(raw);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.minProtocol).toBe(2);
      expect(result.value.maxProtocol).toBe(2);
    }
  });

  test("parses connect frame with client metadata", () => {
    const raw = JSON.stringify({
      kind: "connect",
      minProtocol: 1,
      maxProtocol: 1,
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

  test("rejects non-connect kind", () => {
    const raw = JSON.stringify({
      kind: "request",
      minProtocol: 1,
      maxProtocol: 1,
      auth: { token: "t" },
    });
    const result = parseConnectFrame(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("connect");
    }
  });

  test("rejects missing kind", () => {
    const raw = JSON.stringify({ minProtocol: 1, maxProtocol: 1, auth: { token: "t" } });
    expect(parseConnectFrame(raw).ok).toBe(false);
  });

  test("rejects missing both protocol formats", () => {
    const raw = JSON.stringify({ kind: "connect", auth: { token: "t" } });
    const result = parseConnectFrame(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("Missing protocol version");
    }
  });

  test("rejects minProtocol > maxProtocol", () => {
    const raw = JSON.stringify({
      kind: "connect",
      minProtocol: 5,
      maxProtocol: 2,
      auth: { token: "t" },
    });
    const result = parseConnectFrame(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("minProtocol");
    }
  });

  test("rejects non-integer minProtocol", () => {
    const raw = JSON.stringify({
      kind: "connect",
      minProtocol: 1.5,
      maxProtocol: 2,
      auth: { token: "t" },
    });
    expect(parseConnectFrame(raw).ok).toBe(false);
  });

  test("rejects minProtocol < 1", () => {
    const raw = JSON.stringify({
      kind: "connect",
      minProtocol: 0,
      maxProtocol: 2,
      auth: { token: "t" },
    });
    expect(parseConnectFrame(raw).ok).toBe(false);
  });

  test("rejects non-integer maxProtocol", () => {
    const raw = JSON.stringify({
      kind: "connect",
      minProtocol: 1,
      maxProtocol: 2.5,
      auth: { token: "t" },
    });
    expect(parseConnectFrame(raw).ok).toBe(false);
  });

  test("rejects legacy protocol < 1", () => {
    const raw = JSON.stringify({ kind: "connect", protocol: 0, auth: { token: "t" } });
    expect(parseConnectFrame(raw).ok).toBe(false);
  });

  test("rejects missing auth", () => {
    const raw = JSON.stringify({ kind: "connect", minProtocol: 1, maxProtocol: 1 });
    expect(parseConnectFrame(raw).ok).toBe(false);
  });

  test("rejects empty token", () => {
    const raw = JSON.stringify({
      kind: "connect",
      minProtocol: 1,
      maxProtocol: 1,
      auth: { token: "" },
    });
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
      kind: "connect",
      minProtocol: 1,
      maxProtocol: 1,
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

describe("negotiateProtocol", () => {
  test("picks highest overlap when ranges overlap", () => {
    const result = negotiateProtocol(1, 3, 2, 5);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe(3);
    }
  });

  test("exact match returns the single version", () => {
    const result = negotiateProtocol(2, 2, 2, 2);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe(2);
    }
  });

  test("boundary overlap (single version in common)", () => {
    const result = negotiateProtocol(1, 3, 3, 5);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe(3);
    }
  });

  test("server range wider than client", () => {
    const result = negotiateProtocol(2, 3, 1, 5);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe(3);
    }
  });

  test("client range wider than server", () => {
    const result = negotiateProtocol(1, 5, 2, 3);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe(3);
    }
  });

  test("no overlap — client too old", () => {
    const result = negotiateProtocol(1, 2, 3, 5);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message).toContain("No protocol overlap");
    }
  });

  test("no overlap — client too new", () => {
    const result = negotiateProtocol(4, 6, 1, 3);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("No protocol overlap");
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
