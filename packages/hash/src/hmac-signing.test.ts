/**
 * HMAC-SHA256 signing backend tests.
 */

import { describe, expect, test } from "bun:test";
import { createHmacSigner } from "./hmac-signing.js";

describe("createHmacSigner", () => {
  const key = new Uint8Array(32).fill(42);

  test("algorithm is hmac-sha256", () => {
    const signer = createHmacSigner(key);
    expect(signer.algorithm).toBe("hmac-sha256");
  });

  test("sign produces 32-byte signature", () => {
    const signer = createHmacSigner(key);
    const data = new TextEncoder().encode("hello world");
    const signature = signer.sign(data) as Uint8Array;
    expect(signature).toBeInstanceOf(Uint8Array);
    expect(signature.length).toBe(32);
  });

  test("verify accepts correct signature", () => {
    const signer = createHmacSigner(key);
    const data = new TextEncoder().encode("test data");
    const signature = signer.sign(data) as Uint8Array;
    const valid = signer.verify(data, signature) as boolean;
    expect(valid).toBe(true);
  });

  test("verify rejects wrong data", () => {
    const signer = createHmacSigner(key);
    const data = new TextEncoder().encode("original");
    const signature = signer.sign(data) as Uint8Array;
    const tampered = new TextEncoder().encode("tampered");
    const valid = signer.verify(tampered, signature) as boolean;
    expect(valid).toBe(false);
  });

  test("verify rejects wrong signature", () => {
    const signer = createHmacSigner(key);
    const data = new TextEncoder().encode("some data");
    const wrongSig = new Uint8Array(32).fill(0);
    const valid = signer.verify(data, wrongSig) as boolean;
    expect(valid).toBe(false);
  });

  test("verify rejects signature of wrong length", () => {
    const signer = createHmacSigner(key);
    const data = new TextEncoder().encode("data");
    const shortSig = new Uint8Array(16);
    const valid = signer.verify(data, shortSig) as boolean;
    expect(valid).toBe(false);
  });

  test("different keys produce different signatures", () => {
    const signer1 = createHmacSigner(new Uint8Array(32).fill(1));
    const signer2 = createHmacSigner(new Uint8Array(32).fill(2));
    const data = new TextEncoder().encode("same data");
    const sig1 = signer1.sign(data) as Uint8Array;
    const sig2 = signer2.sign(data) as Uint8Array;
    expect(sig1).not.toEqual(sig2);
  });

  test("same data produces same signature (deterministic)", () => {
    const signer = createHmacSigner(key);
    const data = new TextEncoder().encode("deterministic");
    const sig1 = signer.sign(data) as Uint8Array;
    const sig2 = signer.sign(data) as Uint8Array;
    expect(sig1).toEqual(sig2);
  });

  test("handles key longer than block size (64 bytes)", () => {
    const longKey = new Uint8Array(128).fill(99);
    const signer = createHmacSigner(longKey);
    const data = new TextEncoder().encode("long key test");
    const signature = signer.sign(data) as Uint8Array;
    expect(signature.length).toBe(32);
    const valid = signer.verify(data, signature) as boolean;
    expect(valid).toBe(true);
  });

  test("handles empty data", () => {
    const signer = createHmacSigner(key);
    const data = new Uint8Array(0);
    const signature = signer.sign(data) as Uint8Array;
    expect(signature.length).toBe(32);
    const valid = signer.verify(data, signature) as boolean;
    expect(valid).toBe(true);
  });

  test("cross-signer verification fails (different keys)", () => {
    const signer1 = createHmacSigner(new Uint8Array(32).fill(1));
    const signer2 = createHmacSigner(new Uint8Array(32).fill(2));
    const data = new TextEncoder().encode("cross-signer");
    const signature = signer1.sign(data) as Uint8Array;
    const valid = signer2.verify(data, signature) as boolean;
    expect(valid).toBe(false);
  });
});
