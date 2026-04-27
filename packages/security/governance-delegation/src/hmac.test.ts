import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import type { CapabilityToken } from "@koi/core";
import { agentId, capabilityId, sessionId } from "@koi/core";
import { signHmac, verifyHmac } from "./hmac.js";

const SECRET = new Uint8Array(randomBytes(32));

const tokenWithDigest = (digest: string): CapabilityToken => ({
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
  proof: { kind: "hmac-sha256", digest },
});

describe("signHmac / verifyHmac", () => {
  test("verify returns true for token signed with same secret", () => {
    const unsigned = tokenWithDigest("");
    const digest = signHmac(unsigned, SECRET);
    const signed = tokenWithDigest(digest);
    expect(verifyHmac(signed, SECRET)).toBe(true);
  });

  test("verify returns false when secret differs", () => {
    const unsigned = tokenWithDigest("");
    const digest = signHmac(unsigned, SECRET);
    const signed = tokenWithDigest(digest);
    expect(verifyHmac(signed, new Uint8Array(randomBytes(32)))).toBe(false);
  });

  test("verify returns false when any token field is mutated", () => {
    const unsigned = tokenWithDigest("");
    const digest = signHmac(unsigned, SECRET);
    const tampered = { ...tokenWithDigest(digest), expiresAt: 9999 };
    expect(verifyHmac(tampered, SECRET)).toBe(false);
  });

  test("verify returns false for non-hmac proof kind", () => {
    const t: CapabilityToken = {
      ...tokenWithDigest(""),
      proof: { kind: "ed25519", publicKey: "x", signature: "y" },
    };
    expect(verifyHmac(t, SECRET)).toBe(false);
  });

  test("verify returns false when digest length differs from expected", () => {
    const tampered = tokenWithDigest("AAAA");
    expect(verifyHmac(tampered, SECRET)).toBe(false);
  });
});
