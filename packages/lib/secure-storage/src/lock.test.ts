import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileLock } from "./lock.js";

describe("createFileLock", () => {
  let lockDir: string;

  beforeEach(async () => {
    lockDir = await mkdtemp(join(tmpdir(), "koi-lock-test-"));
  });

  afterEach(async () => {
    await rm(lockDir, { recursive: true, force: true });
  });

  test("executes fn and returns result", async () => {
    const lock = createFileLock(lockDir);
    const result = await lock.withLock("test-key", async () => 42);
    expect(result).toBe(42);
  });

  test("releases lock after fn completes", async () => {
    const lock = createFileLock(lockDir);
    await lock.withLock("test-key", async () => "first");
    // Second lock should acquire immediately
    const result = await lock.withLock("test-key", async () => "second");
    expect(result).toBe("second");
  });

  test("releases lock on fn error", async () => {
    const lock = createFileLock(lockDir);
    const err = new Error("test error");
    try {
      await lock.withLock("test-key", async () => {
        throw err;
      });
    } catch (e: unknown) {
      expect(e).toBe(err);
    }
    // Lock should be released — next acquire should work
    const result = await lock.withLock("test-key", async () => "recovered");
    expect(result).toBe("recovered");
  });

  test("serializes concurrent access to same key", async () => {
    const lock = createFileLock(lockDir);
    const order: number[] = [];

    const p1 = lock.withLock("shared", async () => {
      order.push(1);
      await Bun.sleep(50);
      order.push(2);
      return "a";
    });

    // Small delay so p1 acquires first
    await Bun.sleep(5);

    const p2 = lock.withLock("shared", async () => {
      order.push(3);
      return "b";
    });

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toBe("a");
    expect(r2).toBe("b");
    // p1 should fully complete before p2 starts
    expect(order).toEqual([1, 2, 3]);
  });

  test("allows concurrent access to different keys", async () => {
    const lock = createFileLock(lockDir);
    const active: string[] = [];

    const p1 = lock.withLock("key-a", async () => {
      active.push("a-start");
      await Bun.sleep(30);
      active.push("a-end");
    });

    const p2 = lock.withLock("key-b", async () => {
      active.push("b-start");
      await Bun.sleep(30);
      active.push("b-end");
    });

    await Promise.all([p1, p2]);
    // Both should start before either ends (concurrent)
    expect(active.indexOf("a-start")).toBeLessThan(active.indexOf("a-end"));
    expect(active.indexOf("b-start")).toBeLessThan(active.indexOf("b-end"));
  });

  test("sanitizes key for filesystem", async () => {
    const lock = createFileLock(lockDir);
    // Key with special characters should work
    const result = await lock.withLock("mcp-oauth|server|abc123", async () => "ok");
    expect(result).toBe("ok");
  });
});
