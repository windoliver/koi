/**
 * End-to-end delegation lifecycle test.
 *
 * Scenario: Three-agent delegation chain with full lifecycle.
 *
 *   Orchestrator → Worker → SubWorker
 *
 * 1. Orchestrator creates a root grant for Worker (read_file, write_file, search)
 * 2. Worker re-delegates to SubWorker with narrower scope (read_file only)
 * 3. Tool calls are verified through the middleware
 * 4. Orchestrator revokes the root grant — cascade invalidates the entire chain
 * 5. All subsequent tool calls are denied
 */

import { describe, expect, test } from "bun:test";
import type {
  DelegationGrant,
  DelegationId,
  KoiMiddleware,
  ScopeChecker,
  ToolRequest,
  ToolResponse,
  TurnContext,
} from "@koi/core";
import { agentId, runId, sessionId, turnId } from "@koi/core";
import {
  attenuateGrant,
  createDelegationMiddleware,
  createGrant,
  createGrantIndex,
  createInMemoryRegistry,
  revokeGrant,
  verifyGrant,
} from "../index.js";

const SECRET = "e2e-test-secret-key-32-bytes-min";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Creates a grant or throws in test context. */
function mustCreateGrant(params: Parameters<typeof createGrant>[0]): DelegationGrant {
  const result = createGrant(params);
  if (!result.ok) throw new Error(`Failed to create grant: ${result.error.message}`);
  return result.value;
}

function makeTurnContext(delegationId?: string): TurnContext {
  const rid = runId("test-run");
  return {
    session: {
      agentId: "test-agent",
      sessionId: sessionId("test-session"),
      runId: rid,
      metadata: delegationId !== undefined ? { delegationId } : {},
    },
    turnIndex: 0,
    turnId: turnId(rid, 0),
    messages: [],
    metadata: delegationId !== undefined ? { delegationId } : {},
  };
}

function makeToolRequest(toolId: string): ToolRequest {
  return { toolId, input: {} };
}

const passthrough = async (req: ToolRequest): Promise<ToolResponse> => ({
  output: { success: true, tool: req.toolId },
});

async function callWrapToolCall(
  mw: KoiMiddleware,
  ctx: TurnContext,
  req: ToolRequest,
  next: (request: ToolRequest) => Promise<ToolResponse>,
): Promise<ToolResponse> {
  const fn = mw.wrapToolCall;
  if (fn === undefined) throw new Error("wrapToolCall is undefined");
  return fn(ctx, req, next);
}

function isPermissionError(result: ToolResponse): boolean {
  if (result.metadata === undefined) return false;
  const meta = result.metadata as Record<string, unknown>;
  const error = meta.error as Record<string, unknown> | undefined;
  return error?.code === "PERMISSION";
}

// ---------------------------------------------------------------------------
// E2E: Full delegation lifecycle
// ---------------------------------------------------------------------------

