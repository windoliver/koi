import { describe, expect, test } from "bun:test";
import {
  createAckFrame,
  createErrorFrame,
  createFrameIdGenerator,
  negotiateProtocol,
  parseConnectFrame,
  parseFrame,
} from "../protocol.js";

describe("parseFrame", () => {
  test("accepts valid request frame", () => {
    const raw = JSON.stringify({
      kind: "request",
      id: "f1",
      seq: 0,
      timestamp: 1000,
      payload: null,
    });
    const result = parseFrame(raw);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.kind).toBe("request");
      expect(result.value.id).toBe("f1");
      expect(result.value.seq).toBe(0);
    }
  });

  test("accepts all valid frame kinds", () => {
    for (const kind of ["request", "response", "event", "ack", "error"]) {
      const r = parseFrame(JSON.stringify({ kind, id: "x", seq: 0, timestamp: 0, payload: null }));
      expect(r.ok).toBe(true);
    }
  });

  test("accepts optional ref field", () => {
    const raw = JSON.stringify({
      kind: "response",
      id: "f2",
      seq: 1,
      timestamp: 0,
      payload: null,
      ref: "f1",
    });
    const r = parseFrame(raw);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.ref).toBe("f1");
  });

  test("rejects malformed JSON", () => {
    const r = parseFrame("{bad json");
    expect(r.ok).toBe(false);
  });

  test("rejects unknown kind", () => {
    const r = parseFrame(
      JSON.stringify({ kind: "unknown", id: "x", seq: 0, timestamp: 0, payload: null }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toContain("kind");
  });

  test("rejects empty id", () => {
    const r = parseFrame(
      JSON.stringify({ kind: "request", id: "", seq: 0, timestamp: 0, payload: null }),
    );
    expect(r.ok).toBe(false);
  });

  test("rejects negative seq", () => {
    const r = parseFrame(
      JSON.stringify({ kind: "request", id: "x", seq: -1, timestamp: 0, payload: null }),
    );
    expect(r.ok).toBe(false);
  });

  test("rejects non-integer seq", () => {
    const r = parseFrame(
      JSON.stringify({ kind: "request", id: "x", seq: 1.5, timestamp: 0, payload: null }),
    );
    expect(r.ok).toBe(false);
  });

  test("rejects non-string ref", () => {
    const r = parseFrame(
      JSON.stringify({ kind: "request", id: "x", seq: 0, timestamp: 0, payload: null, ref: 42 }),
    );
    expect(r.ok).toBe(false);
  });
});

describe("parseConnectFrame", () => {
  test("accepts range format", () => {
    const r = parseConnectFrame(
      JSON.stringify({ kind: "connect", minProtocol: 1, maxProtocol: 2, auth: { token: "abc" } }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.minProtocol).toBe(1);
      expect(r.value.maxProtocol).toBe(2);
    }
  });

  test("accepts legacy single protocol field", () => {
    const r = parseConnectFrame(
      JSON.stringify({ kind: "connect", protocol: 1, auth: { token: "t" } }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.minProtocol).toBe(1);
      expect(r.value.maxProtocol).toBe(1);
    }
  });

  test("rejects missing kind", () => {
    const r = parseConnectFrame(
      JSON.stringify({ minProtocol: 1, maxProtocol: 1, auth: { token: "t" } }),
    );
    expect(r.ok).toBe(false);
  });

  test("rejects empty auth token", () => {
    const r = parseConnectFrame(
      JSON.stringify({ kind: "connect", minProtocol: 1, maxProtocol: 1, auth: { token: "" } }),
    );
    expect(r.ok).toBe(false);
  });

  test("rejects minProtocol > maxProtocol", () => {
    const r = parseConnectFrame(
      JSON.stringify({ kind: "connect", minProtocol: 2, maxProtocol: 1, auth: { token: "t" } }),
    );
    expect(r.ok).toBe(false);
  });

  test("rejects missing protocol fields", () => {
    const r = parseConnectFrame(JSON.stringify({ kind: "connect", auth: { token: "t" } }));
    expect(r.ok).toBe(false);
  });

  test("accepts optional client metadata", () => {
    const r = parseConnectFrame(
      JSON.stringify({
        kind: "connect",
        minProtocol: 1,
        maxProtocol: 1,
        auth: { token: "t" },
        client: { id: "c1", version: "1.0.0", platform: "cli" },
      }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.client?.id).toBe("c1");
      expect(r.value.client?.platform).toBe("cli");
    }
  });
});

describe("negotiateProtocol", () => {
  test("returns highest overlap", () => {
    const r = negotiateProtocol(1, 3, 2, 5);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe(3);
  });

  test("exact match", () => {
    const r = negotiateProtocol(1, 1, 1, 1);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe(1);
  });

  test("returns error when no overlap", () => {
    const r = negotiateProtocol(1, 2, 3, 4);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toContain("overlap");
  });
});

describe("createErrorFrame / createAckFrame", () => {
  test("createErrorFrame produces valid JSON", () => {
    const raw = createErrorFrame(0, "TEST", "test message");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(parsed.kind).toBe("error");
    expect((parsed.payload as Record<string, unknown>).code).toBe("TEST");
  });

  test("createAckFrame produces valid JSON with ref", () => {
    const raw = createAckFrame(5, "frame-ref", { ok: true });
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(parsed.kind).toBe("ack");
    expect(parsed.seq).toBe(5);
    expect(parsed.ref).toBe("frame-ref");
  });

  test("createFrameIdGenerator produces unique sequential IDs", () => {
    const gen = createFrameIdGenerator();
    const ids = Array.from({ length: 5 }, () => gen());
    expect(new Set(ids).size).toBe(5);
    expect(ids[0]).toMatch(/^gw-/);
  });
});
