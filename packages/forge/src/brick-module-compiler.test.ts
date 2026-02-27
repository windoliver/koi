/**
 * Brick module compiler tests — TDD for content-addressed module pipeline.
 *
 * Validates that brick source is compiled (written as .ts) to content-addressed
 * paths and can be dynamically imported by the promoted executor.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupOrphanedModules, compileBrickModule } from "./brick-module-compiler.js";

const TEST_CACHE_DIR = join(tmpdir(), "koi-brick-module-test");

afterEach(async () => {
  // Clean up test cache directory after each test
  await rm(TEST_CACHE_DIR, { recursive: true, force: true }).catch(() => {});
});

describe("compileBrickModule", () => {
  test("writes brick source to content-addressed .ts file", async () => {
    const implementation = "export default function(input) { return input.x + 1; }";

    const result = await compileBrickModule(implementation, TEST_CACHE_DIR);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.modulePath).toContain(TEST_CACHE_DIR);
      expect(result.value.modulePath).toMatch(/\.ts$/);
      const file = Bun.file(result.value.modulePath);
      expect(await file.exists()).toBe(true);
      expect(await file.text()).toBe(implementation);
    }
  });

  test("same brick content produces same hash and file path", async () => {
    const implementation = "export default function(input) { return 42; }";

    const result1 = await compileBrickModule(implementation, TEST_CACHE_DIR);
    const result2 = await compileBrickModule(implementation, TEST_CACHE_DIR);

    expect(result1.ok).toBe(true);
    expect(result2.ok).toBe(true);
    if (result1.ok && result2.ok) {
      expect(result1.value.modulePath).toBe(result2.value.modulePath);
      expect(result1.value.hash).toBe(result2.value.hash);
      // Second call should be a cache hit (file already existed)
      expect(result2.value.cached).toBe(true);
    }
  });

  test("different brick content produces different hash and file path", async () => {
    const impl1 = "export default function(input) { return 1; }";
    const impl2 = "export default function(input) { return 2; }";

    const result1 = await compileBrickModule(impl1, TEST_CACHE_DIR);
    const result2 = await compileBrickModule(impl2, TEST_CACHE_DIR);

    expect(result1.ok).toBe(true);
    expect(result2.ok).toBe(true);
    if (result1.ok && result2.ok) {
      expect(result1.value.modulePath).not.toBe(result2.value.modulePath);
      expect(result1.value.hash).not.toBe(result2.value.hash);
    }
  });

  test("returns module path that can be dynamically imported", async () => {
    const implementation = "export default function(input: unknown) { return 42; }";

    const result = await compileBrickModule(implementation, TEST_CACHE_DIR);

    expect(result.ok).toBe(true);
    if (result.ok) {
      const mod = await import(result.value.modulePath);
      expect(typeof mod.default).toBe("function");
      expect(mod.default({})).toBe(42);
    }
  });

  test("imported module exports default function that receives input", async () => {
    const implementation = `
export default function(input: { readonly x: number; readonly y: number }) {
  return input.x * input.y;
}
`;

    const result = await compileBrickModule(implementation, TEST_CACHE_DIR);

    expect(result.ok).toBe(true);
    if (result.ok) {
      const mod = await import(result.value.modulePath);
      expect(mod.default({ x: 6, y: 7 })).toBe(42);
    }
  });

  test("re-compile after content change produces new module path", async () => {
    const impl1 = 'export default function() { return "v1"; }';
    const impl2 = 'export default function() { return "v2"; }';

    const result1 = await compileBrickModule(impl1, TEST_CACHE_DIR);
    const result2 = await compileBrickModule(impl2, TEST_CACHE_DIR);

    expect(result1.ok).toBe(true);
    expect(result2.ok).toBe(true);
    if (result1.ok && result2.ok) {
      // Different content → different path → import() gets fresh module
      expect(result1.value.modulePath).not.toBe(result2.value.modulePath);
      const mod1 = await import(result1.value.modulePath);
      const mod2 = await import(result2.value.modulePath);
      expect(mod1.default()).toBe("v1");
      expect(mod2.default()).toBe("v2");
    }
  });

  test("returns error for empty implementation", async () => {
    const result = await compileBrickModule("", TEST_CACHE_DIR);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("empty");
    }
  });

  test("first compile is not cached, second is cached", async () => {
    const implementation = 'export default function() { return "test"; }';

    const result1 = await compileBrickModule(implementation, TEST_CACHE_DIR);
    expect(result1.ok).toBe(true);
    if (result1.ok) {
      expect(result1.value.cached).toBe(false);
    }

    const result2 = await compileBrickModule(implementation, TEST_CACHE_DIR);
    expect(result2.ok).toBe(true);
    if (result2.ok) {
      expect(result2.value.cached).toBe(true);
    }
  });
});

describe("cleanupOrphanedModules", () => {
  test("removes module files not in active set", async () => {
    const impl1 = 'export default function() { return "keep"; }';
    const impl2 = 'export default function() { return "remove"; }';

    const result1 = await compileBrickModule(impl1, TEST_CACHE_DIR);
    const result2 = await compileBrickModule(impl2, TEST_CACHE_DIR);
    expect(result1.ok).toBe(true);
    expect(result2.ok).toBe(true);

    if (result1.ok && result2.ok) {
      // Only keep result1's hash as active
      const removed = await cleanupOrphanedModules(new Set([result1.value.hash]), TEST_CACHE_DIR);

      expect(removed).toBe(1);
      expect(await Bun.file(result1.value.modulePath).exists()).toBe(true);
      expect(await Bun.file(result2.value.modulePath).exists()).toBe(false);
    }
  });

  test("returns 0 when all modules are active", async () => {
    const impl = 'export default function() { return "active"; }';
    const result = await compileBrickModule(impl, TEST_CACHE_DIR);
    expect(result.ok).toBe(true);

    if (result.ok) {
      const removed = await cleanupOrphanedModules(new Set([result.value.hash]), TEST_CACHE_DIR);
      expect(removed).toBe(0);
    }
  });

  test("handles empty cache directory gracefully", async () => {
    const removed = await cleanupOrphanedModules(new Set(), TEST_CACHE_DIR);
    expect(removed).toBe(0);
  });
});
