import { describe, expect, test } from "bun:test";

describe("@koi/ipc-nexus API surface", () => {
  test("exports createNexusMailbox", async () => {
    const mod = await import("../index.js");
    expect(typeof mod.createNexusMailbox).toBe("function");
  });
});
