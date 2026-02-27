import { describe, expect, test } from "bun:test";
import type { DelegationGrant, DelegationId } from "@koi/core";
import { agentId } from "@koi/core";
import { signGrant, verifySignature } from "./sign.js";

const SECRET = "test-secret-key-32-bytes-minimum";

function makeUnsignedGrant(overrides?: Partial<DelegationGrant>): Omit<DelegationGrant, "proof"> {
  return {
    id: "grant-1" as DelegationId,
    issuerId: agentId("agent-1"),
    delegateeId: agentId("agent-2"),
    scope: { permissions: { allow: ["read_file", "write_file"] } },
    chainDepth: 0,
    maxChainDepth: 3,
    createdAt: 1700000000000,
    expiresAt: 1700003600000,
    ...overrides,
  };
}

describe("signGrant + verifySignature", () => {
  test("valid signature round-trip", () => {
    const unsigned = makeUnsignedGrant();
    const proof = signGrant(unsigned, SECRET);
    const grant: DelegationGrant = { ...unsigned, proof };

    expect(proof.kind).toBe("hmac-sha256");
    if (proof.kind === "hmac-sha256") {
      expect(typeof proof.digest).toBe("string");
      expect(proof.digest.length).toBeGreaterThan(0);
    }
    expect(verifySignature(grant, SECRET)).toBe(true);
  });

  test("wrong key returns false", () => {
    const unsigned = makeUnsignedGrant();
    const proof = signGrant(unsigned, SECRET);
    const grant: DelegationGrant = { ...unsigned, proof };

    expect(verifySignature(grant, "wrong-key")).toBe(false);
  });

  test("tampered id field returns false", () => {
    const unsigned = makeUnsignedGrant();
    const proof = signGrant(unsigned, SECRET);
    const grant: DelegationGrant = {
      ...unsigned,
      id: "tampered-id" as DelegationId,
      proof,
    };

    expect(verifySignature(grant, SECRET)).toBe(false);
  });

  test("tampered scope field returns false", () => {
    const unsigned = makeUnsignedGrant();
    const proof = signGrant(unsigned, SECRET);
    const grant: DelegationGrant = {
      ...unsigned,
      scope: { permissions: { allow: ["*"] } },
      proof,
    };

    expect(verifySignature(grant, SECRET)).toBe(false);
  });

  test("tampered expiresAt field returns false", () => {
    const unsigned = makeUnsignedGrant();
    const proof = signGrant(unsigned, SECRET);
    const grant: DelegationGrant = {
      ...unsigned,
      expiresAt: 9999999999999,
      proof,
    };

    expect(verifySignature(grant, SECRET)).toBe(false);
  });

  test("empty digest returns false", () => {
    const unsigned = makeUnsignedGrant();
    const grant: DelegationGrant = {
      ...unsigned,
      proof: { kind: "hmac-sha256", digest: "" },
    };

    expect(verifySignature(grant, SECRET)).toBe(false);
  });

  test("invalid hex digest returns false", () => {
    const unsigned = makeUnsignedGrant();
    // 64-char string but not valid hex
    const grant: DelegationGrant = {
      ...unsigned,
      proof: {
        kind: "hmac-sha256",
        digest: "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz",
      },
    };

    expect(verifySignature(grant, SECRET)).toBe(false);
  });

  test("wrong-length digest returns false", () => {
    const unsigned = makeUnsignedGrant();
    const grant: DelegationGrant = {
      ...unsigned,
      proof: { kind: "hmac-sha256", digest: "abc123" },
    };

    expect(verifySignature(grant, SECRET)).toBe(false);
  });

  test("non-hmac proof kind returns false", () => {
    const unsigned = makeUnsignedGrant();
    const grant: DelegationGrant = {
      ...unsigned,
      proof: { kind: "nexus", token: "some-nexus-token" },
    };

    expect(verifySignature(grant, SECRET)).toBe(false);
  });

  test("deterministic — same input always produces same proof", () => {
    const unsigned = makeUnsignedGrant();
    const proof1 = signGrant(unsigned, SECRET);
    const proof2 = signGrant(unsigned, SECRET);

    expect(proof1).toEqual(proof2);
  });
});
