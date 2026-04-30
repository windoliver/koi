import { describe, expect, test } from "bun:test";
import type { ProcEntry, WritableProcEntry } from "@koi/core";
import { createProcFs } from "./procfs-impl.js";

describe("createProcFs", () => {
  test("mount and read returns entry value", async () => {
    const procFs = createProcFs();
    const entry: ProcEntry = { read: () => 42 };
    procFs.mount("/a", entry);
    expect(await procFs.read("/a")).toBe(42);
  });

  test("read missing path throws", async () => {
    const procFs = createProcFs();
    await expect(procFs.read("/missing")).rejects.toThrow(/NOT_FOUND|not found/i);
  });

  test("TTL cache returns cached value within TTL", async () => {
    let calls = 0;
    const entry: ProcEntry = { read: () => ++calls };
    const procFs = createProcFs({ cacheTtlMs: 1000 });
    procFs.mount("/c", entry);
    expect(await procFs.read("/c")).toBe(1);
    expect(await procFs.read("/c")).toBe(1);
    expect(calls).toBe(1);
  });

  test("TTL=0 disables cache", async () => {
    let calls = 0;
    const entry: ProcEntry = { read: () => ++calls };
    const procFs = createProcFs({ cacheTtlMs: 0 });
    procFs.mount("/c", entry);
    await procFs.read("/c");
    await procFs.read("/c");
    expect(calls).toBe(2);
  });

  test("write invalidates cache and calls entry.write", async () => {
    let val = 1;
    const entry: WritableProcEntry = {
      read: () => val,
      write: (v) => {
        if (typeof v === "number") val = v;
      },
    };
    const procFs = createProcFs({ cacheTtlMs: 10_000 });
    procFs.mount("/m", entry);
    expect(await procFs.read("/m")).toBe(1);
    await procFs.write("/m", 99);
    expect(await procFs.read("/m")).toBe(99);
  });

  test("write to read-only entry throws", async () => {
    const procFs = createProcFs();
    procFs.mount("/r", { read: () => 1 });
    await expect(procFs.write("/r", 2)).rejects.toThrow(/not writable|read.?only/i);
  });

  test("mount replaces existing entry and invalidates cache", async () => {
    const procFs = createProcFs({ cacheTtlMs: 10_000 });
    procFs.mount("/p", { read: () => "old" });
    await procFs.read("/p");
    procFs.mount("/p", { read: () => "new" });
    expect(await procFs.read("/p")).toBe("new");
  });

  test("unmount removes entry", async () => {
    const procFs = createProcFs();
    procFs.mount("/u", { read: () => 1 });
    procFs.unmount("/u");
    await expect(procFs.read("/u")).rejects.toThrow();
  });

  test("list returns child segments under a path prefix", async () => {
    const procFs = createProcFs();
    procFs.mount("/agents/a/status", { read: () => "ok" });
    procFs.mount("/agents/a/tools", { read: () => [] });
    procFs.mount("/agents/b/status", { read: () => "ok" });
    const children = await procFs.list("/agents");
    expect([...children].sort()).toEqual(["a", "b"]);
  });

  test("entries returns all mounted paths", () => {
    const procFs = createProcFs();
    procFs.mount("/x", { read: () => 0 });
    procFs.mount("/y", { read: () => 0 });
    expect([...procFs.entries()].sort()).toEqual(["/x", "/y"]);
  });

  test("entry-provided list() takes precedence", async () => {
    const procFs = createProcFs();
    procFs.mount("/dyn", {
      read: () => null,
      list: () => ["k1", "k2"],
    });
    expect([...(await procFs.list("/dyn"))].sort()).toEqual(["k1", "k2"]);
  });

  test("async read is awaited", async () => {
    const procFs = createProcFs();
    procFs.mount("/async", { read: async () => "deferred" });
    expect(await procFs.read("/async")).toBe("deferred");
  });

  test("cache expires after TTL elapses", async () => {
    let calls = 0;
    const entry: ProcEntry = { read: () => ++calls };
    const procFs = createProcFs({ cacheTtlMs: 20 });
    procFs.mount("/t", entry);
    await procFs.read("/t");
    await Bun.sleep(40);
    await procFs.read("/t");
    expect(calls).toBe(2);
  });
});
