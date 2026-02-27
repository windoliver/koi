import { describe, expect, test } from "bun:test";
import type { ReverificationConfig } from "./reverification.js";
import { computeTtl, DEFAULT_REVERIFICATION_CONFIG, isStale } from "./reverification.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BASE_TIME = 1_700_000_000_000;

function configWith(now: () => number): ReverificationConfig {
  return { ...DEFAULT_REVERIFICATION_CONFIG, now };
}

// ---------------------------------------------------------------------------
// computeTtl
// ---------------------------------------------------------------------------

describe("computeTtl", () => {
  test("returns promotedTtlMs for promoted tier", () => {
    expect(computeTtl("promoted", DEFAULT_REVERIFICATION_CONFIG)).toBe(24 * 60 * 60 * 1_000);
  });

  test("returns verifiedTtlMs for verified tier", () => {
    expect(computeTtl("verified", DEFAULT_REVERIFICATION_CONFIG)).toBe(60 * 60 * 1_000);
  });

  test("returns undefined for sandbox tier", () => {
    expect(computeTtl("sandbox", DEFAULT_REVERIFICATION_CONFIG)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// isStale
// ---------------------------------------------------------------------------

describe("isStale", () => {
  test("returns false for sandbox bricks (never stale)", () => {
    const result = isStale(
      { trustTier: "sandbox", lastVerifiedAt: 0 },
      configWith(() => BASE_TIME),
    );
    expect(result).toBe(false);
  });

  test("returns true when lastVerifiedAt is absent (never verified)", () => {
    const result = isStale(
      { trustTier: "verified" },
      configWith(() => BASE_TIME),
    );
    expect(result).toBe(true);
  });

  test("returns false when verified brick is fresh", () => {
    const verifiedTtl = DEFAULT_REVERIFICATION_CONFIG.verifiedTtlMs;
    const result = isStale(
      { trustTier: "verified", lastVerifiedAt: BASE_TIME - verifiedTtl + 1_000 },
      configWith(() => BASE_TIME),
    );
    expect(result).toBe(false);
  });

  test("returns true when verified brick is stale", () => {
    const verifiedTtl = DEFAULT_REVERIFICATION_CONFIG.verifiedTtlMs;
    const result = isStale(
      { trustTier: "verified", lastVerifiedAt: BASE_TIME - verifiedTtl - 1 },
      configWith(() => BASE_TIME),
    );
    expect(result).toBe(true);
  });

  test("returns false when promoted brick is fresh", () => {
    const promotedTtl = DEFAULT_REVERIFICATION_CONFIG.promotedTtlMs;
    const result = isStale(
      { trustTier: "promoted", lastVerifiedAt: BASE_TIME - promotedTtl + 1_000 },
      configWith(() => BASE_TIME),
    );
    expect(result).toBe(false);
  });

  test("returns true when promoted brick is stale", () => {
    const promotedTtl = DEFAULT_REVERIFICATION_CONFIG.promotedTtlMs;
    const result = isStale(
      { trustTier: "promoted", lastVerifiedAt: BASE_TIME - promotedTtl - 1 },
      configWith(() => BASE_TIME),
    );
    expect(result).toBe(true);
  });

  test("returns true when exactly at TTL boundary (verified)", () => {
    const verifiedTtl = DEFAULT_REVERIFICATION_CONFIG.verifiedTtlMs;
    // elapsed === ttl → not stale (need strictly greater)
    const result = isStale(
      { trustTier: "verified", lastVerifiedAt: BASE_TIME - verifiedTtl },
      configWith(() => BASE_TIME),
    );
    expect(result).toBe(false);
  });

  test("sandbox brick without lastVerifiedAt is still not stale", () => {
    const result = isStale(
      { trustTier: "sandbox" },
      configWith(() => BASE_TIME),
    );
    expect(result).toBe(false);
  });
});
