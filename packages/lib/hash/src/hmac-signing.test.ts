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

describe("createHmacSigner edge cases", () => {
  describe("key longer than SHA-256 block size (64 bytes)", () => {
    // RFC 2104: keys longer than the block size are first hashed with SHA-256.
    // Two independent signer instances with the same 128-byte key must produce
    // identical HMACs -- proving the key-hashing path is deterministic and stable.
    const longKey = new Uint8Array(128);
    for (let i = 0; i < 128; i++) {
      // Non-uniform bytes to avoid trivial fill patterns
      longKey[i] = (i * 7 + 13) & 0xff;
    }
    const data = new TextEncoder().encode("long key determinism");

    test("produces stable HMAC across separate signer instances", () => {
      const signer1 = createHmacSigner(longKey);
      const signer2 = createHmacSigner(longKey);
      const sig1 = signer1.sign(data) as Uint8Array;
      const sig2 = signer2.sign(data) as Uint8Array;
      expect(sig1).toEqual(sig2);
    });

    test("produces a valid 32-byte signature", () => {
      const signer = createHmacSigner(longKey);
      const signature = signer.sign(data) as Uint8Array;
      expect(signature).toBeInstanceOf(Uint8Array);
      expect(signature.length).toBe(32);
    });

    test("signature differs from a signer with a short key of same prefix", () => {
      // A 64-byte key that is the prefix of the 128-byte long key.
      // The long key gets hashed, so HMAC output must differ.
      const shortKey = longKey.slice(0, 64);
      const signerLong = createHmacSigner(longKey);
      const signerShort = createHmacSigner(shortKey);
      const sigLong = signerLong.sign(data) as Uint8Array;
      const sigShort = signerShort.sign(data) as Uint8Array;
      expect(sigLong).not.toEqual(sigShort);
    });

    test("verify round-trips correctly with long key", () => {
      const signer = createHmacSigner(longKey);
      const signature = signer.sign(data) as Uint8Array;
      const valid = signer.verify(data, signature) as boolean;
      expect(valid).toBe(true);
    });
  });

  describe("empty data", () => {
    const key = new Uint8Array(32).fill(42);
    const emptyData = new Uint8Array(0);

    test("sign returns a valid 32-byte Uint8Array (not empty)", () => {
      const signer = createHmacSigner(key);
      const signature = signer.sign(emptyData) as Uint8Array;
      expect(signature).toBeInstanceOf(Uint8Array);
      expect(signature.length).toBe(32);
    });

    test("sign on empty data produces non-zero output", () => {
      const signer = createHmacSigner(key);
      const signature = signer.sign(emptyData) as Uint8Array;
      // At least one byte must be non-zero -- a zeroed HMAC is astronomically unlikely
      const hasNonZero = signature.some((byte) => byte !== 0);
      expect(hasNonZero).toBe(true);
    });

    test("empty data signature differs from non-empty data signature", () => {
      const signer = createHmacSigner(key);
      const sigEmpty = signer.sign(emptyData) as Uint8Array;
      const sigNonEmpty = signer.sign(new TextEncoder().encode("not empty")) as Uint8Array;
      expect(sigEmpty).not.toEqual(sigNonEmpty);
    });

    test("verify accepts correct signature for empty data", () => {
      const signer = createHmacSigner(key);
      const signature = signer.sign(emptyData) as Uint8Array;
      const valid = signer.verify(emptyData, signature) as boolean;
      expect(valid).toBe(true);
    });
  });

  describe("constant-time verify rejects single-byte-flipped signature", () => {
    const key = new Uint8Array(32).fill(7);
    const data = new TextEncoder().encode("tamper detection");

    test("verify returns true for correct signature", () => {
      const signer = createHmacSigner(key);
      const signature = signer.sign(data) as Uint8Array;
      const valid = signer.verify(data, signature) as boolean;
      expect(valid).toBe(true);
    });

    test("verify rejects signature with first byte flipped", () => {
      const signer = createHmacSigner(key);
      const signature = signer.sign(data) as Uint8Array;
      // Create a copy with only the first byte changed
      const flipped = new Uint8Array(signature);
      flipped[0] = (flipped[0] ?? 0) ^ 0x01;
      const valid = signer.verify(data, flipped) as boolean;
      expect(valid).toBe(false);
    });

    test("verify rejects signature with last byte flipped", () => {
      const signer = createHmacSigner(key);
      const signature = signer.sign(data) as Uint8Array;
      const flipped = new Uint8Array(signature);
      const lastIndex = flipped.length - 1;
      flipped[lastIndex] = (flipped[lastIndex] ?? 0) ^ 0x01;
      const valid = signer.verify(data, flipped) as boolean;
      expect(valid).toBe(false);
    });

    test("verify rejects signature with middle byte flipped", () => {
      const signer = createHmacSigner(key);
      const signature = signer.sign(data) as Uint8Array;
      const flipped = new Uint8Array(signature);
      const midIndex = 16;
      flipped[midIndex] = (flipped[midIndex] ?? 0) ^ 0x80;
      const valid = signer.verify(data, flipped) as boolean;
      expect(valid).toBe(false);
    });

    test("verify rejects every possible single-byte flip position", () => {
      const signer = createHmacSigner(key);
      const signature = signer.sign(data) as Uint8Array;
      for (let i = 0; i < signature.length; i++) {
        const flipped = new Uint8Array(signature);
        flipped[i] = (flipped[i] ?? 0) ^ 0xff;
        const valid = signer.verify(data, flipped) as boolean;
        expect(valid).toBe(false);
      }
    });
  });
});
