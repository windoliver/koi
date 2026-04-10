import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createPkceChallenge } from "./pkce.js";

describe("createPkceChallenge", () => {
  test("returns verifier, challenge, and method", () => {
    const pkce = createPkceChallenge();
    expect(pkce.verifier).toBeDefined();
    expect(pkce.challenge).toBeDefined();
    expect(pkce.method).toBe("S256");
  });

  test("verifier is base64url-encoded (no padding)", () => {
    const pkce = createPkceChallenge();
    expect(pkce.verifier).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(pkce.verifier.length).toBeGreaterThanOrEqual(43);
  });

  test("challenge is SHA-256 of verifier (base64url)", () => {
    const pkce = createPkceChallenge();
    const expected = createHash("sha256").update(pkce.verifier).digest("base64url");
    expect(pkce.challenge).toBe(expected);
  });

  test("generates unique verifiers each call", () => {
    const a = createPkceChallenge();
    const b = createPkceChallenge();
    expect(a.verifier).not.toBe(b.verifier);
    expect(a.challenge).not.toBe(b.challenge);
  });
});
