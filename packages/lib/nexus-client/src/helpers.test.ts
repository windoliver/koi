import { describe, expect, test } from "bun:test";
import type { KoiError, Result } from "@koi/core";
import { deleteJson, readJson, validatePathSegment, wrapNexusError, writeJson } from "./helpers.js";
import type { NexusClient } from "./types.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createMockClient(
  handler: (method: string, params: Record<string, unknown>) => Promise<Result<unknown, KoiError>>,
): NexusClient {
  return {
    rpc: handler as NexusClient["rpc"],
  };
}

const OK_NULL: Result<null, KoiError> = { ok: true, value: null };

// ---------------------------------------------------------------------------
// wrapNexusError
// ---------------------------------------------------------------------------

describe("wrapNexusError", () => {
  test("creates error with correct code and retryability", () => {
    const err = wrapNexusError("TIMEOUT", "timed out");
    expect(err.code).toBe("TIMEOUT");
    expect(err.message).toBe("timed out");
    expect(err.retryable).toBe(true);
  });

  test("attaches cause when provided", () => {
    const cause = new Error("root");
    const err = wrapNexusError("INTERNAL", "failed", cause);
    expect(err.cause).toBe(cause);
  });

  test("non-retryable code", () => {
    const err = wrapNexusError("VALIDATION", "bad input");
    expect(err.retryable).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// validatePathSegment
// ---------------------------------------------------------------------------

describe("validatePathSegment", () => {
  test("accepts valid segment", () => {
    const r = validatePathSegment("my-session-123", "sessionId");
    expect(r.ok).toBe(true);
  });

  test("rejects empty string", () => {
    const r = validatePathSegment("", "sessionId");
    expect(r.ok).toBe(false);
  });

  test("rejects forward slash", () => {
    const r = validatePathSegment("foo/bar", "nodeId");
    expect(r.ok).toBe(false);
  });

  test("rejects backslash", () => {
    const r = validatePathSegment("foo\\bar", "nodeId");
    expect(r.ok).toBe(false);
  });

  test("rejects traversal", () => {
    const r = validatePathSegment("..", "surfaceId");
    expect(r.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// readJson
// ---------------------------------------------------------------------------

describe("readJson", () => {
  test("reads and parses valid JSON", async () => {
    const client = createMockClient(async () => ({
      ok: true,
      value: JSON.stringify({ name: "test" }),
    }));
    const r = await readJson<{ readonly name: string }>(client, "test/path.json");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.name).toBe("test");
    }
  });

  test("returns error on RPC failure", async () => {
    const client = createMockClient(async () => ({
      ok: false,
      error: wrapNexusError("NOT_FOUND", "not found"),
    }));
    const r = await readJson(client, "missing.json");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("NOT_FOUND");
    }
  });

  test("wraps parse error as INTERNAL", async () => {
    const client = createMockClient(async () => ({
      ok: true,
      value: "not valid json{{{",
    }));
    const r = await readJson(client, "bad.json");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("INTERNAL");
      expect(r.error.message).toContain("Failed to parse JSON");
    }
  });
});

// ---------------------------------------------------------------------------
// writeJson
// ---------------------------------------------------------------------------

describe("writeJson", () => {
  test("serializes and writes data", async () => {
    let captured: Record<string, unknown> = {};
    const client = createMockClient(async (_method, params) => {
      captured = params;
      return OK_NULL;
    });
    const r = await writeJson(client, "test/path.json", { x: 1 });
    expect(r.ok).toBe(true);
    expect(captured.content).toBe('{"x":1}');
    expect(captured.path).toBe("test/path.json");
  });

  test("returns error on RPC failure", async () => {
    const client = createMockClient(async () => ({
      ok: false,
      error: wrapNexusError("EXTERNAL", "server error"),
    }));
    const r = await writeJson(client, "test/path.json", {});
    expect(r.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// deleteJson
// ---------------------------------------------------------------------------

describe("deleteJson", () => {
  test("deletes a document", async () => {
    let captured: Record<string, unknown> = {};
    const client = createMockClient(async (_method, params) => {
      captured = params;
      return OK_NULL;
    });
    const r = await deleteJson(client, "test/path.json");
    expect(r.ok).toBe(true);
    expect(captured.path).toBe("test/path.json");
  });

  test("returns error on RPC failure", async () => {
    const client = createMockClient(async () => ({
      ok: false,
      error: wrapNexusError("NOT_FOUND", "not found"),
    }));
    const r = await deleteJson(client, "missing.json");
    expect(r.ok).toBe(false);
  });
});
