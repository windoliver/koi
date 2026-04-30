import { describe, expect, test } from "bun:test";

import { resolveAceActivation } from "./ace-activation.js";
import type { ManifestAceConfig } from "./manifest.js";

const STUB_FACTORIES = {
  playbookStore: () =>
    ({
      get: async () => undefined,
      list: async () => [],
      save: async () => {},
      remove: async () => false,
    }) as const,
  trajectoryStore: () =>
    ({
      append: async () => {},
      getSession: async () => [],
      listSessions: async () => [],
    }) as const,
};

const ENABLED_BARE: ManifestAceConfig = {
  enabled: true,
  maxInjectedTokens: undefined,
  minScore: undefined,
  lambda: undefined,
};

describe("resolveAceActivation — issue #2088", () => {
  test("skips when manifest.ace is undefined", () => {
    const result = resolveAceActivation(undefined, ["observability"], STUB_FACTORIES);
    expect(result.kind).toBe("skip");
  });

  test("skips when ace.enabled is false", () => {
    const result = resolveAceActivation(
      { enabled: false, maxInjectedTokens: undefined, minScore: undefined, lambda: undefined },
      ["observability"],
      STUB_FACTORIES,
    );
    expect(result.kind).toBe("skip");
  });

  test("spawn-blocks when stacks is undefined (defaults include spawn)", () => {
    const result = resolveAceActivation(ENABLED_BARE, undefined, STUB_FACTORIES);
    expect(result.kind).toBe("spawn-blocked");
    if (result.kind === "spawn-blocked") {
      expect(result.message).toContain("refusing to activate");
      expect(result.message).toContain("spawn");
      expect(result.message).toContain("Continuing without ACE");
    }
  });

  test("spawn-blocks when stacks explicitly contains 'spawn'", () => {
    const result = resolveAceActivation(
      ENABLED_BARE,
      ["observability", "spawn", "execution"],
      STUB_FACTORIES,
    );
    expect(result.kind).toBe("spawn-blocked");
  });

  test("activates when stacks excludes spawn and ace.enabled is true", () => {
    const result = resolveAceActivation(
      ENABLED_BARE,
      ["observability", "checkpoint", "execution"],
      STUB_FACTORIES,
    );
    expect(result.kind).toBe("activate");
    if (result.kind === "activate") {
      expect(result.message).toContain("ace: enabled");
      expect(result.message).toContain("in-memory");
      expect(result.config.playbookStore).toBeDefined();
      expect(result.config.trajectoryStore).toBeDefined();
      // Optional fields omitted when manifest didn't provide them.
      expect(result.config.maxInjectedTokens).toBeUndefined();
      expect(result.config.minScore).toBeUndefined();
      expect(result.config.lambda).toBeUndefined();
    }
  });

  test("forwards optional overrides into AceConfig when present", () => {
    const result = resolveAceActivation(
      { enabled: true, maxInjectedTokens: 1200, minScore: 0.1, lambda: 0.07 },
      ["observability"],
      STUB_FACTORIES,
    );
    expect(result.kind).toBe("activate");
    if (result.kind === "activate") {
      expect(result.config.maxInjectedTokens).toBe(1200);
      expect(result.config.minScore).toBe(0.1);
      expect(result.config.lambda).toBe(0.07);
    }
  });

  test("activates with empty stacks array (no preset stacks at all)", () => {
    const result = resolveAceActivation(ENABLED_BARE, [], STUB_FACTORIES);
    expect(result.kind).toBe("activate");
  });
});
