import { describe, expect, test } from "bun:test";
import { createFakeNexusTransport } from "@koi/fs-nexus/testing";
import { deleteJson, exists, listChildren, readJson, writeJson } from "./json-io.js";

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
});
