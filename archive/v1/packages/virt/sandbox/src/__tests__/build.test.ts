import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

const DIST_DIR = resolve(import.meta.dir, "../../dist");

describe("build output", () => {
  test("dist/index.d.ts exists", async () => {
    const file = Bun.file(resolve(DIST_DIR, "index.d.ts"));
    expect(await file.exists()).toBe(true);
  });

  test("dist/index.js exists", async () => {
    const file = Bun.file(resolve(DIST_DIR, "index.js"));
    expect(await file.exists()).toBe(true);
  });

  test("bundle is under 16KB", async () => {
    const file = Bun.file(resolve(DIST_DIR, "index.js"));
    const size = file.size;
    expect(size).toBeLessThan(16_384);
  });
});