describe("e2e: three-agent delegation chain lifecycle", () => {
  test("create → attenuate → verify → revoke → deny", async () => {
    const registry = createInMemoryRegistry();
    const index = createGrantIndex();

    // ------------------------------------------------------------------
    // Step 1: Orchestrator creates root grant for Worker
    // ------------------------------------------------------------------
    const rootGrant = mustCreateGrant({
      issuerId: agentId("orchestrator"),
      delegateeId: agentId("worker"),
      scope: {
        permissions: { allow: ["read_file", "write_file", "search"] },
        resources: ["read_file:/workspace/**", "write_file:/workspace/src/**"],
      },
      maxChainDepth: 3,
      ttlMs: 3600000,
      secret: SECRET,
    });

    index.addGrant(rootGrant);

    // Root grant is valid
    const rootVerify = await verifyGrant(rootGrant, "read_file", registry, SECRET);
    expect(rootVerify.ok).toBe(true);

    // ------------------------------------------------------------------
    // Step 2: Worker re-delegates to SubWorker (narrower scope)
    // ------------------------------------------------------------------
    const childResult = attenuateGrant(
      rootGrant,
      {
        delegateeId: agentId("sub-worker"),
        scope: {
          permissions: { allow: ["read_file"] },
          resources: ["read_file:/workspace/src/**"],
        },
      },
      SECRET,
    );

    expect(childResult.ok).toBe(true);
    if (!childResult.ok) return;

    const childGrant = childResult.value;
    index.addGrant(childGrant);

    // Child grant chain metadata is correct
    expect(childGrant.issuerId).toBe(agentId("worker")); // parent's delegateeId
    expect(childGrant.delegateeId).toBe(agentId("sub-worker"));
    expect(childGrant.chainDepth).toBe(1);
    expect(childGrant.parentId).toBe(rootGrant.id);
    expect(childGrant.expiresAt).toBeLessThanOrEqual(rootGrant.expiresAt);

    // Child grant is valid for allowed tool + resource
    const childVerify = await verifyGrant(
      childGrant,
      "read_file:/workspace/src/foo.ts",
      registry,
      SECRET,
    );
    expect(childVerify.ok).toBe(true);

    // Child grant is denied for tool outside its scope
    const childDenied = await verifyGrant(childGrant, "write_file", registry, SECRET);
    expect(childDenied.ok).toBe(false);
    if (!childDenied.ok) {
      expect(childDenied.reason).toBe("scope_exceeded");
    }

    // ------------------------------------------------------------------
    // Step 3: Attenuation violations are rejected
    // ------------------------------------------------------------------

    // Cannot widen scope beyond parent
    const widenResult = attenuateGrant(
      childGrant,
      {
        delegateeId: agentId("rogue-agent"),
        scope: { permissions: { allow: ["read_file", "write_file"] } }, // write_file not in child
      },
      SECRET,
    );
    expect(widenResult.ok).toBe(false);

    // Cannot extend expiry beyond parent
    const extendResult = attenuateGrant(
      childGrant,
      {
        delegateeId: agentId("another-agent"),
        scope: { permissions: { allow: ["read_file"] } },
        ttlMs: 9999999999, // way beyond parent expiry
      },
      SECRET,
    );
    expect(extendResult.ok).toBe(false);

    // ------------------------------------------------------------------
    // Step 4: Revoke root grant — cascade invalidates entire chain
    // ------------------------------------------------------------------
    const revokedIds = await revokeGrant(rootGrant.id, registry, index, true);

    expect(revokedIds).toContain(rootGrant.id);
    expect(revokedIds).toContain(childGrant.id);
    expect(revokedIds).toHaveLength(2);

    // ------------------------------------------------------------------
    // Step 5: All grants are now denied
    // ------------------------------------------------------------------
    const rootAfterRevoke = await verifyGrant(rootGrant, "read_file", registry, SECRET);
    expect(rootAfterRevoke.ok).toBe(false);
    if (!rootAfterRevoke.ok) {
      expect(rootAfterRevoke.reason).toBe("revoked");
    }

    const childAfterRevoke = await verifyGrant(
      childGrant,
      "read_file:/workspace/src/foo.ts",
      registry,
      SECRET,
    );
    expect(childAfterRevoke.ok).toBe(false);
    if (!childAfterRevoke.ok) {
      expect(childAfterRevoke.reason).toBe("revoked");
    }

    registry.dispose();
  });
});

// ---------------------------------------------------------------------------
// E2E: Middleware integration with real delegation chain
// ---------------------------------------------------------------------------

