import { describe, expect, test } from "bun:test";

describe("@koi/core", () => {
  test("exports KoiAgent type", async () => {
    const mod = await import("../index.js");
    expect(mod).toBeDefined();
  });
});
