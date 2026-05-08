import { describe, expect, test } from "bun:test";

describe("@koi/scratchpad-nexus API surface", () => {
  test("exports createNexusScratchpad", async () => {
    const mod = await import("../index.js");
    expect(typeof mod.createNexusScratchpad).toBe("function");
  });
});
