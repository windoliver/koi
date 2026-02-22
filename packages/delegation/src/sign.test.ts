import { describe, expect, test } from "bun:test";
import type { DelegationGrant, DelegationId } from "@koi/core";
import { signGrant, verifySignature } from "./sign.js";

const SECRET = "test-secret-key-32-bytes-minimum";

function makeUnsignedGrant(
  overrides?: Partial<DelegationGrant>,
): Omit<DelegationGrant, "signature"> {
  return {
    id: "grant-1" as DelegationId,
    issuerId: "agent-1",
    delegateeId: "agent-2",
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
    const signature = signGrant(unsigned, SECRET);
    const grant: DelegationGrant = { ...unsigned, signature };

    expect(typeof signature).toBe("string");
    expect(signature.length).toBeGreaterThan(0);
    expect(verifySignature(grant, SECRET)).toBe(true);
  });

  test("wrong key returns false", () => {
    const unsigned = makeUnsignedGrant();
    const signature = signGrant(unsigned, SECRET);
    const grant: DelegationGrant = { ...unsigned, signature };

    expect(verifySignature(grant, "wrong-key")).toBe(false);
  });

  test("tampered id field returns false", () => {
    const unsigned = makeUnsignedGrant();
    const signature = signGrant(unsigned, SECRET);
    const grant: DelegationGrant = {
      ...unsigned,
      id: "tampered-id" as DelegationId,
      signature,
    };

    expect(verifySignature(grant, SECRET)).toBe(false);
  });

  test("tampered scope field returns false", () => {
    const unsigned = makeUnsignedGrant();
    const signature = signGrant(unsigned, SECRET);
    const grant: DelegationGrant = {
      ...unsigned,
      scope: { permissions: { allow: ["*"] } },
      signature,
    };

    expect(verifySignature(grant, SECRET)).toBe(false);
  });

  test("tampered expiresAt field returns false", () => {
    const unsigned = makeUnsignedGrant();
    const signature = signGrant(unsigned, SECRET);
    const grant: DelegationGrant = {
      ...unsigned,
      expiresAt: 9999999999999,
      signature,
    };

    expect(verifySignature(grant, SECRET)).toBe(false);
  });

  test("empty signature returns false", () => {
    const unsigned = makeUnsignedGrant();
    const grant: DelegationGrant = { ...unsigned, signature: "" };

    expect(verifySignature(grant, SECRET)).toBe(false);
  });

  test("invalid hex signature returns false", () => {
    const unsigned = makeUnsignedGrant();
    // 64-char string but not valid hex
    const grant: DelegationGrant = {
      ...unsigned,
      signature: "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz",
    };

    expect(verifySignature(grant, SECRET)).toBe(false);
  });

  test("wrong-length signature returns false", () => {
    const unsigned = makeUnsignedGrant();
    const grant: DelegationGrant = { ...unsigned, signature: "abc123" };

    expect(verifySignature(grant, SECRET)).toBe(false);
  });

  test("deterministic — same input always produces same signature", () => {
    const unsigned = makeUnsignedGrant();
    const sig1 = signGrant(unsigned, SECRET);
    const sig2 = signGrant(unsigned, SECRET);

    expect(sig1).toBe(sig2);
  });
});
