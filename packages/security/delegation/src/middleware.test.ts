import { describe, expect, test } from "bun:test";
import type {
  CapabilityToken,
  CapabilityVerifier,
  CapabilityVerifyResult,
  DelegationGrant,
  DelegationId,
  KoiMiddleware,
  RevocationRegistry,
  ScopeChecker,
  SessionId,
  ToolRequest,
  ToolResponse,
  TurnContext,
  VerifyContext,
} from "@koi/core";
import { agentId, runId, sessionId, turnId } from "@koi/core";
import { createGrant } from "./grant.js";
import { createDelegationMiddleware } from "./middleware.js";
import { signGrant } from "./sign.js";

const SECRET = "test-secret-key-32-bytes-minimum";

function makeRegistry(revokedSet?: Set<DelegationId>): RevocationRegistry {
  const revoked = revokedSet ?? new Set<DelegationId>();
  return {
    isRevoked: (id) => revoked.has(id),
    revoke: (id) => {
      revoked.add(id);
    },
  };
}

function makeTurnContext(delegationId?: string): TurnContext {
  const rid = runId("run-1");
  return {
    session: {
      agentId: "agent-1",
      sessionId: sessionId("session-1"),
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

/** Extract the error object from a denied ToolResponse's metadata. */
function extractError(result: ToolResponse): Record<string, unknown> {
  const meta = result.metadata;
  if (meta === undefined || typeof meta !== "object" || meta === null) {
    throw new Error("Expected metadata on denied response");
  }
  const error = (meta as Record<string, unknown>).error;
  if (error === undefined || typeof error !== "object" || error === null) {
    throw new Error("Expected error in metadata");
  }
  return error as Record<string, unknown>;
}

/** Helper to create a grant or throw in tests. */
function mustCreateGrant(params: Parameters<typeof createGrant>[0]): DelegationGrant {
  const result = createGrant(params);
  if (!result.ok) throw new Error(`Failed to create grant: ${result.error.message}`);
  return result.value;
}

/** Calls wrapToolCall, asserting it is defined (all delegation middleware has it). */
async function callWrapToolCall(
  mw: KoiMiddleware,
  ctx: TurnContext,
  req: ToolRequest,
  next: (request: ToolRequest) => Promise<ToolResponse>,
): Promise<ToolResponse> {
  const fn = mw.wrapToolCall;
  if (fn === undefined) {
    throw new Error("wrapToolCall is undefined");
  }
  return fn(ctx, req, next);
}

describe("createDelegationMiddleware", () => {
  test("returns a KoiMiddleware with name koi:delegation", () => {
    const mw = createDelegationMiddleware({
      secret: SECRET,
      registry: makeRegistry(),
      grantStore: new Map(),
    });

    expect(mw.name).toBe("koi:delegation");
    expect(mw.wrapToolCall).toBeDefined();
  });

  test("case 1: tool call with valid delegation passes through", async () => {
    const grant = mustCreateGrant({
      issuerId: agentId("agent-1"),
      delegateeId: agentId("agent-2"),
      scope: { permissions: { allow: ["read_file"] } },
      maxChainDepth: 3,
      ttlMs: 3600000,
      secret: SECRET,
    });

    const grantStore = new Map<DelegationId, DelegationGrant>([[grant.id, grant]]);
    const mw = createDelegationMiddleware({
      secret: SECRET,
      registry: makeRegistry(),
      grantStore,
    });

    const ctx = makeTurnContext(grant.id);
    const req = makeToolRequest("read_file");
    const result = await callWrapToolCall(mw, ctx, req, passthrough);

    expect(result.output).toEqual({ success: true, tool: "read_file" });
  });

  test("case 2: tool call with expired delegation returns PERMISSION error", async () => {
    // Fabricate an expired grant directly (createGrant validates ttlMs > 0)
    const unsigned = {
      id: crypto.randomUUID() as DelegationId,
      issuerId: agentId("agent-1"),
      delegateeId: agentId("agent-2"),
      scope: { permissions: { allow: ["read_file"] } },
      chainDepth: 0,
      maxChainDepth: 3,
      createdAt: Date.now() - 2000,
      expiresAt: Date.now() - 1000,
    };
    const proof = signGrant(unsigned, SECRET);
    const grant: DelegationGrant = { ...unsigned, proof };

    const grantStore = new Map<DelegationId, DelegationGrant>([[grant.id, grant]]);
    const mw = createDelegationMiddleware({
      secret: SECRET,
      registry: makeRegistry(),
      grantStore,
    });

    const ctx = makeTurnContext(grant.id);
    const req = makeToolRequest("read_file");
    const result = await callWrapToolCall(mw, ctx, req, passthrough);

    const error = extractError(result);
    expect(error.code).toBe("PERMISSION");
  });

  test("case 3: tool call with revoked delegation returns PERMISSION error", async () => {
    const grant = mustCreateGrant({
      issuerId: agentId("agent-1"),
      delegateeId: agentId("agent-2"),
      scope: { permissions: { allow: ["read_file"] } },
      maxChainDepth: 3,
      ttlMs: 3600000,
      secret: SECRET,
    });

    const revoked = new Set<DelegationId>([grant.id]);
    const grantStore = new Map<DelegationId, DelegationGrant>([[grant.id, grant]]);
    const mw = createDelegationMiddleware({
      secret: SECRET,
      registry: makeRegistry(revoked),
      grantStore,
    });

    const ctx = makeTurnContext(grant.id);
    const req = makeToolRequest("read_file");
    const result = await callWrapToolCall(mw, ctx, req, passthrough);

    const error = extractError(result);
    expect(error.code).toBe("PERMISSION");
  });

  test("case 4: tool call outside delegated scope returns PERMISSION error", async () => {
    const grant = mustCreateGrant({
      issuerId: agentId("agent-1"),
      delegateeId: agentId("agent-2"),
      scope: { permissions: { allow: ["read_file"] } },
      maxChainDepth: 3,
      ttlMs: 3600000,
      secret: SECRET,
    });

    const grantStore = new Map<DelegationId, DelegationGrant>([[grant.id, grant]]);
    const mw = createDelegationMiddleware({
      secret: SECRET,
      registry: makeRegistry(),
      grantStore,
    });

    const ctx = makeTurnContext(grant.id);
    const req = makeToolRequest("execute_command");
    const result = await callWrapToolCall(mw, ctx, req, passthrough);

    const error = extractError(result);
    expect(error.code).toBe("PERMISSION");
  });

  test("case 5: tool call with no delegation context passes through", async () => {
    const mw = createDelegationMiddleware({
      secret: SECRET,
      registry: makeRegistry(),
      grantStore: new Map(),
    });

    const ctx = makeTurnContext(); // no delegationId
    const req = makeToolRequest("read_file");
    const result = await callWrapToolCall(mw, ctx, req, passthrough);

    expect(result.output).toEqual({ success: true, tool: "read_file" });
  });

  test("case 6: unknown delegation ID returns PERMISSION error", async () => {
    const mw = createDelegationMiddleware({
      secret: SECRET,
      registry: makeRegistry(),
      grantStore: new Map(), // Empty store
    });

    const ctx = makeTurnContext("nonexistent-grant-id");
    const req = makeToolRequest("read_file");
    const result = await callWrapToolCall(mw, ctx, req, passthrough);

    const error = extractError(result);
    expect(error.code).toBe("PERMISSION");
  });

  test("case 7: custom ScopeChecker overrides default scope matching", async () => {
    // Grant only allows read_file, but custom checker allows everything
    const grant = mustCreateGrant({
      issuerId: agentId("agent-1"),
      delegateeId: agentId("agent-2"),
      scope: { permissions: { allow: ["read_file"] } },
      maxChainDepth: 3,
      ttlMs: 3600000,
      secret: SECRET,
    });

    const allowAll: ScopeChecker = { isAllowed: () => true };
    const grantStore = new Map<DelegationId, DelegationGrant>([[grant.id, grant]]);
    const mw = createDelegationMiddleware({
      secret: SECRET,
      registry: makeRegistry(),
      grantStore,
      scopeChecker: allowAll,
    });

    const ctx = makeTurnContext(grant.id);
    const req = makeToolRequest("execute_command"); // normally denied
    const result = await callWrapToolCall(mw, ctx, req, passthrough);

    expect(result.output).toEqual({ success: true, tool: "execute_command" });
  });

  test("case 8: custom ScopeChecker can deny normally-allowed tools", async () => {
    const grant = mustCreateGrant({
      issuerId: agentId("agent-1"),
      delegateeId: agentId("agent-2"),
      scope: { permissions: { allow: ["read_file"] } },
      maxChainDepth: 3,
      ttlMs: 3600000,
      secret: SECRET,
    });

    const denyAll: ScopeChecker = { isAllowed: () => false };
    const grantStore = new Map<DelegationId, DelegationGrant>([[grant.id, grant]]);
    const mw = createDelegationMiddleware({
      secret: SECRET,
      registry: makeRegistry(),
      grantStore,
      scopeChecker: denyAll,
    });

    const ctx = makeTurnContext(grant.id);
    const req = makeToolRequest("read_file"); // normally allowed
    const result = await callWrapToolCall(mw, ctx, req, passthrough);

    const error = extractError(result);
    expect(error.code).toBe("PERMISSION");
  });
});

// ---------------------------------------------------------------------------
// Capability verifier integration tests
// ---------------------------------------------------------------------------

function makeVerifier(
  decide: (toolId: string, token: CapabilityToken) => CapabilityVerifyResult,
): CapabilityVerifier {
  return {
    verify(token: CapabilityToken, context: VerifyContext): CapabilityVerifyResult {
      return decide(context.toolId, token);
    },
  };
}

function makeGrantWithSession(
  scope: { readonly allow?: readonly string[]; readonly deny?: readonly string[] },
  sid: string,
): DelegationGrant {
  const now = Date.now();
  const unsigned = {
    id: crypto.randomUUID() as DelegationId,
    issuerId: agentId("agent-1"),
    delegateeId: agentId("agent-2"),
    scope: { permissions: scope, sessionId: sid },
    chainDepth: 0,
    maxChainDepth: 3,
    createdAt: now,
    expiresAt: now + 3600000,
  };
  const proof = signGrant(unsigned, SECRET);
  return { ...unsigned, proof };
}

describe("createDelegationMiddleware — capability verifier path", () => {
  test("routes to verifier when grant has sessionId", async () => {
    const grant = makeGrantWithSession({ allow: ["read_file"] }, "ses-1");
    const verifier = makeVerifier((_toolId, token) => ({ ok: true, token }));

    const mw = createDelegationMiddleware({
      secret: SECRET,
      registry: makeRegistry(),
      grantStore: new Map([[grant.id, grant]]),
      verifier,
    });

    const ctx = makeTurnContext(grant.id);
    const req = makeToolRequest("read_file");
    const result = await callWrapToolCall(mw, ctx, req, passthrough);

    expect(result.output).toEqual({ success: true, tool: "read_file" });
  });

  test("verifier deny returns PERMISSION error", async () => {
    const grant = makeGrantWithSession({ allow: ["read_file"] }, "ses-1");
    const verifier = makeVerifier(() => ({ ok: false, reason: "scope_exceeded" }));

    const mw = createDelegationMiddleware({
      secret: SECRET,
      registry: makeRegistry(),
      grantStore: new Map([[grant.id, grant]]),
      verifier,
    });

    const ctx = makeTurnContext(grant.id);
    const req = makeToolRequest("read_file");
    const result = await callWrapToolCall(mw, ctx, req, passthrough);

    const error = extractError(result);
    expect(error.code).toBe("PERMISSION");
    expect(error.reason).toBe("scope_exceeded");
  });

  test("verifier session_invalid returns PERMISSION error", async () => {
    const grant = makeGrantWithSession({ allow: ["read_file"] }, "ses-1");
    const verifier = makeVerifier(() => ({ ok: false, reason: "session_invalid" }));

    const mw = createDelegationMiddleware({
      secret: SECRET,
      registry: makeRegistry(),
      grantStore: new Map([[grant.id, grant]]),
      verifier,
    });

    const ctx = makeTurnContext(grant.id);
    const req = makeToolRequest("read_file");
    const result = await callWrapToolCall(mw, ctx, req, passthrough);

    const error = extractError(result);
    expect(error.reason).toBe("session_invalid");
  });

  test("falls back to legacy path when grant has no sessionId", async () => {
    const grant = mustCreateGrant({
      issuerId: agentId("agent-1"),
      delegateeId: agentId("agent-2"),
      scope: { permissions: { allow: ["read_file"] } },
      maxChainDepth: 3,
      ttlMs: 3600000,
      secret: SECRET,
    });

    // Verifier that always denies — should NOT be reached
    const verifier = makeVerifier(() => ({ ok: false, reason: "scope_exceeded" }));

    const mw = createDelegationMiddleware({
      secret: SECRET,
      registry: makeRegistry(),
      grantStore: new Map([[grant.id, grant]]),
      verifier,
    });

    const ctx = makeTurnContext(grant.id);
    const req = makeToolRequest("read_file");
    const result = await callWrapToolCall(mw, ctx, req, passthrough);

    // Should pass via legacy path (no sessionId → no verifier routing)
    expect(result.output).toEqual({ success: true, tool: "read_file" });
  });

  test("passes activeSessionIds to verifier context", async () => {
    const grant = makeGrantWithSession({ allow: ["read_file"] }, "ses-1");
    let capturedContext: VerifyContext | undefined;

    const verifier: CapabilityVerifier = {
      verify(_token: CapabilityToken, context: VerifyContext): CapabilityVerifyResult {
        capturedContext = context;
        return { ok: true, token: _token };
      },
    };

    const activeSet = new Set([sessionId("ses-1")]);
    const mw = createDelegationMiddleware({
      secret: SECRET,
      registry: makeRegistry(),
      grantStore: new Map([[grant.id, grant]]),
      verifier,
      activeSessionIds: activeSet,
    });

    const ctx = makeTurnContext(grant.id);
    const req = makeToolRequest("read_file");
    await callWrapToolCall(mw, ctx, req, passthrough);

    expect(capturedContext).toBeDefined();
    expect(capturedContext?.activeSessionIds).toBe(activeSet);
    expect(capturedContext?.toolId).toBe("read_file");
  });

  test("supports activeSessionIds as function", async () => {
    const grant = makeGrantWithSession({ allow: ["read_file"] }, "ses-1");
    let capturedSessionIds: ReadonlySet<SessionId> | undefined;

    const verifier: CapabilityVerifier = {
      verify(_token: CapabilityToken, context: VerifyContext): CapabilityVerifyResult {
        capturedSessionIds = context.activeSessionIds;
        return { ok: true, token: _token };
      },
    };

    const activeSet = new Set([sessionId("ses-1")]);
    const mw = createDelegationMiddleware({
      secret: SECRET,
      registry: makeRegistry(),
      grantStore: new Map([[grant.id, grant]]),
      verifier,
      activeSessionIds: () => activeSet,
    });

    const ctx = makeTurnContext(grant.id);
    const req = makeToolRequest("read_file");
    await callWrapToolCall(mw, ctx, req, passthrough);

    expect(capturedSessionIds).toBe(activeSet);
  });

  test("creates singleton session set when activeSessionIds not provided", async () => {
    const grant = makeGrantWithSession({ allow: ["read_file"] }, "ses-1");
    let capturedSessionIds: ReadonlySet<SessionId> | undefined;

    const verifier: CapabilityVerifier = {
      verify(_token: CapabilityToken, context: VerifyContext): CapabilityVerifyResult {
        capturedSessionIds = context.activeSessionIds;
        return { ok: true, token: _token };
      },
    };

    const mw = createDelegationMiddleware({
      secret: SECRET,
      registry: makeRegistry(),
      grantStore: new Map([[grant.id, grant]]),
      verifier,
      // no activeSessionIds
    });

    const ctx = makeTurnContext(grant.id);
    const req = makeToolRequest("read_file");
    await callWrapToolCall(mw, ctx, req, passthrough);

    // Should create a set with the token's sessionId
    expect(capturedSessionIds).toBeDefined();
    expect(capturedSessionIds?.has(sessionId("ses-1"))).toBe(true);
    expect(capturedSessionIds?.size).toBe(1);
  });

  test("no verifier configured falls back to legacy path for session grants", async () => {
    const grant = makeGrantWithSession({ allow: ["read_file"] }, "ses-1");

    const mw = createDelegationMiddleware({
      secret: SECRET,
      registry: makeRegistry(),
      grantStore: new Map([[grant.id, grant]]),
      // no verifier
    });

    const ctx = makeTurnContext(grant.id);
    const req = makeToolRequest("read_file");
    const result = await callWrapToolCall(mw, ctx, req, passthrough);

    // Legacy path still works
    expect(result.output).toEqual({ success: true, tool: "read_file" });
  });

  test("verifier async verify is awaited", async () => {
    const grant = makeGrantWithSession({ allow: ["read_file"] }, "ses-1");

    const verifier: CapabilityVerifier = {
      verify(_token: CapabilityToken, _context: VerifyContext): Promise<CapabilityVerifyResult> {
        return Promise.resolve({ ok: true, token: _token });
      },
    };

    const mw = createDelegationMiddleware({
      secret: SECRET,
      registry: makeRegistry(),
      grantStore: new Map([[grant.id, grant]]),
      verifier,
    });

    const ctx = makeTurnContext(grant.id);
    const req = makeToolRequest("read_file");
    const result = await callWrapToolCall(mw, ctx, req, passthrough);

    expect(result.output).toEqual({ success: true, tool: "read_file" });
  });

  test("unknown grant with verifier returns PERMISSION error", async () => {
    const verifier = makeVerifier((_toolId, token) => ({ ok: true, token }));

    const mw = createDelegationMiddleware({
      secret: SECRET,
      registry: makeRegistry(),
      grantStore: new Map(),
      verifier,
    });

    const ctx = makeTurnContext("nonexistent-grant");
    const req = makeToolRequest("read_file");
    const result = await callWrapToolCall(mw, ctx, req, passthrough);

    const error = extractError(result);
    expect(error.code).toBe("PERMISSION");
  });
});
