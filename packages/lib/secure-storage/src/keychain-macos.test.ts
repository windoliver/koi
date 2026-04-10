import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { createMacOsKeychainStorage } from "./keychain-macos.js";

// Skip on non-macOS — keychain is platform-specific
const IS_MACOS = platform() === "darwin";
const describeIf = IS_MACOS ? describe : describe.skip;

describeIf("createMacOsKeychainStorage", () => {
  let lockDir: string;
  const TEST_KEY = `koi-test-${Date.now()}`;

  beforeEach(async () => {
    lockDir = await mkdtemp(join(tmpdir(), "koi-keychain-test-"));
  });

  afterEach(async () => {
    // Clean up test keychain entry
    const storage = createMacOsKeychainStorage(lockDir);
    await storage.delete(TEST_KEY);
    await rm(lockDir, { recursive: true, force: true });
  });

  test("get returns undefined for non-existent key", async () => {
    const storage = createMacOsKeychainStorage(lockDir);
    const result = await storage.get("nonexistent-key-12345");
    expect(result).toBeUndefined();
  });

  test("set then get returns stored value", async () => {
    const storage = createMacOsKeychainStorage(lockDir);
    await storage.set(TEST_KEY, "test-token-value");
    const result = await storage.get(TEST_KEY);
    expect(result).toBe("test-token-value");
  });

  test("set overwrites existing value", async () => {
    const storage = createMacOsKeychainStorage(lockDir);
    await storage.set(TEST_KEY, "first");
    await storage.set(TEST_KEY, "second");
    const result = await storage.get(TEST_KEY);
    expect(result).toBe("second");
  });

  test("delete removes stored value", async () => {
    const storage = createMacOsKeychainStorage(lockDir);
    await storage.set(TEST_KEY, "to-delete");
    const deleted = await storage.delete(TEST_KEY);
    expect(deleted).toBe(true);
    const result = await storage.get(TEST_KEY);
    expect(result).toBeUndefined();
  });

  test("delete returns false for non-existent key", async () => {
    const storage = createMacOsKeychainStorage(lockDir);
    const deleted = await storage.delete("nonexistent-key-12345");
    expect(deleted).toBe(false);
  });

  test("withLock serializes access", async () => {
    const storage = createMacOsKeychainStorage(lockDir);
    const order: number[] = [];

    const p1 = storage.withLock("lock-test", async () => {
      order.push(1);
      await Bun.sleep(30);
      order.push(2);
    });

    await Bun.sleep(5);

    const p2 = storage.withLock("lock-test", async () => {
      order.push(3);
    });

    await Promise.all([p1, p2]);
    expect(order).toEqual([1, 2, 3]);
  });
});
