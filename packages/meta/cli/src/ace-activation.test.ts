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
  readOperatorAck: () => "true",
};

const STUB_FACTORIES_NO_ACK = {
  ...STUB_FACTORIES,
  readOperatorAck: () => undefined,
};

const ENABLED_BARE: ManifestAceConfig = {
  enabled: true,
  acknowledgeCrossSessionState: true,
  maxInjectedTokens: undefined,
  minScore: undefined,
  lambda: undefined,
};

describe("resolveAceActivation — issue #2088", () => {
  test("skips when manifest.ace is undefined", () => {
    const result = resolveAceActivation(undefined, STUB_FACTORIES);
    expect(result.kind).toBe("skip");
  });

  test("skips when ace.enabled is false", () => {
    const result = resolveAceActivation(
      {
        enabled: false,
        acknowledgeCrossSessionState: false,
        maxInjectedTokens: undefined,
        minScore: undefined,
        lambda: undefined,
      },
      STUB_FACTORIES,
    );
    expect(result.kind).toBe("skip");
  });

  test("activates when ace.enabled is true", () => {
    const result = resolveAceActivation(ENABLED_BARE, STUB_FACTORIES);
    expect(result.kind).toBe("activate");
    if (result.kind === "activate") {
      expect(result.message).toContain("ace: enabled");
      expect(result.message).toContain("in-memory");
      expect(result.message).toContain("persist across /clear and /new");
      expect(result.message).toContain("Restart the TUI for a privacy boundary");
      expect(result.config.playbookStore).toBeDefined();
      // No trajectoryStore wired by default — see ace-activation.ts comment.
      expect(result.config.trajectoryStore).toBeUndefined();
      expect(result.config.maxInjectedTokens).toBeUndefined();
      expect(result.config.minScore).toBeUndefined();
      expect(result.config.lambda).toBeUndefined();
    }
  });

  test("blocks when manifest opts in but operator env-var ack is missing", () => {
    const result = resolveAceActivation(ENABLED_BARE, STUB_FACTORIES_NO_ACK);
    expect(result.kind).toBe("block");
    if (result.kind === "block") {
      expect(result.message).toContain("KOI_ACE_ACKNOWLEDGE_CROSS_SESSION_STATE");
      expect(result.message).toContain("local operator consent");
    }
  });

  test("forwards optional overrides into AceConfig when present", () => {
    const result = resolveAceActivation(
      {
        enabled: true,
        acknowledgeCrossSessionState: true,
        maxInjectedTokens: 1200,
        minScore: 0.1,
        lambda: 0.07,
      },
      STUB_FACTORIES,
    );
    expect(result.kind).toBe("activate");
    if (result.kind === "activate") {
      expect(result.config.maxInjectedTokens).toBe(1200);
      expect(result.config.minScore).toBe(0.1);
      expect(result.config.lambda).toBe(0.07);
    }
  });
});
