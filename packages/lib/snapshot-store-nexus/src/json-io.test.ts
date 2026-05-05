import { describe, expect, test } from "bun:test";
import type { KoiError, Result } from "@koi/core";
import { createFakeNexusTransport } from "@koi/fs-nexus/testing";
import type { NexusTransport } from "@koi/nexus-client";
import { deleteJson, exists, listChildren, readJson, writeJson } from "./json-io.js";

/** Build a transport that returns a truncated list response (`has_more: true`). */
function truncatedListTransport(files: readonly { path: string }[]): NexusTransport {
  return {
    call: async <T>(method: string): Promise<Result<T, KoiError>> => {
      if (method === "list") {
        return { ok: true, value: { files, has_more: true } as T };
      }
      return { ok: false, error: { code: "INTERNAL", message: "not supported", retryable: false } };
    },
    close: () => {},
  };
}

/** Build a minimal transport that returns a fixed value for every `read`. */
function fixedReadTransport(value: unknown): NexusTransport {
  return {
    call: async <T>(method: string): Promise<Result<T, KoiError>> => {
      if (method === "read") return { ok: true, value: value as T };
      return { ok: false, error: { code: "INTERNAL", message: "not supported", retryable: false } };
    },
    close: () => {},
  };
}

describe("json-io", () => {
  test("writeJson / readJson round-trip", async () => {
    const transport = createFakeNexusTransport();
    const w = await writeJson(transport, "/snapshots/x.json", { hello: "world" });
    expect(w.ok).toBe(true);

    const r = await readJson<{ hello: string }>(transport, "/snapshots/x.json");
    expect(r.ok).toBe(true);
    if (r.ok && r.value !== undefined) expect(r.value.hello).toBe("world");
  });

  test("readJson on missing path returns undefined value (not error)", async () => {
    const transport = createFakeNexusTransport();
    const r = await readJson<unknown>(transport, "/snapshots/missing.json");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBeUndefined();
  });

  test("exists returns false for missing", async () => {
    const transport = createFakeNexusTransport();
    const r = await exists(transport, "/snapshots/none.json");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe(false);
  });

  test("exists returns true after write", async () => {
    const transport = createFakeNexusTransport();
    await writeJson(transport, "/snapshots/y.json", { v: 1 });
    const r = await exists(transport, "/snapshots/y.json");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe(true);
  });

  test("deleteJson removes the file", async () => {
    const transport = createFakeNexusTransport();
    await writeJson(transport, "/snapshots/z.json", { v: 2 });
    const d = await deleteJson(transport, "/snapshots/z.json");
    expect(d.ok).toBe(true);
    const r = await readJson<unknown>(transport, "/snapshots/z.json");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBeUndefined();
  });

  test("listChildren glob lists matching files", async () => {
    const transport = createFakeNexusTransport();
    await writeJson(transport, "/snapshots/a.json", { i: 1 });
    await writeJson(transport, "/snapshots/b.json", { i: 2 });
    const r = await listChildren(transport, "/snapshots/*.json");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.length).toBe(2);
  });

  // --- Fix 4: empty content is INTERNAL error, not absent ---

  test("readJson on missing file returns ok:true with undefined (NOT_FOUND regression)", async () => {
    const transport = createFakeNexusTransport();
    const r = await readJson<unknown>(transport, "/snapshots/truly-missing.json");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBeUndefined();
  });

  test("readJson when transport returns empty content returns ok:false INTERNAL", async () => {
    // Write empty content to simulate a zero-byte / corrupt file.
    const transport = createFakeNexusTransport();
    // The fake transport stores content directly; write an empty string.
    const wr = await transport.call<unknown>("write", {
      path: "/snapshots/empty.json",
      content: "",
    });
    expect(wr.ok).toBe(true);
    const r = await readJson<unknown>(transport, "/snapshots/empty.json");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("INTERNAL");
      expect(r.error.message).toContain("empty");
    }
  });

  // --- EXTERNAL error propagation regression tests (Finding 2) ---

  test("readJson returns ok:false on EXTERNAL (-32601), not undefined", async () => {
    const transport = createFakeNexusTransport({
      failMethod: "read",
      failCode: -32601,
      failMessage: "boom",
    });
    const r = await readJson<unknown>(transport, "/snapshots/any.json");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("EXTERNAL");
  });

  test("exists returns ok:false on EXTERNAL", async () => {
    const transport = createFakeNexusTransport({
      failMethod: "read",
      failCode: -32601,
      failMessage: "boom",
    });
    const r = await exists(transport, "/snapshots/any.json");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("EXTERNAL");
  });

  test("deleteJson returns ok:false on EXTERNAL", async () => {
    const transport = createFakeNexusTransport({
      failMethod: "delete",
      failCode: -32601,
      failMessage: "boom",
    });
    // Write a file so the delete is attempted
    const write = createFakeNexusTransport();
    await writeJson(write, "/snapshots/x.json", { v: 1 });
    const r = await deleteJson(transport, "/snapshots/x.json");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("EXTERNAL");
  });

  // --- Fix 2 (round 6): strict extractReadContent rejects malformed bytes envelopes (#1405) ---

  test("readJson returns INTERNAL error for malformed base64 bytes envelope", async () => {
    // The old lenient decodeContent would silently drop bad chars; extractReadContent rejects.
    const transport = fixedReadTransport({ __type__: "bytes", data: "!!notbase64!!" });
    const r = await readJson<unknown>(transport, "/any.json");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("INTERNAL");
  });

  test("readJson returns INTERNAL error for invalid UTF-8 in bytes envelope", async () => {
    // 0xff 0xfe is not valid UTF-8 — strict TextDecoder with fatal:true rejects it.
    const invalidUtf8 = Buffer.from([0xff, 0xfe]).toString("base64");
    const transport = fixedReadTransport({ __type__: "bytes", data: invalidUtf8 });
    const r = await readJson<unknown>(transport, "/any.json");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("INTERNAL");
  });

  test("readJson happy path with valid bytes envelope still works", async () => {
    // Ensure the strict path passes valid well-formed base64+UTF-8.
    const validJson = JSON.stringify({ v: 42 });
    const encoded = Buffer.from(validJson, "utf-8").toString("base64");
    const transport = fixedReadTransport({ __type__: "bytes", data: encoded });
    const r = await readJson<{ v: number }>(transport, "/any.json");
    expect(r.ok).toBe(true);
    if (r.ok && r.value !== undefined) expect(r.value.v).toBe(42);
  });

  // --- Fix 10: listChildren fails closed on truncated Nexus list (#1405) ---

  test("listChildren returns INTERNAL when transport returns has_more: true", async () => {
    const transport = truncatedListTransport([
      { path: "/snapshots/a.json" },
      { path: "/snapshots/b.json" },
    ]);
    const r = await listChildren(transport, "/snapshots/*.json");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("INTERNAL");
      expect(r.error.message).toContain("truncated");
      expect(r.error.message).toContain("/snapshots/*.json");
    }
  });

  test("listChildren happy-path still returns matching files when has_more is absent", async () => {
    const transport = createFakeNexusTransport();
    await writeJson(transport, "/snapshots/a.json", { i: 1 });
    await writeJson(transport, "/snapshots/b.json", { i: 2 });
    const r = await listChildren(transport, "/snapshots/*.json");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.length).toBe(2);
  });
});
