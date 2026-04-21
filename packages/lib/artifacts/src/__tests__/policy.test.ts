import { describe, expect, test } from "bun:test";
import { computeExpiresAt, validateLifecyclePolicy } from "../policy.js";
import type { LifecyclePolicy } from "../types.js";

describe("validateLifecyclePolicy", () => {
  test("accepts all-undefined policy (no-op)", () => {
    expect(() => validateLifecyclePolicy({})).not.toThrow();
    expect(() => validateLifecyclePolicy(undefined)).not.toThrow();
  });

  test("accepts valid finite positive integers for every field", () => {
    expect(() =>
      validateLifecyclePolicy({
        ttlMs: 60_000,
        maxSessionBytes: 10_000_000,
        maxVersionsPerName: 5,
      }),
    ).not.toThrow();
  });

  test.each([
    { value: 0, label: "zero" },
    { value: -1, label: "negative" },
    { value: 0.5, label: "fractional" },
    { value: Number.NaN, label: "NaN" },
    { value: Number.POSITIVE_INFINITY, label: "Infinity" },
  ])("rejects invalid ttlMs: $label", ({ value }) => {
    expect(() => validateLifecyclePolicy({ ttlMs: value })).toThrow(/ttlMs/);
  });

  test.each([
    { value: 0, label: "zero" },
    { value: -1, label: "negative" },
    { value: 0.5, label: "fractional" },
    { value: Number.NaN, label: "NaN" },
    { value: Number.POSITIVE_INFINITY, label: "Infinity" },
  ])("rejects invalid maxSessionBytes: $label", ({ value }) => {
    expect(() => validateLifecyclePolicy({ maxSessionBytes: value })).toThrow(/maxSessionBytes/);
  });

  test.each([
    { value: 0, label: "zero" },
    { value: -1, label: "negative" },
    { value: 0.5, label: "fractional" },
    { value: Number.NaN, label: "NaN" },
    { value: Number.POSITIVE_INFINITY, label: "Infinity" },
  ])("rejects invalid maxVersionsPerName: $label", ({ value }) => {
    expect(() => validateLifecyclePolicy({ maxVersionsPerName: value })).toThrow(
      /maxVersionsPerName/,
    );
  });
});

describe("computeExpiresAt", () => {
  test("returns createdAt + ttlMs when ttlMs is set", () => {
    const createdAt = 1_000_000;
    const policy: LifecyclePolicy = { ttlMs: 5_000 };
    expect(computeExpiresAt(createdAt, policy)).toBe(1_005_000);
  });

  test("returns null when ttlMs is undefined", () => {
    expect(computeExpiresAt(1_000_000, { maxSessionBytes: 100 })).toBeNull();
    expect(computeExpiresAt(1_000_000, {})).toBeNull();
  });

  test("returns null when policy is undefined", () => {
    expect(computeExpiresAt(1_000_000, undefined)).toBeNull();
    expect(computeExpiresAt(1_000_000)).toBeNull();
  });
});
