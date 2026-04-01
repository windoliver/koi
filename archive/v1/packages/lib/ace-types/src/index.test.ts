import { describe, expect, test } from "bun:test";

describe("@koi/ace-types", () => {
  test("exports core types", async () => {
    const mod = await import("./index.js");
    expect(typeof mod).toBe("object");
  });
});
