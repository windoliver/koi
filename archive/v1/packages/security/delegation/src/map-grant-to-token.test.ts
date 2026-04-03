import { describe, expect, test } from "bun:test";
import type { DelegationGrant, DelegationId } from "@koi/core";
import { agentId, capabilityId, sessionId } from "@koi/core";
import { mapGrantToCapabilityToken } from "./map-grant-to-token.js";
import { signGrant } from "./sign.js";

const SECRET = "test-secret-key-32-bytes-minimum";

function makeGrant(
  overrides: {
    readonly sessionId?: string;
    readonly resources?: readonly string[];
    readonly parentId?: DelegationId;
  } = {},
): DelegationGrant {
  const now = Date.now();
  const unsigned = {
    id: crypto.randomUUID() as DelegationId,
    issuerId: agentId("issuer-1"),
    delegateeId: agentId("delegatee-1"),
    scope: {
      permissions: { allow: ["read_file"] },
      ...(overrides.resources !== undefined ? { resources: overrides.resources } : {}),
      ...(overrides.sessionId !== undefined ? { sessionId: overrides.sessionId } : {}),
    },
    ...(overrides.parentId !== undefined ? { parentId: overrides.parentId } : {}),
    chainDepth: 0,
    maxChainDepth: 3,
    createdAt: now,
    expiresAt: now + 3600000,
  };
  const proof = signGrant(unsigned, SECRET);
  return { ...unsigned, proof };
}

describe("mapGrantToCapabilityToken", () => {
  test("returns undefined when grant has no sessionId", () => {
    const grant = makeGrant();
    expect(mapGrantToCapabilityToken(grant)).toBeUndefined();
  });

  test("maps grant with sessionId to CapabilityToken", () => {
    const grant = makeGrant({ sessionId: "session-abc" });
    const token = mapGrantToCapabilityToken(grant);

    expect(token).toBeDefined();
    expect(token?.id).toBe(capabilityId(grant.id));
    expect(token?.issuerId).toBe(grant.issuerId);
    expect(token?.delegateeId).toBe(grant.delegateeId);
    expect(token?.scope.sessionId).toBe(sessionId("session-abc"));
    expect(token?.scope.permissions).toEqual(grant.scope.permissions);
    expect(token?.chainDepth).toBe(grant.chainDepth);
    expect(token?.maxChainDepth).toBe(grant.maxChainDepth);
    expect(token?.createdAt).toBe(grant.createdAt);
    expect(token?.expiresAt).toBe(grant.expiresAt);
    expect(token?.proof).toEqual(grant.proof);
  });

  test("preserves resource patterns when present", () => {
    const grant = makeGrant({
      sessionId: "session-abc",
      resources: ["read_file:/workspace/**"],
    });
    const token = mapGrantToCapabilityToken(grant);

    expect(token?.scope.resources).toEqual(["read_file:/workspace/**"]);
  });

  test("preserves parentId when present", () => {
    const parentDelegationId = crypto.randomUUID() as DelegationId;
    const grant = makeGrant({
      sessionId: "session-abc",
      parentId: parentDelegationId,
    });
    const token = mapGrantToCapabilityToken(grant);

    // Same underlying string value — branded types differ at compile time only
    expect(String(token?.parentId)).toBe(String(parentDelegationId));
  });

  test("omits parentId when absent", () => {
    const grant = makeGrant({ sessionId: "session-abc" });
    const token = mapGrantToCapabilityToken(grant);

    expect(token?.parentId).toBeUndefined();
  });
});
