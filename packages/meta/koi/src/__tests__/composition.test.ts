/**
 * Composition tests — verify key exports exist from each subpath.
 *
 * These tests import from the source modules (not dist) to verify
 * that the re-exports resolve correctly during development.
 */

import { describe, expect, test } from "bun:test";

describe("root export", () => {
  test("exports createKoi from @koi/engine", async () => {
    const mod = await import("../index.js");
    expect(typeof mod.createKoi).toBe("function");
  });

  test("exports createConfiguredKoi from @koi/starter", async () => {
    const mod = await import("../index.js");
    expect(typeof mod.createConfiguredKoi).toBe("function");
  });

  test("exports loadManifest from @koi/manifest", async () => {
    const mod = await import("../index.js");
    expect(typeof mod.loadManifest).toBe("function");
  });

  test("exports getEngineName from @koi/manifest", async () => {
    const mod = await import("../index.js");
    expect(typeof mod.getEngineName).toBe("function");
  });

  test("exports createPiAdapter from @koi/engine-pi", async () => {
    const mod = await import("../index.js");
    expect(typeof mod.createPiAdapter).toBe("function");
  });
});

describe("L3 subpath re-exports", () => {
  test("koi/channels re-exports @koi/channels", async () => {
    const mod = await import("../channels/index.js");
    expect(typeof mod.createDefaultChannelRegistry).toBe("function");
  });

  test("koi/sandbox re-exports @koi/sandbox-stack", async () => {
    const mod = await import("../sandbox/index.js");
    expect(typeof mod.createSandboxStack).toBe("function");
  });

  test("koi/governance re-exports @koi/governance", async () => {
    const mod = await import("../governance/index.js");
    expect(mod).toBeDefined();
  });
});
