import { describe, expect, test } from "bun:test";
import { createNexusStack } from "./nexus-stack.js";

describe("createNexusStack", () => {
  test("returns a composed bundle using only supported live workspace surfaces", async () => {
    const bundle = await createNexusStack({
      transport: { call: async () => ({ ok: true, value: {} }) } as never,
      enableScratchpad: true,
      enableWorkspace: false,
      global: { registry: true, permissions: true, audit: false, search: true, scheduler: true },
    });

    expect(bundle.backends.registry).toBeDefined();
    expect(bundle.backends.permissions).toBeDefined();
    expect(bundle.backends.audit).toBeUndefined();
    expect(bundle.providers).toHaveLength(1);
    expect(bundle.config.workspaceEnabled).toBe(false);
    await expect(bundle.dispose()).resolves.toBeUndefined();
  });
});
