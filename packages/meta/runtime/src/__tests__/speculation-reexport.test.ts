import { describe, expect, test } from "bun:test";

describe("runtime speculation exports", () => {
  test("re-exports speculation controller for host wiring", async () => {
    const runtime = (await import("../index.js")) as Record<string, unknown>;

    expect(typeof runtime.createSpeculationController).toBe("function");
  });
});
