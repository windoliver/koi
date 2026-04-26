import { describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import type { CapabilityToken } from "@koi/core";
import { agentId, capabilityId, sessionId } from "@koi/core";
import { signEd25519, verifyEd25519 } from "./ed25519.js";

function newKeyPair(): { publicKey: Uint8Array; privateKey: Uint8Array; fingerprint: string } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pubDer = publicKey.export({ format: "der", type: "spki" });
  const privDer = privateKey.export({ format: "der", type: "pkcs8" });
  const fingerprint = Buffer.from(pubDer).toString("base64");
  return { publicKey: pubDer, privateKey: privDer, fingerprint };
}

const tokenWithProof = (fingerprint: string, signature: string): CapabilityToken => ({
  id: capabilityId("cap-1"),
  issuerId: agentId("alice"),
  delegateeId: agentId("bob"),
  scope: {
    permissions: { allow: ["read_file"] },
    sessionId: sessionId("sess-1"),
  },
  chainDepth: 0,
  maxChainDepth: 3,
  createdAt: 1000,
  expiresAt: 2000,
  proof: { kind: "ed25519", publicKey: fingerprint, signature },
});

describe("signEd25519 / verifyEd25519", () => {
  test("verify returns true for token signed with matching key", () => {
    const { publicKey, privateKey, fingerprint } = newKeyPair();
    const unsigned = tokenWithProof(fingerprint, "");
    const sig = signEd25519(unsigned, privateKey);
    const signed = tokenWithProof(fingerprint, sig);
    const keys = new Map([[fingerprint, publicKey]]);
    expect(verifyEd25519(signed, keys)).toBe(true);
  });

  test("verify returns false when public key fingerprint not in map", () => {
    const { privateKey, fingerprint } = newKeyPair();
    const unsigned = tokenWithProof(fingerprint, "");
    const sig = signEd25519(unsigned, privateKey);
    const signed = tokenWithProof(fingerprint, sig);
    expect(verifyEd25519(signed, new Map())).toBe(false);
  });

  test("verify returns false on tampered token", () => {
    const { publicKey, privateKey, fingerprint } = newKeyPair();
    const unsigned = tokenWithProof(fingerprint, "");
    const sig = signEd25519(unsigned, privateKey);
    const tampered: CapabilityToken = {
      ...tokenWithProof(fingerprint, sig),
      expiresAt: 9999,
    };
    const keys = new Map([[fingerprint, publicKey]]);
    expect(verifyEd25519(tampered, keys)).toBe(false);
  });

  test("verify returns false for non-ed25519 proof kind", () => {
    const { publicKey, fingerprint } = newKeyPair();
    const t: CapabilityToken = {
      ...tokenWithProof(fingerprint, "x"),
      proof: { kind: "hmac-sha256", digest: "y" },
    };
    expect(verifyEd25519(t, new Map([[fingerprint, publicKey]]))).toBe(false);
  });
});
