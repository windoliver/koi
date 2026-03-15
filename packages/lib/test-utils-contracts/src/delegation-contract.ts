/**
 * DelegationComponent contract test suite.
 *
 * Validates that any DelegationComponent implementation satisfies the L0 contract.
 * Both in-memory (@koi/delegation) and Nexus-backed (@koi/delegation-nexus)
 * implementations should pass this suite.
 */

import { expect, test } from "bun:test";
import type { AgentId, DelegationComponent, DelegationId, DelegationScope } from "@koi/core";

export interface DelegationContractOptions {
  /** Factory that creates a fresh DelegationComponent for each test. */
  readonly createComponent: () => DelegationComponent | Promise<DelegationComponent>;
  /** Agent ID to use as the issuer/delegator. */
  readonly issuerId: AgentId;
  /** Agent ID to use as the delegatee/receiver. */
  readonly delegateeId: AgentId;
}

/**
 * Runs the DelegationComponent contract test suite.
 *
 * Call this inside a `describe()` block. It registers tests that verify
 * the component satisfies all L0 contract invariants:
 * - grant() returns a valid DelegationGrant
 * - revoke() removes a grant
 * - verify() checks grant validity
 * - list() returns active grants
 */
export function testDelegationComponentContract(options: DelegationContractOptions): void {
  const { createComponent, issuerId, delegateeId } = options;

  const testScope: DelegationScope = {
    permissions: { allow: ["read_file", "write_file"] },
  };

  // ---------------------------------------------------------------------------
  // grant()
  // ---------------------------------------------------------------------------

  test("grant() returns a DelegationGrant with correct fields", async () => {
    const component = await createComponent();
    const grant = await component.grant(testScope, delegateeId);

    expect(grant.id).toBeDefined();
    expect(typeof grant.id).toBe("string");
    expect(grant.id.length).toBeGreaterThan(0);
    expect(grant.issuerId).toBe(issuerId);
    expect(grant.delegateeId).toBe(delegateeId);
    expect(grant.scope).toEqual(testScope);
    expect(grant.chainDepth).toBe(0);
    expect(grant.maxChainDepth).toBeGreaterThanOrEqual(0);
    expect(grant.createdAt).toBeGreaterThan(0);
    expect(grant.expiresAt).toBeGreaterThan(grant.createdAt);
    expect(grant.proof).toBeDefined();
    expect(grant.proof.kind).toBeDefined();
  });

  test("grant() with custom TTL sets expiresAt accordingly", async () => {
    const component = await createComponent();
    const before = Date.now();
    const grant = await component.grant(testScope, delegateeId, 60_000); // 1 minute
    const after = Date.now();

    // expiresAt should be within [before + 60s, after + 60s]
    expect(grant.expiresAt).toBeGreaterThanOrEqual(before + 59_000);
    expect(grant.expiresAt).toBeLessThanOrEqual(after + 61_000);
  });

  test("grant() returns unique IDs for different grants", async () => {
    const component = await createComponent();
    const grant1 = await component.grant(testScope, delegateeId);
    const grant2 = await component.grant(testScope, delegateeId);

    expect(grant1.id).not.toBe(grant2.id);
  });

  // ---------------------------------------------------------------------------
  // list()
  // ---------------------------------------------------------------------------

  test("list() returns empty array when no grants exist", async () => {
    const component = await createComponent();
    const grants = await component.list();

    expect(Array.isArray(grants)).toBe(true);
    expect(grants).toHaveLength(0);
  });

  test("list() includes granted delegations", async () => {
    const component = await createComponent();
    const grant = await component.grant(testScope, delegateeId);
    const grants = await component.list();

    expect(grants.length).toBeGreaterThanOrEqual(1);
    expect(grants.some((g) => g.id === grant.id)).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // verify()
  // ---------------------------------------------------------------------------

  test("verify() returns ok:true for a valid, active grant", async () => {
    const component = await createComponent();
    const grant = await component.grant(
      { permissions: { allow: ["read_file"] } },
      delegateeId,
    );

    const result = await component.verify(grant.id, "read_file");
    expect(result.ok).toBe(true);
  });

  test("verify() returns ok:false for an unknown grant ID", async () => {
    const component = await createComponent();
    const fakeId = "nonexistent-grant-id-12345" as unknown as DelegationId;

    const result = await component.verify(fakeId, "read_file");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("unknown_grant");
    }
  });

  // ---------------------------------------------------------------------------
  // revoke()
  // ---------------------------------------------------------------------------

  test("revoke() removes a grant so verify returns ok:false", async () => {
    const component = await createComponent();
    const grant = await component.grant(testScope, delegateeId);

    // Should be valid before revoke
    const beforeResult = await component.verify(grant.id, "read_file");
    expect(beforeResult.ok).toBe(true);

    // Revoke
    await component.revoke(grant.id);

    // Should be invalid after revoke
    const afterResult = await component.verify(grant.id, "read_file");
    expect(afterResult.ok).toBe(false);
  });

  test("revoke() removes grant from list()", async () => {
    const component = await createComponent();
    const grant = await component.grant(testScope, delegateeId);

    await component.revoke(grant.id);

    const grants = await component.list();
    expect(grants.some((g) => g.id === grant.id)).toBe(false);
  });

  test("revoke() is idempotent — revoking twice does not throw", async () => {
    const component = await createComponent();
    const grant = await component.grant(testScope, delegateeId);

    await component.revoke(grant.id);
    // Second revoke should not throw
    await component.revoke(grant.id);
  });
}
