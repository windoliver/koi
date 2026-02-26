import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createStaticServe } from "./static-serve.js";

const TEST_DIR = resolve(import.meta.dir, "../.test-assets");

beforeAll(() => {
  mkdirSync(TEST_DIR, { recursive: true });
  writeFileSync(resolve(TEST_DIR, "index.html"), "<html></html>");
  writeFileSync(resolve(TEST_DIR, "app-a1b2c3d4.js"), "console.log('hello')");
  writeFileSync(resolve(TEST_DIR, "style.css"), "body { color: red }");
});

afterAll(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("createStaticServe", () => {
  test("serves existing file with correct content-type", async () => {
    const { serve } = createStaticServe(TEST_DIR);
    const response = await serve("/index.html");
    expect(response).not.toBeNull();
    expect(response?.headers.get("content-type")).toBe("text/html; charset=utf-8");
    const text = await response?.text();
    expect(text).toBe("<html></html>");
  });

  test("serves CSS file", async () => {
    const { serve } = createStaticServe(TEST_DIR);
    const response = await serve("/style.css");
    expect(response).not.toBeNull();
    expect(response?.headers.get("content-type")).toBe("text/css; charset=utf-8");
  });

  test("content-hashed files get immutable cache headers", async () => {
    const { serve } = createStaticServe(TEST_DIR);
    const response = await serve("/app-a1b2c3d4.js");
    expect(response).not.toBeNull();
    expect(response?.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
  });

  test("non-hashed files get no-cache headers", async () => {
    const { serve } = createStaticServe(TEST_DIR);
    const response = await serve("/index.html");
    expect(response?.headers.get("cache-control")).toBe("no-cache");
  });

  test("returns null for missing files", async () => {
    const { serve } = createStaticServe(TEST_DIR);
    const response = await serve("/missing.js");
    expect(response).toBeNull();
  });

  test("rejects path traversal attempts", async () => {
    const { serve } = createStaticServe(TEST_DIR);
    const response = await serve("/../../../etc/passwd");
    expect(response).toBeNull();
  });
});
