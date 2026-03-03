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
  test("returns ttlMs for promoted tier", () => {
    expect(computeTtl("promoted", DEFAULT_REVERIFICATION_CONFIG)).toBe(24 * 60 * 60 * 1_000);
  });

  test("returns ttlMs for verified tier", () => {
    expect(computeTtl("verified", DEFAULT_REVERIFICATION_CONFIG)).toBe(24 * 60 * 60 * 1_000);
  });

  test("returns undefined for sandbox tier", () => {
    expect(computeTtl("sandbox", DEFAULT_REVERIFICATION_CONFIG)).toBeUndefined();
  });

  test("uses custom ttlMs from config", () => {
    const config: ReverificationConfig = { ...DEFAULT_REVERIFICATION_CONFIG, ttlMs: 5_000 };
    expect(computeTtl("promoted", config)).toBe(5_000);
    expect(computeTtl("verified", config)).toBe(5_000);
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
    const ttl = DEFAULT_REVERIFICATION_CONFIG.ttlMs;
    const result = isStale(
      { trustTier: "verified", lastVerifiedAt: BASE_TIME - ttl + 1_000 },
      configWith(() => BASE_TIME),
    );
    expect(result).toBe(false);
  });

  test("returns true when verified brick is stale", () => {
    const ttl = DEFAULT_REVERIFICATION_CONFIG.ttlMs;
    const result = isStale(
      { trustTier: "verified", lastVerifiedAt: BASE_TIME - ttl - 1 },
      configWith(() => BASE_TIME),
    );
    expect(result).toBe(true);
  });

  test("returns false when promoted brick is fresh", () => {
    const ttl = DEFAULT_REVERIFICATION_CONFIG.ttlMs;
    const result = isStale(
      { trustTier: "promoted", lastVerifiedAt: BASE_TIME - ttl + 1_000 },
      configWith(() => BASE_TIME),
    );
    expect(result).toBe(false);
  });

  test("returns true when promoted brick is stale", () => {
    const ttl = DEFAULT_REVERIFICATION_CONFIG.ttlMs;
    const result = isStale(
      { trustTier: "promoted", lastVerifiedAt: BASE_TIME - ttl - 1 },
      configWith(() => BASE_TIME),
    );
    expect(result).toBe(true);
  });

  test("returns false when exactly at TTL boundary", () => {
    const ttl = DEFAULT_REVERIFICATION_CONFIG.ttlMs;
    // elapsed === ttl → not stale (need strictly greater)
    const result = isStale(
      { trustTier: "verified", lastVerifiedAt: BASE_TIME - ttl },
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

  test("same TTL applies to both verified and promoted tiers", () => {
    const config = configWith(() => BASE_TIME);
    const verifiedTtl = computeTtl("verified", config);
    const promotedTtl = computeTtl("promoted", config);
    expect(verifiedTtl).toBe(promotedTtl);
  });
});
