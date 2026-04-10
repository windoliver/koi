import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { watchConfigFile } from "./watcher.js";

describe("watchConfigFile", () => {
  let tempDir: string;
  let configPath: string;
  let cleanup: (() => void) | undefined;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "koi-config-test-"));
    configPath = join(tempDir, "test.yaml");
    writeFileSync(configPath, "logLevel: info\n");
  });

  afterEach(() => {
    cleanup?.();
    cleanup = undefined;
  });

  test("calls onChange when file changes", async () => {
    let called = false;
    cleanup = watchConfigFile({
      filePath: configPath,
      onChange: () => {
        called = true;
      },
      debounceMs: 50,
    });
    // Trigger a file change
    writeFileSync(configPath, "logLevel: debug\n");
    // Wait for debounce
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(called).toBe(true);
  });

  test("unsubscribe stops watching", async () => {
    let callCount = 0;
    const unsub = watchConfigFile({
      filePath: configPath,
      onChange: () => {
        callCount++;
      },
      debounceMs: 50,
    });
    cleanup = undefined; // We manage cleanup manually
    unsub();
    writeFileSync(configPath, "logLevel: debug\n");
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(callCount).toBe(0);
  });

  test("debounces rapid writes", async () => {
    let callCount = 0;
    cleanup = watchConfigFile({
      filePath: configPath,
      onChange: () => {
        callCount++;
      },
      debounceMs: 100,
    });
    // Rapid writes
    writeFileSync(configPath, "logLevel: debug\n");
    writeFileSync(configPath, "logLevel: warn\n");
    writeFileSync(configPath, "logLevel: error\n");
    // Wait for debounce to settle
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(callCount).toBe(1);
  });

  test("dispose while a debounced change is pending clears the timer", async () => {
    let callCount = 0;
    const unsub = watchConfigFile({
      filePath: configPath,
      onChange: () => {
        callCount++;
      },
      debounceMs: 200,
    });
    cleanup = undefined;
    writeFileSync(configPath, "logLevel: debug\n");
    // Dispose BEFORE debounce fires.
    unsub();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(callCount).toBe(0);
  });

  test("rename-on-save: atomic tmp+rename triggers onChange and re-arms", async () => {
    let callCount = 0;
    cleanup = watchConfigFile({
      filePath: configPath,
      onChange: () => {
        callCount++;
      },
      debounceMs: 30,
    });
    // First rename-on-save cycle
    const tmp = `${configPath}.tmp`;
    writeFileSync(tmp, "logLevel: debug\n");
    renameSync(tmp, configPath);
    await new Promise((r) => setTimeout(r, 300));
    expect(callCount).toBeGreaterThanOrEqual(1);

    // A subsequent plain write should still trigger the re-armed watcher.
    writeFileSync(configPath, "logLevel: warn\n");
    await new Promise((r) => setTimeout(r, 200));
    expect(callCount).toBeGreaterThanOrEqual(2);
  });

  test("rearm gives up and calls onError when file disappears permanently", async () => {
    let errorSeen = false;
    cleanup = watchConfigFile({
      filePath: configPath,
      onChange: () => {},
      debounceMs: 30,
      onError: () => {
        errorSeen = true;
      },
    });
    // Delete the file outright — the watcher will fire `rename`, try to rearm,
    // and give up after retries.
    unlinkSync(configPath);
    // Wait longer than the sum of REARM_DELAYS_MS (50+100+200 = 350ms).
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(errorSeen).toBe(true);
  });
});
