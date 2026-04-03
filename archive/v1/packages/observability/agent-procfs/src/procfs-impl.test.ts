/**
 * Tests for ProcFs implementation — mount/unmount, caching, and listing.
 */

import { describe, expect, test } from "bun:test";
import type { ProcEntry, WritableProcEntry } from "@koi/core";
import { createProcFs } from "./procfs-impl.js";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createProcFs", () => {
  test("mount and read a simple entry", async () => {
    const procFs = createProcFs();
    const entry: ProcEntry = { read: () => 42 };
    procFs.mount("/test", entry);

    const value = await procFs.read("/test");
    expect(value).toBe(42);
  });

  test("read returns undefined for unmounted path", async () => {
    const procFs = createProcFs();
    const value = await procFs.read("/nonexistent");
    expect(value).toBeUndefined();
  });

  test("unmount removes entry", async () => {
    const procFs = createProcFs();
    procFs.mount("/test", { read: () => "hello" });
    procFs.unmount("/test");

    const value = await procFs.read("/test");
    expect(value).toBeUndefined();
  });

  test("entries() returns all mounted paths", () => {
    const procFs = createProcFs();
    procFs.mount("/a", { read: () => 1 });
    procFs.mount("/b", { read: () => 2 });

    const paths = procFs.entries();
    expect(paths).toContain("/a");
    expect(paths).toContain("/b");
    expect(paths.length).toBe(2);
  });

  test("list() returns child path segments", async () => {
    const procFs = createProcFs();
    procFs.mount("/agents/a1/status", { read: () => "ok" });
    procFs.mount("/agents/a1/tools", { read: () => [] });
    procFs.mount("/agents/a2/status", { read: () => "ok" });

    const children = await procFs.list("/agents");
    expect(children).toContain("a1");
    expect(children).toContain("a2");
    expect(children.length).toBe(2);
  });

  test("list() with trailing slash works", async () => {
    const procFs = createProcFs();
    procFs.mount("/agents/a1/status", { read: () => "ok" });

    const children = await procFs.list("/agents/");
    expect(children).toContain("a1");
  });

  test("write to writable entry succeeds", async () => {
    let written: unknown;
    const procFs = createProcFs();
    const entry: WritableProcEntry = {
      read: () => 0,
      write: (v: unknown) => {
        written = v;
      },
    };
    procFs.mount("/test", entry);

    await procFs.write("/test", 99);
    expect(written).toBe(99);
  });

  test("write to read-only entry throws", async () => {
    const procFs = createProcFs();
    procFs.mount("/readonly", { read: () => 0 });

    await expect(procFs.write("/readonly", 1)).rejects.toThrow("read-only");
  });

  test("write to nonexistent path throws", async () => {
    const procFs = createProcFs();
    await expect(procFs.write("/missing", 1)).rejects.toThrow("not found");
  });

  test("TTL cache returns cached value within TTL", async () => {
    let callCount = 0;
    const procFs = createProcFs({ cacheTtlMs: 5000 });
    procFs.mount("/counter", {
      read: () => {
        callCount++;
        return callCount;
      },
    });

    const v1 = await procFs.read("/counter");
    const v2 = await procFs.read("/counter");
    expect(v1).toBe(1);
    expect(v2).toBe(1); // cached
    expect(callCount).toBe(1);
  });

  test("write invalidates cache", async () => {
    let callCount = 0;
    const procFs = createProcFs({ cacheTtlMs: 5000 });
    const entry: WritableProcEntry = {
      read: () => {
        callCount++;
        return callCount;
      },
      write: () => {},
    };
    procFs.mount("/counter", entry);

    await procFs.read("/counter"); // callCount = 1, cached
    await procFs.write("/counter", "anything");
    const v2 = await procFs.read("/counter"); // cache invalidated, callCount = 2
    expect(v2).toBe(2);
  });

  test("mount replaces existing entry and invalidates cache", async () => {
    const procFs = createProcFs({ cacheTtlMs: 5000 });
    procFs.mount("/test", { read: () => "old" });
    await procFs.read("/test"); // cache "old"

    procFs.mount("/test", { read: () => "new" });
    const value = await procFs.read("/test");
    expect(value).toBe("new");
  });

  test("list with entry.list() delegates to entry", async () => {
    const procFs = createProcFs();
    procFs.mount("/custom", {
      read: () => null,
      list: () => ["x", "y", "z"],
    });

    const children = await procFs.list("/custom");
    expect(children).toEqual(["x", "y", "z"]);
  });
});
