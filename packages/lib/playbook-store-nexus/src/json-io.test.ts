/**
 * Unit tests for the playbook-store-nexus json-io helpers.
 *
 * Focuses on EXTERNAL error propagation (Finding 2): EXTERNAL must surface as
 * an error, never silently collapse to "absent".
 */

import { describe, expect, test } from "bun:test";
import { createFakeNexusTransport } from "@koi/fs-nexus/testing";
import {
  decodeAceId,
  deleteJson,
  encodeAceId,
  exists,
  readJson,
  validateAceId,
  writeJson,
} from "./json-io.js";

describe("validateAceId", () => {
  test("accepts plain id", () => {
    expect(validateAceId("abc", "ID").ok).toBe(true);
  });

  test("accepts id with colon", () => {
    expect(validateAceId("a:b:c", "ID").ok).toBe(true);
  });

  test("accepts id with underscore", () => {
    expect(validateAceId("a_b", "ID").ok).toBe(true);
  });

  test("rejects empty id", () => {
    const r = validateAceId("", "ID");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("VALIDATION");
  });

  test("rejects id with /", () => {
    const r = validateAceId("a/b", "ID");
    expect(r.ok).toBe(false);
  });

  test("rejects id with ..", () => {
    const r = validateAceId("a..b", "ID");
    expect(r.ok).toBe(false);
  });

  test("rejects id with backslash", () => {
    const r = validateAceId("a\\b", "ID");
    expect(r.ok).toBe(false);
  });

  test("rejects id with null byte", () => {
    const r = validateAceId("a\0b", "ID");
    expect(r.ok).toBe(false);
  });

  test("rejects id with newline", () => {
    const r = validateAceId("a\nb", "ID");
    expect(r.ok).toBe(false);
  });

  // Fix 3: glob metacharacter rejection
  test("rejects id with '*'", () => {
    const r = validateAceId("a*b", "ID");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("VALIDATION");
  });

  test("rejects id with '?'", () => {
    const r = validateAceId("a?b", "ID");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("VALIDATION");
  });

  test("rejects id with '['", () => {
    const r = validateAceId("a[b", "ID");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("VALIDATION");
  });

  test("rejects id with ']'", () => {
    const r = validateAceId("a]b", "ID");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("VALIDATION");
  });

  test("accepts id with hyphen and dot (non-glob ASCII)", () => {
    expect(validateAceId("session-2026.05.03", "ID").ok).toBe(true);
  });
});

describe("encodeAceId / decodeAceId round-trip", () => {
  test("plain id is unchanged", () => {
    expect(encodeAceId("hello")).toBe("hello");
    expect(decodeAceId("hello")).toBe("hello");
  });

  test("colon is encoded and decoded", () => {
    expect(encodeAceId("a:b")).toBe("a_3Ab");
    expect(decodeAceId("a_3Ab")).toBe("a:b");
  });

  test("underscore is encoded and decoded", () => {
    expect(encodeAceId("a_b")).toBe("a_5Fb");
    expect(decodeAceId("a_5Fb")).toBe("a_b");
  });

  test("a:b and a_b encode to distinct filenames", () => {
    expect(encodeAceId("a:b")).not.toBe(encodeAceId("a_b"));
  });

  test("full round-trip: encode then decode returns original", () => {
    const ids = ["session:2026-05-03:abc", "a_b:c_d", "plain", "multi::colon"];
    for (const id of ids) {
      expect(decodeAceId(encodeAceId(id))).toBe(id);
    }
  });
});

// --- Fix 4: empty content is INTERNAL error, not absent ---

describe("readJson — empty content is INTERNAL error (Fix 4)", () => {
  test("readJson on missing file returns ok:true with undefined (NOT_FOUND regression)", async () => {
    const transport = createFakeNexusTransport();
    const r = await readJson<unknown>(transport, "/ace/proposals/truly-missing.json");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBeUndefined();
  });

  test("readJson when transport returns empty content returns ok:false INTERNAL", async () => {
    // Write empty content to simulate a zero-byte / corrupt file.
    const transport = createFakeNexusTransport();
    const wr = await transport.call<unknown>("write", {
      path: "/ace/proposals/empty.json",
      content: "",
    });
    expect(wr.ok).toBe(true);
    const r = await readJson<unknown>(transport, "/ace/proposals/empty.json");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("INTERNAL");
      expect(r.error.message).toContain("empty");
    }
  });
});

describe("readJson — EXTERNAL propagation (Finding 2)", () => {
  test("NOT_FOUND returns ok:true with undefined value", async () => {
    const transport = createFakeNexusTransport();
    const r = await readJson<unknown>(transport, "/ace/playbooks/missing.json");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBeUndefined();
  });

  test("EXTERNAL (-32601) propagates as ok:false — not masked as absent", async () => {
    const transport = createFakeNexusTransport({
      failMethod: "read",
      failCode: -32601,
      failMessage: "boom",
    });
    const r = await readJson<unknown>(transport, "/ace/playbooks/any.json");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("EXTERNAL");
  });
});

describe("exists — EXTERNAL propagation (Finding 2)", () => {
  test("NOT_FOUND returns ok:true with value false", async () => {
    const transport = createFakeNexusTransport();
    const r = await exists(transport, "/ace/playbooks/missing.json");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe(false);
  });

  test("exists returns true after write", async () => {
    const transport = createFakeNexusTransport();
    await writeJson(transport, "/ace/playbooks/x.json", { v: 1 });
    const r = await exists(transport, "/ace/playbooks/x.json");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe(true);
  });

  test("EXTERNAL propagates as ok:false", async () => {
    const transport = createFakeNexusTransport({
      failMethod: "read",
      failCode: -32601,
      failMessage: "boom",
    });
    const r = await exists(transport, "/ace/playbooks/any.json");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("EXTERNAL");
  });
});

describe("deleteJson — EXTERNAL propagation (Finding 2)", () => {
  test("NOT_FOUND returns ok:true with value false", async () => {
    const transport = createFakeNexusTransport();
    const r = await deleteJson(transport, "/ace/playbooks/missing.json");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe(false);
  });

  test("EXTERNAL propagates as ok:false", async () => {
    const transport = createFakeNexusTransport({
      failMethod: "delete",
      failCode: -32601,
      failMessage: "boom",
    });
    const r = await deleteJson(transport, "/ace/playbooks/any.json");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("EXTERNAL");
  });
});
