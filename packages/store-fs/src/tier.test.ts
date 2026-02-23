import { describe, expect, test } from "bun:test";
import type { TierDescriptor } from "./tier.js";
import { isTierWritable, TIER_PRIORITY } from "./tier.js";

describe("tier", () => {
  test("TIER_PRIORITY has correct order", () => {
    expect(TIER_PRIORITY).toEqual(["agent", "shared", "extensions", "bundled"]);
  });

  test("TIER_PRIORITY has exactly 4 entries", () => {
    expect(TIER_PRIORITY).toHaveLength(4);
  });

  test("isTierWritable returns true for read-write tiers", () => {
    const rw: TierDescriptor = { name: "agent", access: "read-write", baseDir: "/tmp/agent" };
    expect(isTierWritable(rw)).toBe(true);
  });

  test("isTierWritable returns false for read-only tiers", () => {
    const ro: TierDescriptor = { name: "bundled", access: "read-only", baseDir: "/tmp/bundled" };
    expect(isTierWritable(ro)).toBe(false);
  });
});
