import { describe, expect, test } from "bun:test";
import type { AgentManifest } from "@koi/core";
import type { ResolutionContext } from "@koi/resolve";
import { createAceMiddleware } from "./ace.js";
import { descriptor, getAceStores } from "./descriptor.js";
import { createInMemoryPlaybookStore, createInMemoryTrajectoryStore } from "./stores.js";

const STUB_CONTEXT: ResolutionContext = {
  manifestDir: "/tmp",
  manifest: { name: "test-agent" } as AgentManifest,
  env: {},
};

describe("descriptor", () => {
  test("has correct kind and name", () => {
    expect(descriptor.kind).toBe("middleware");
    expect(descriptor.name).toBe("@koi/middleware-ace");
  });

  test("has aliases", () => {
    expect(descriptor.aliases).toEqual(["ace"]);
  });

  // ── optionsValidator ──

  test("rejects null options", () => {
    const result = descriptor.optionsValidator(null);
    expect(result.ok).toBe(false);
  });

  test("rejects undefined options", () => {
    const result = descriptor.optionsValidator(undefined);
    expect(result.ok).toBe(false);
  });

  test("rejects non-object options", () => {
    const result = descriptor.optionsValidator("string");
    expect(result.ok).toBe(false);
  });

  test("accepts empty object", () => {
    const result = descriptor.optionsValidator({});
    expect(result.ok).toBe(true);
  });

  test("accepts valid maxInjectionTokens", () => {
    const result = descriptor.optionsValidator({ maxInjectionTokens: 500 });
    expect(result.ok).toBe(true);
  });

  test("rejects non-positive maxInjectionTokens", () => {
    const result = descriptor.optionsValidator({ maxInjectionTokens: 0 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
    }
  });

  test("rejects negative maxInjectionTokens", () => {
    const result = descriptor.optionsValidator({ maxInjectionTokens: -1 });
    expect(result.ok).toBe(false);
  });

  test("rejects NaN maxInjectionTokens", () => {
    const result = descriptor.optionsValidator({ maxInjectionTokens: NaN });
    expect(result.ok).toBe(false);
  });

  test("rejects non-number maxInjectionTokens", () => {
    const result = descriptor.optionsValidator({ maxInjectionTokens: "500" });
    expect(result.ok).toBe(false);
  });

  test("accepts options with extra unknown properties", () => {
    const result = descriptor.optionsValidator({ unknownField: "hello" });
    expect(result.ok).toBe(true);
  });

  // ── factory ──

  test("factory creates middleware with default stores", async () => {
    const middleware = await descriptor.factory({}, STUB_CONTEXT);
    expect(middleware.name).toBe("ace");
    expect(typeof middleware.wrapModelCall).toBe("function");
    expect(typeof middleware.wrapToolCall).toBe("function");
    expect(typeof middleware.onSessionEnd).toBe("function");
  });

  test("factory creates middleware with maxInjectionTokens", async () => {
    const middleware = await descriptor.factory({ maxInjectionTokens: 200 }, STUB_CONTEXT);
    expect(middleware.name).toBe("ace");
  });

  test("factory middleware has describeCapabilities", async () => {
    const middleware = await descriptor.factory({}, STUB_CONTEXT);
    expect(typeof middleware.describeCapabilities).toBe("function");
  });

  // ── companionSkills ──

  test("has self-forge companion skill", () => {
    expect(descriptor.companionSkills).toHaveLength(1);
    expect(descriptor.companionSkills?.[0]?.name).toBe("ace-self-forge");
    expect(descriptor.companionSkills?.[0]?.content).toContain("list_playbooks");
  });

  // ── getAceStores ──

  test("getAceStores returns stores for descriptor-created middleware", async () => {
    const middleware = await descriptor.factory({}, STUB_CONTEXT);
    const stores = getAceStores(middleware);
    expect(stores).toBeDefined();
    expect(stores?.playbookStore).toBeDefined();
  });

  test("getAceStores returns undefined for non-descriptor middleware", () => {
    const stores = getAceStores({
      name: "not-ace",
      priority: 0,
      describeCapabilities: () => undefined,
    });
    expect(stores).toBeUndefined();
  });

  test("getAceStores works with direct createAceMiddleware() (not just descriptor)", () => {
    const playbookStore = createInMemoryPlaybookStore();
    const middleware = createAceMiddleware({
      trajectoryStore: createInMemoryTrajectoryStore(),
      playbookStore,
    });
    const stores = getAceStores(middleware);
    expect(stores).toBeDefined();
    expect(stores?.playbookStore).toBe(playbookStore);
  });
});
