import { describe, expect, test } from "bun:test";
import { validateMemoryConfig } from "./config.js";
import { createInMemoryStore } from "./store.js";

describe("validateMemoryConfig", () => {
  const store = createInMemoryStore();

  test("accepts valid config with required fields", () => {
    const result = validateMemoryConfig({ store });
    expect(result.ok).toBe(true);
  });

  test("rejects null config", () => {
    const result = validateMemoryConfig(null);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("VALIDATION");
  });

  test("rejects undefined config", () => {
    const result = validateMemoryConfig(undefined);
    expect(result.ok).toBe(false);
  });

  test("rejects config without store", () => {
    const result = validateMemoryConfig({});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("store");
  });

  test("rejects negative maxRecallTokens", () => {
    const result = validateMemoryConfig({ store, maxRecallTokens: -1 });
    expect(result.ok).toBe(false);
  });

  test("rejects zero maxRecallTokens", () => {
    const result = validateMemoryConfig({ store, maxRecallTokens: 0 });
    expect(result.ok).toBe(false);
  });

  test("accepts positive maxRecallTokens", () => {
    const result = validateMemoryConfig({ store, maxRecallTokens: 8000 });
    expect(result.ok).toBe(true);
  });

  test("accepts valid recallStrategy 'recent'", () => {
    const result = validateMemoryConfig({ store, recallStrategy: "recent" });
    expect(result.ok).toBe(true);
  });

  test("accepts valid recallStrategy 'relevant'", () => {
    const result = validateMemoryConfig({ store, recallStrategy: "relevant" });
    expect(result.ok).toBe(true);
  });

  test("accepts valid recallStrategy 'hybrid'", () => {
    const result = validateMemoryConfig({ store, recallStrategy: "hybrid" });
    expect(result.ok).toBe(true);
  });

  test("rejects invalid recallStrategy", () => {
    const result = validateMemoryConfig({ store, recallStrategy: "invalid" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("recallStrategy");
  });

  test("accepts config with all optional fields", () => {
    const result = validateMemoryConfig({
      store,
      maxRecallTokens: 4000,
      recallStrategy: "hybrid",
      storeResponses: true,
    });
    expect(result.ok).toBe(true);
  });

  test("all errors are non-retryable", () => {
    const result = validateMemoryConfig(null);
    if (!result.ok) expect(result.error.retryable).toBe(false);
  });
});
