import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPromotedExecutor } from "./promoted-executor.js";

const TEST_MODULE_DIR = join(tmpdir(), "koi-promoted-executor-test");

afterEach(async () => {
  await rm(TEST_MODULE_DIR, { recursive: true, force: true }).catch(() => {});
});

describe("createPromotedExecutor", () => {
  const executor = createPromotedExecutor();

  test("returns sync value", async () => {
    const result = await executor.execute("return 42;", {}, 5_000);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.output).toBe(42);
      expect(result.value.durationMs).toBeGreaterThanOrEqual(0);
    }
  });

  test("returns async value", async () => {
    const result = await executor.execute("return Promise.resolve(42);", {}, 5_000);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.output).toBe(42);
    }
  });

  test("returns sync throw as CRASH", async () => {
    const result = await executor.execute('throw new Error("boom");', {}, 5_000);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("CRASH");
      expect(result.error.message).toBe("boom");
      expect(result.error.durationMs).toBeGreaterThanOrEqual(0);
    }
  });

  test("returns async throw as CRASH", async () => {
    const result = await executor.execute(
      'return Promise.reject(new Error("async boom"));',
      {},
      5_000,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("CRASH");
      expect(result.error.message).toBe("async boom");
    }
  });

  test("returns undefined output", async () => {
    const result = await executor.execute("return undefined;", {}, 5_000);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.output).toBeUndefined();
    }
  });

  test("passes input to function", async () => {
    const result = await executor.execute("return input.x + input.y;", { x: 3, y: 7 }, 5_000);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.output).toBe(10);
    }
  });

  test("classifies non-Error throw as CRASH", async () => {
    const result = await executor.execute('throw "string error";', {}, 5_000);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("CRASH");
      expect(result.error.message).toBe("string error");
    }
  });

  test("handles non-serializable return", async () => {
    const result = await executor.execute("return { fn: () => {} };", {}, 5_000);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.output).toBeDefined();
      expect(typeof (result.value.output as Record<string, unknown>).fn).toBe("function");
    }
  });

  test("caches compiled functions for same code", async () => {
    const code = "return input.val * 2;";
    const result1 = await executor.execute(code, { val: 5 }, 5_000);
    const result2 = await executor.execute(code, { val: 10 }, 5_000);

    expect(result1.ok).toBe(true);
    expect(result2.ok).toBe(true);
    if (result1.ok && result2.ok) {
      expect(result1.value.output).toBe(10);
      expect(result2.value.output).toBe(20);
    }
  });

  test("classifies Permission denied as PERMISSION", async () => {
    const result = await executor.execute('throw new Error("Permission denied");', {}, 5_000);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("PERMISSION");
    }
  });

  test("times out on long-running new Function code", async () => {
    // Async infinite loop that yields control to allow timeout to fire
    const code = `
      return new Promise((resolve) => {
        const start = Date.now();
        const spin = () => {
          if (Date.now() - start < 10000) setTimeout(spin, 10);
          else resolve("done");
        };
        spin();
      });
    `;
    const result = await executor.execute(code, {}, 50);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("TIMEOUT");
      expect(result.error.message).toContain("timed out");
      expect(result.error.durationMs).toBeGreaterThanOrEqual(0);
    }
  });

  test("classifies timeout error with TIMEOUT code", async () => {
    const code = "return new Promise(() => {});"; // Never resolves
    const result = await executor.execute(code, {}, 50);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("TIMEOUT");
    }
  });
});

describe("createPromotedExecutor — import() path", () => {
  const executor = createPromotedExecutor();

  async function writeModule(filename: string, source: string): Promise<string> {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(TEST_MODULE_DIR, { recursive: true });
    const path = join(TEST_MODULE_DIR, filename);
    await Bun.write(path, source);
    return path;
  }

  test("executes module with default export function", async () => {
    const entryPath = await writeModule(
      "add-one.ts",
      "export default function(input: { readonly x: number }) { return input.x + 1; }",
    );

    const result = await executor.execute("", { x: 5 }, 5_000, { entryPath });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.output).toBe(6);
      expect(result.value.durationMs).toBeGreaterThanOrEqual(0);
    }
  });

  test("caches imported module by path", async () => {
    const entryPath = await writeModule(
      "cached-mod.ts",
      "export default function() { return 99; }",
    );

    const result1 = await executor.execute("", {}, 5_000, { entryPath });
    const result2 = await executor.execute("", {}, 5_000, { entryPath });

    expect(result1.ok).toBe(true);
    expect(result2.ok).toBe(true);
    if (result1.ok && result2.ok) {
      expect(result1.value.output).toBe(99);
      expect(result2.value.output).toBe(99);
    }
  });

  test("different entry paths load different modules", async () => {
    const path1 = await writeModule("mod-a.ts", 'export default function() { return "a"; }');
    const path2 = await writeModule("mod-b.ts", 'export default function() { return "b"; }');

    const result1 = await executor.execute("", {}, 5_000, { entryPath: path1 });
    const result2 = await executor.execute("", {}, 5_000, { entryPath: path2 });

    expect(result1.ok).toBe(true);
    expect(result2.ok).toBe(true);
    if (result1.ok && result2.ok) {
      expect(result1.value.output).toBe("a");
      expect(result2.value.output).toBe("b");
    }
  });

  test("returns error when module has no default export", async () => {
    const entryPath = await writeModule(
      "no-default.ts",
      "export function notDefault() { return 1; }",
    );

    const result = await executor.execute("", {}, 5_000, { entryPath });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("CRASH");
      expect(result.error.message).toContain("must export a default function");
    }
  });

  test("times out on slow import-path execution", async () => {
    const entryPath = await writeModule(
      "slow-mod.ts",
      "export default function() { return new Promise(() => {}); }", // Never resolves
    );

    const result = await executor.execute("", {}, 50, { entryPath });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("TIMEOUT");
      expect(result.error.message).toContain("timed out");
    }
  });

  test("handles import failure for non-existent file", async () => {
    const result = await executor.execute("", {}, 5_000, {
      entryPath: join(TEST_MODULE_DIR, "nonexistent.ts"),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("CRASH");
    }
  });
});
