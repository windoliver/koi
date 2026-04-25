import { describe, expect, test } from "bun:test";
import type { CapabilityToken } from "@koi/core";
import { agentId, capabilityId, sessionId } from "@koi/core";
import { serializeForSigning } from "./canonical.js";

const baseToken = (): CapabilityToken => ({
  id: capabilityId("cap-1"),
  issuerId: agentId("alice"),
  delegateeId: agentId("bob"),
  scope: {
    permissions: { allow: ["read_file"], deny: [] },
    sessionId: sessionId("sess-1"),
  },
  chainDepth: 0,
  maxChainDepth: 3,
  createdAt: 1000,
  expiresAt: 2000,
  proof: { kind: "hmac-sha256", digest: "ignored" },
});

describe("serializeForSigning", () => {
  test("produces identical bytes for identical token-minus-proof", () => {
    const a = serializeForSigning(baseToken());
    const b = serializeForSigning(baseToken());
    expect(a).toEqual(b);
  });

  test("changing any field changes the bytes", () => {
    const a = serializeForSigning(baseToken());
    const b = serializeForSigning({ ...baseToken(), expiresAt: 2001 });
    expect(a).not.toEqual(b);
  });

  test("ignores the proof field", () => {
    const a = serializeForSigning(baseToken());
    const t = baseToken();
    const b = serializeForSigning({
      ...t,
      proof: { kind: "ed25519", publicKey: "x", signature: "y" },
    });
    expect(a).toEqual(b);
  });

  test("is independent of input key order", () => {
    const t = baseToken();
    const reordered: CapabilityToken = {
      proof: t.proof,
      expiresAt: t.expiresAt,
      createdAt: t.createdAt,
      maxChainDepth: t.maxChainDepth,
      chainDepth: t.chainDepth,
      scope: t.scope,
      delegateeId: t.delegateeId,
      issuerId: t.issuerId,
      id: t.id,
    };
    expect(serializeForSigning(t)).toEqual(serializeForSigning(reordered));
  });

  test("returns a Uint8Array of nonzero length", () => {
    const a = serializeForSigning(baseToken());
    expect(a).toBeInstanceOf(Uint8Array);
    expect(a.length).toBeGreaterThan(0);
  });
});
