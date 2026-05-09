import { describe, expect, test } from "bun:test";

describe("@koi/nexus API surface", () => {
  test("exports createNexusStack and namespace helpers", async () => {
    const mod = await import("../index.js");
    expect(typeof mod.createNexusStack).toBe("function");
    expect(typeof mod.computeAgentNamespace).toBe("function");
    expect(typeof mod.computeGroupNamespace).toBe("function");
  });
});
