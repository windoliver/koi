import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const DIST_DIR = resolve(import.meta.dir, "../../dist");
const distExists = existsSync(DIST_DIR);

describe.skipIf(!distExists)("build output", () => {
  test("dist/index.d.ts exists", async () => {
    const file = Bun.file(resolve(DIST_DIR, "index.d.ts"));
    expect(await file.exists()).toBe(true);
  });

  test("dist/index.js exists", async () => {
    const file = Bun.file(resolve(DIST_DIR, "index.js"));
    expect(await file.exists()).toBe(true);
  });

  test("per-contract entry files exist", async () => {
    const entries = [
      "assembly",
      "channel",
      "ecs",
      "engine",
      "errors",
      "message",
      "middleware",
      "resolver",
    ];
    for (const entry of entries) {
      const js = Bun.file(resolve(DIST_DIR, `${entry}.js`));
      const dts = Bun.file(resolve(DIST_DIR, `${entry}.d.ts`));
      expect(await js.exists()).toBe(true);
      expect(await dts.exists()).toBe(true);
    }
  });

  test("index bundle is under 21KB", async () => {
    const file = Bun.file(resolve(DIST_DIR, "index.js"));
    const size = file.size;
    expect(size).toBeLessThan(21504);
  });
});
