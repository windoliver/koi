import { describe, expect, test } from "bun:test";
import { DEFAULT_NEXUS_SEARCH_CONFIG, validateNexusSearchConfig } from "./config.js";
import { createMockTransport } from "./test-helpers.js";

describe("validateNexusSearchConfig", () => {
  const transport = createMockTransport();

  test("accepts a minimal config", () => {
    const result = validateNexusSearchConfig({ transport });
    expect(result.ok).toBe(true);
  });

  test("rejects empty indexName", () => {
    const result = validateNexusSearchConfig({ transport, indexName: "" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("VALIDATION");
  });

  test("rejects non-positive maxBatchSize", () => {
    const result = validateNexusSearchConfig({ transport, maxBatchSize: 0 });
    expect(result.ok).toBe(false);
  });

  test("rejects NaN maxBatchSize", () => {
    const result = validateNexusSearchConfig({ transport, maxBatchSize: Number.NaN });
    expect(result.ok).toBe(false);
  });

  test("rejects Infinity maxBatchSize", () => {
    const result = validateNexusSearchConfig({
      transport,
      maxBatchSize: Number.POSITIVE_INFINITY,
    });
    expect(result.ok).toBe(false);
  });

  test("rejects fractional maxBatchSize", () => {
    const result = validateNexusSearchConfig({ transport, maxBatchSize: 2.5 });
    expect(result.ok).toBe(false);
  });

  test("DEFAULT_NEXUS_SEARCH_CONFIG exposes sane defaults", () => {
    expect(DEFAULT_NEXUS_SEARCH_CONFIG.indexName).toBe("koi");
    expect(DEFAULT_NEXUS_SEARCH_CONFIG.maxBatchSize).toBe(100);
  });
});
