import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
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
});
