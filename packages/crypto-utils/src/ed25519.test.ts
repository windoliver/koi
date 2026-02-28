import { describe, expect, it } from "bun:test";
import { generateEd25519KeyPair, signEd25519, verifyEd25519 } from "./ed25519.js";

describe("generateEd25519KeyPair", () => {
  it("returns base64-encoded public and private keys", () => {
    const pair = generateEd25519KeyPair();
    expect(typeof pair.publicKeyDer).toBe("string");
    expect(typeof pair.privateKeyDer).toBe("string");
    expect(pair.publicKeyDer.length).toBeGreaterThan(0);
    expect(pair.privateKeyDer.length).toBeGreaterThan(0);
  });

  it("generates unique key pairs on each call", () => {
    const a = generateEd25519KeyPair();
    const b = generateEd25519KeyPair();
    expect(a.publicKeyDer).not.toBe(b.publicKeyDer);
    expect(a.privateKeyDer).not.toBe(b.privateKeyDer);
  });
});

describe("signEd25519 + verifyEd25519", () => {
  it("verifies a valid signature", () => {
    const { publicKeyDer, privateKeyDer } = generateEd25519KeyPair();
    const payload = "test-mandate-hash-abc123";
    const signature = signEd25519(payload, privateKeyDer);

    const valid = verifyEd25519(payload, publicKeyDer, signature);
    expect(valid).toBe(true);
  });

  it("rejects a tampered payload", () => {
    const { publicKeyDer, privateKeyDer } = generateEd25519KeyPair();
    const original = "original-mandate";
    const signature = signEd25519(original, privateKeyDer);

    const valid = verifyEd25519("tampered-mandate", publicKeyDer, signature);
    expect(valid).toBe(false);
  });

  it("rejects a signature from a different key pair", () => {
    const pair1 = generateEd25519KeyPair();
    const pair2 = generateEd25519KeyPair();
    const payload = "cross-key-test";
    const signature = signEd25519(payload, pair1.privateKeyDer);

    // Verify with wrong public key
    const valid = verifyEd25519(payload, pair2.publicKeyDer, signature);
    expect(valid).toBe(false);
  });

  it("rejects a corrupted base64 signature", () => {
    const { publicKeyDer } = generateEd25519KeyPair();
    const valid = verifyEd25519("payload", publicKeyDer, "not-valid-base64!!!");
    expect(valid).toBe(false);
  });

  it("rejects a corrupted public key", () => {
    const { privateKeyDer } = generateEd25519KeyPair();
    const payload = "test";
    const signature = signEd25519(payload, privateKeyDer);

    const valid = verifyEd25519(payload, "AAAA", signature);
    expect(valid).toBe(false);
  });

  it("handles empty payload", () => {
    const { publicKeyDer, privateKeyDer } = generateEd25519KeyPair();
    const signature = signEd25519("", privateKeyDer);
    const valid = verifyEd25519("", publicKeyDer, signature);
    expect(valid).toBe(true);
  });

  it("handles large payloads", () => {
    const { publicKeyDer, privateKeyDer } = generateEd25519KeyPair();
    const payload = "x".repeat(100_000);
    const signature = signEd25519(payload, privateKeyDer);
    const valid = verifyEd25519(payload, publicKeyDer, signature);
    expect(valid).toBe(true);
  });
});
