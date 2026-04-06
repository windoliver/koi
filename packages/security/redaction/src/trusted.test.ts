import { describe, expect, test } from "bun:test";
import { createAllSecretPatterns } from "./patterns/index.js";
import { isTrustedPattern, markTrusted } from "./trusted.js";
import type { SecretPattern } from "./types.js";

describe("isTrustedPattern", () => {
  test("returns false for a plain un-registered pattern", () => {
    const plain: SecretPattern = { name: "plain", kind: "plain", detect: () => [] };
    expect(isTrustedPattern(plain)).toBe(false);
  });

  test("returns true for a pattern passed through markTrusted", () => {
    const trusted = markTrusted({ name: "t", kind: "t", detect: () => [] });
    expect(isTrustedPattern(trusted)).toBe(true);
  });

  test("trust status is not transferable via structural copy", () => {
    const trusted = markTrusted({ name: "t", kind: "t", detect: () => [] });
    const copy = { ...trusted };
    expect(isTrustedPattern(copy)).toBe(false);
  });
});

describe("trust registry is reflection-resistant", () => {
  test("built-in detectors expose no trust-marking symbols", () => {
    // Regression for #1495: an exported symbol brand would let a caller do
    // Object.getOwnPropertySymbols(builtin)[0] and re-stamp it on a fake.
    const builtins = createAllSecretPatterns();
    for (const builtin of builtins) {
      expect(Object.getOwnPropertySymbols(builtin)).toEqual([]);
    }
  });

  test("stamping arbitrary symbols on a fake pattern does not grant trust", () => {
    // Even if the attacker invents their own symbol keys, isTrustedPattern
    // checks a module-private WeakSet — not object-owned keys.
    const fake: SecretPattern = { name: "fake", kind: "fake", detect: () => [] };
    const fakeSym = Symbol("koi.redaction.trusted");
    Object.defineProperty(fake, fakeSym, { value: true });
    expect(isTrustedPattern(fake)).toBe(false);
  });
});

describe("markTrusted freezes the pattern", () => {
  test("cannot overwrite detect on a trusted pattern", () => {
    const trusted = markTrusted({ name: "t", kind: "t", detect: () => [] });
    expect(() => {
      (trusted as { detect: unknown }).detect = () => {
        throw new Error("boom");
      };
    }).toThrow();
  });

  test("cannot overwrite detect on a built-in detector", () => {
    const builtins = createAllSecretPatterns();
    // biome-ignore lint/style/noNonNullAssertion: factory returns 13 entries
    const first = builtins[0]!;
    expect(() => {
      (first as { detect: unknown }).detect = () => [];
    }).toThrow();
  });
});
