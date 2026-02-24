import { describe, expect, test } from "bun:test";
import { validateAceConfig } from "./config.js";
import { createInMemoryPlaybookStore, createInMemoryTrajectoryStore } from "./stores.js";

function validConfig(): Record<string, unknown> {
  return {
    trajectoryStore: createInMemoryTrajectoryStore(),
    playbookStore: createInMemoryPlaybookStore(),
  };
}

describe("validateAceConfig", () => {
  test("accepts minimal valid config", () => {
    const result = validateAceConfig(validConfig());
    expect(result.ok).toBe(true);
  });

  test("rejects null config", () => {
    const result = validateAceConfig(null);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("non-null");
  });

  test("rejects undefined config", () => {
    const result = validateAceConfig(undefined);
    expect(result.ok).toBe(false);
  });

  test("rejects non-object config", () => {
    const result = validateAceConfig("string");
    expect(result.ok).toBe(false);
  });

  test("rejects missing trajectoryStore", () => {
    const config = { playbookStore: createInMemoryPlaybookStore() };
    const result = validateAceConfig(config);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("trajectoryStore");
  });

  test("rejects missing playbookStore", () => {
    const config = { trajectoryStore: createInMemoryTrajectoryStore() };
    const result = validateAceConfig(config);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("playbookStore");
  });

  test("rejects trajectoryStore without required methods", () => {
    const config = {
      ...validConfig(),
      trajectoryStore: { append: () => {} },
    };
    const result = validateAceConfig(config);
    expect(result.ok).toBe(false);
  });

  test("rejects playbookStore without required methods", () => {
    const config = {
      ...validConfig(),
      playbookStore: { get: () => {} },
    };
    const result = validateAceConfig(config);
    expect(result.ok).toBe(false);
  });

  // --- maxInjectionTokens ---
  test("accepts valid maxInjectionTokens", () => {
    const result = validateAceConfig({ ...validConfig(), maxInjectionTokens: 100 });
    expect(result.ok).toBe(true);
  });

  test("rejects negative maxInjectionTokens", () => {
    const result = validateAceConfig({ ...validConfig(), maxInjectionTokens: -1 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("maxInjectionTokens");
  });

  test("rejects non-number maxInjectionTokens", () => {
    const result = validateAceConfig({ ...validConfig(), maxInjectionTokens: "100" });
    expect(result.ok).toBe(false);
  });

  test("rejects Infinity maxInjectionTokens", () => {
    const result = validateAceConfig({ ...validConfig(), maxInjectionTokens: Infinity });
    expect(result.ok).toBe(false);
  });

  // --- minPlaybookConfidence ---
  test("accepts valid minPlaybookConfidence", () => {
    const result = validateAceConfig({ ...validConfig(), minPlaybookConfidence: 0.5 });
    expect(result.ok).toBe(true);
  });

  test("rejects minPlaybookConfidence > 1", () => {
    const result = validateAceConfig({ ...validConfig(), minPlaybookConfidence: 1.5 });
    expect(result.ok).toBe(false);
  });

  test("rejects negative minPlaybookConfidence", () => {
    const result = validateAceConfig({ ...validConfig(), minPlaybookConfidence: -0.1 });
    expect(result.ok).toBe(false);
  });

  // --- maxBufferEntries ---
  test("accepts valid maxBufferEntries", () => {
    const result = validateAceConfig({ ...validConfig(), maxBufferEntries: 500 });
    expect(result.ok).toBe(true);
  });

  test("rejects zero maxBufferEntries", () => {
    const result = validateAceConfig({ ...validConfig(), maxBufferEntries: 0 });
    expect(result.ok).toBe(false);
  });

  test("rejects non-integer maxBufferEntries", () => {
    const result = validateAceConfig({ ...validConfig(), maxBufferEntries: 1.5 });
    expect(result.ok).toBe(false);
  });

  // --- minCurationScore ---
  test("accepts valid minCurationScore", () => {
    const result = validateAceConfig({ ...validConfig(), minCurationScore: 0.5 });
    expect(result.ok).toBe(true);
  });

  test("rejects minCurationScore > 1", () => {
    const result = validateAceConfig({ ...validConfig(), minCurationScore: 2 });
    expect(result.ok).toBe(false);
  });

  // --- recencyDecayLambda ---
  test("accepts valid recencyDecayLambda", () => {
    const result = validateAceConfig({ ...validConfig(), recencyDecayLambda: 0.05 });
    expect(result.ok).toBe(true);
  });

  test("rejects negative recencyDecayLambda", () => {
    const result = validateAceConfig({ ...validConfig(), recencyDecayLambda: -0.01 });
    expect(result.ok).toBe(false);
  });

  // --- function fields ---
  test("accepts valid scorer function", () => {
    const result = validateAceConfig({ ...validConfig(), scorer: () => 0.5 });
    expect(result.ok).toBe(true);
  });

  test("rejects non-function scorer", () => {
    const result = validateAceConfig({ ...validConfig(), scorer: "not-a-fn" });
    expect(result.ok).toBe(false);
  });

  test("rejects non-function consolidate", () => {
    const result = validateAceConfig({ ...validConfig(), consolidate: 42 });
    expect(result.ok).toBe(false);
  });

  test("rejects non-function clock", () => {
    const result = validateAceConfig({ ...validConfig(), clock: 1000 });
    expect(result.ok).toBe(false);
  });

  // --- callback fields ---
  test("rejects non-function onRecord", () => {
    const result = validateAceConfig({ ...validConfig(), onRecord: "debug" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("onRecord");
  });

  test("rejects non-function onCurate", () => {
    const result = validateAceConfig({ ...validConfig(), onCurate: 42 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("onCurate");
  });

  test("rejects non-function onInject", () => {
    const result = validateAceConfig({ ...validConfig(), onInject: true });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("onInject");
  });

  test("rejects non-function onBufferEvict", () => {
    const result = validateAceConfig({ ...validConfig(), onBufferEvict: {} });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("onBufferEvict");
  });

  test("accepts all optional fields together", () => {
    const result = validateAceConfig({
      ...validConfig(),
      maxInjectionTokens: 500,
      playbookTags: ["test"],
      minPlaybookConfidence: 0.3,
      maxBufferEntries: 1000,
      minCurationScore: 0.1,
      recencyDecayLambda: 0.01,
      scorer: () => 0.5,
      consolidate: () => [],
      clock: () => Date.now(),
      onRecord: () => {},
      onCurate: () => {},
      onInject: () => {},
      onBufferEvict: () => {},
    });
    expect(result.ok).toBe(true);
  });
});
