import { describe, expect, test } from "bun:test";

describe("@koi/workspace-nexus API surface", () => {
  test("exports createNexusWorkspaceBackend", async () => {
    const mod = await import("../index.js");
    expect(typeof mod.createNexusWorkspaceBackend).toBe("function");
  });
});