describe("e2e: middleware integration", () => {
  test("full tool call flow through middleware", async () => {
    const registry = createInMemoryRegistry();
    const grantStore = new Map<DelegationId, DelegationGrant>();

    const grant = mustCreateGrant({
      issuerId: agentId("orchestrator"),
      delegateeId: agentId("worker"),
      scope: { permissions: { allow: ["read_file", "search"] } },
      maxChainDepth: 2,
      ttlMs: 3600000,
      secret: SECRET,
    });
    grantStore.set(grant.id, grant);

    const mw = createDelegationMiddleware({
      secret: SECRET,
      registry,
      grantStore,
    });

    // Allowed tool call passes through
    const okResult = await callWrapToolCall(
      mw,
      makeTurnContext(grant.id),
      makeToolRequest("read_file"),
      passthrough,
    );
    expect(okResult.output).toEqual({ success: true, tool: "read_file" });

    // Denied tool call is blocked
    const deniedResult = await callWrapToolCall(
      mw,
      makeTurnContext(grant.id),
      makeToolRequest("exec"),
      passthrough,
    );
    expect(isPermissionError(deniedResult)).toBe(true);

    // No delegation context passes through (agent using own perms)
    const noDelegResult = await callWrapToolCall(
      mw,
      makeTurnContext(),
      makeToolRequest("exec"),
      passthrough,
    );
    expect(noDelegResult.output).toEqual({ success: true, tool: "exec" });

    // Revoke, then verify middleware blocks
    registry.revoke(grant.id, false);
    const afterRevoke = await callWrapToolCall(
      mw,
      makeTurnContext(grant.id),
      makeToolRequest("read_file"),
      passthrough,
    );
    expect(isPermissionError(afterRevoke)).toBe(true);

    registry.dispose();
  });
});

// ---------------------------------------------------------------------------
// E2E: Custom ScopeChecker swapped in
// ---------------------------------------------------------------------------

describe("e2e: pluggable ScopeChecker", () => {
  test("custom ReBAC-style checker replaces default glob matcher", async () => {
    const registry = createInMemoryRegistry();
    const grantStore = new Map<DelegationId, DelegationGrant>();

    // Grant with empty allow — default checker would deny everything
    const grant = mustCreateGrant({
      issuerId: agentId("orchestrator"),
      delegateeId: agentId("worker"),
      scope: { permissions: {} },
      maxChainDepth: 2,
      ttlMs: 3600000,
      secret: SECRET,
    });
    grantStore.set(grant.id, grant);

    // Simulated ReBAC checker: allows read_file for this specific agent
    const rebackChecker: ScopeChecker = {
      isAllowed: (toolId) => toolId === "read_file",
    };

    const mw = createDelegationMiddleware({
      secret: SECRET,
      registry,
      grantStore,
      scopeChecker: rebackChecker,
    });

    // read_file allowed by custom checker (despite empty scope.permissions)
    const okResult = await callWrapToolCall(
      mw,
      makeTurnContext(grant.id),
      makeToolRequest("read_file"),
      passthrough,
    );
    expect(okResult.output).toEqual({ success: true, tool: "read_file" });

    // exec denied by custom checker
    const deniedResult = await callWrapToolCall(
      mw,
      makeTurnContext(grant.id),
      makeToolRequest("exec"),
      passthrough,
    );
    expect(isPermissionError(deniedResult)).toBe(true);

    registry.dispose();
  });
});

// ---------------------------------------------------------------------------
// E2E: Deny rules grow monotonically
// ---------------------------------------------------------------------------

describe("e2e: deny list monotonicity", () => {
  test("child must preserve all parent deny rules", () => {
    const rootGrant = mustCreateGrant({
      issuerId: agentId("orchestrator"),
      delegateeId: agentId("worker"),
      scope: {
        permissions: { allow: ["read_file", "write_file", "exec"], deny: ["exec"] },
      },
      maxChainDepth: 3,
      ttlMs: 3600000,
      secret: SECRET,
    });

    // Child keeps parent deny + adds more — ok
    const stricterResult = attenuateGrant(
      rootGrant,
      {
        delegateeId: agentId("sub-worker"),
        scope: {
          permissions: {
            allow: ["read_file"],
            deny: ["exec", "write_file"],
          },
        },
      },
      SECRET,
    );
    expect(stricterResult.ok).toBe(true);

    // Child drops parent deny rule — rejected
    const dropDenyResult = attenuateGrant(
      rootGrant,
      {
        delegateeId: agentId("sub-worker"),
        scope: {
          permissions: { allow: ["read_file"] }, // missing deny: ["exec"]
        },
      },
      SECRET,
    );
    expect(dropDenyResult.ok).toBe(false);
  });
});
