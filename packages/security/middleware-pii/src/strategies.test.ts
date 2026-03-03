import { describe, expect, test } from "bun:test";
import { applyHash, applyMask, applyRedact } from "./strategies.js";
import type { PIIMatch } from "./types.js";

function match(overrides: Partial<PIIMatch> & { readonly kind: string }): PIIMatch {
  return { text: "test@example.com", start: 0, end: 16, ...overrides };
}

describe("applyRedact", () => {
  test("replaces with [REDACTED_<KIND>]", () => {
    expect(applyRedact(match({ kind: "email" }))).toBe("[REDACTED_EMAIL]");
    expect(applyRedact(match({ kind: "credit_card" }))).toBe("[REDACTED_CREDIT_CARD]");
    expect(applyRedact(match({ kind: "ip" }))).toBe("[REDACTED_IP]");
    expect(applyRedact(match({ kind: "mac" }))).toBe("[REDACTED_MAC]");
    expect(applyRedact(match({ kind: "url" }))).toBe("[REDACTED_URL]");
    expect(applyRedact(match({ kind: "ssn" }))).toBe("[REDACTED_SSN]");
    expect(applyRedact(match({ kind: "phone" }))).toBe("[REDACTED_PHONE]");
  });
});

describe("applyMask", () => {
  test("masks email preserving first char and domain", () => {
    const result = applyMask(match({ kind: "email", text: "john@example.com" }));
    expect(result).toBe("j***@example.com");
  });

  test("masks credit card preserving last 4 digits", () => {
    const result = applyMask(match({ kind: "credit_card", text: "4532 0151 2345 6789" }));
    expect(result).toBe("****-****-****-6789");
  });

  test("masks IP preserving last octet", () => {
    const result = applyMask(match({ kind: "ip", text: "192.168.1.42" }));
    expect(result).toBe("***.***.***.42");
  });

  test("masks MAC preserving OUI with colons", () => {
    const result = applyMask(match({ kind: "mac", text: "aa:bb:cc:dd:ee:ff" }));
    expect(result).toBe("aa:bb:cc:**:**:**");
  });

  test("masks MAC preserving OUI with dashes", () => {
    const result = applyMask(match({ kind: "mac", text: "AA-BB-CC-DD-EE-FF" }));
    expect(result).toBe("AA-BB-CC-**-**-**");
  });

  test("fully masks URL", () => {
    const result = applyMask(match({ kind: "url", text: "https://example.com" }));
    expect(result).toBe("[MASKED_URL]");
  });

  test("masks SSN preserving last 4 digits", () => {
    const result = applyMask(match({ kind: "ssn", text: "123-45-6789" }));
    expect(result).toBe("***-**-6789");
  });

  test("masks phone preserving last 4 digits", () => {
    const result = applyMask(match({ kind: "phone", text: "555-123-4567" }));
    expect(result).toBe("***-***-4567");
  });

  test("masks phone with country code preserving last 4", () => {
    const result = applyMask(match({ kind: "phone", text: "+1-555-123-4567" }));
    expect(result).toBe("***-***-4567");
  });

  test("fully masks custom kind", () => {
    const result = applyMask(match({ kind: "custom_field" }));
    expect(result).toBe("[MASKED_CUSTOM_FIELD]");
  });
});

describe("applyHash", () => {
  test("produces <kind:16-char-hex> format", () => {
    const createHasher = () => new Bun.CryptoHasher("sha256", "test-secret");
    const result = applyHash(match({ kind: "email", text: "user@example.com" }), createHasher);
    expect(result).toMatch(/^<email:[0-9a-f]{16}>$/);
  });

  test("produces deterministic output for same input and key", () => {
    const createHasher = () => new Bun.CryptoHasher("sha256", "test-secret");
    const m = match({ kind: "email", text: "user@example.com" });
    const result1 = applyHash(m, createHasher);
    const result2 = applyHash(m, createHasher);
    expect(result1).toBe(result2);
  });

  test("produces different output for different inputs", () => {
    const createHasher = () => new Bun.CryptoHasher("sha256", "test-secret");
    const result1 = applyHash(match({ kind: "email", text: "a@b.com" }), createHasher);
    const result2 = applyHash(match({ kind: "email", text: "c@d.com" }), createHasher);
    expect(result1).not.toBe(result2);
  });
});
