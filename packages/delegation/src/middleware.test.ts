import { describe, expect, test } from "bun:test";
import type {
  DelegationGrant,
  DelegationId,
  KoiMiddleware,
  RevocationRegistry,
  ScopeChecker,
  ToolRequest,
  ToolResponse,
  TurnContext,
} from "@koi/core";
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
    revokedIds: () => revoked,
  };
}

function makeTurnContext(delegationId?: string): TurnContext {
  return {
    session: {
      agentId: "agent-1",
      sessionId: "session-1",
      metadata: delegationId !== undefined ? { delegationId } : {},
    },
    turnIndex: 0,
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
    const grant = createGrant({
      issuerId: "agent-1",
      delegateeId: "agent-2",
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
      issuerId: "agent-1",
      delegateeId: "agent-2",
      scope: { permissions: { allow: ["read_file"] } },
      chainDepth: 0,
      maxChainDepth: 3,
      createdAt: Date.now() - 2000,
      expiresAt: Date.now() - 1000,
    };
    const signature = signGrant(unsigned, SECRET);
    const grant: DelegationGrant = { ...unsigned, signature };

    const grantStore = new Map<DelegationId, DelegationGrant>([[grant.id, grant]]);
    const mw = createDelegationMiddleware({
      secret: SECRET,
      registry: makeRegistry(),
      grantStore,
    });

    const ctx = makeTurnContext(grant.id);
    const req = makeToolRequest("read_file");
    const result = await callWrapToolCall(mw, ctx, req, passthrough);

    expect(result.metadata).toBeDefined();
    const meta = result.metadata as Record<string, unknown>;
    expect(meta.error).toBeDefined();
    const error = meta.error as Record<string, unknown>;
    expect(error.code).toBe("PERMISSION");
  });

  test("case 3: tool call with revoked delegation returns PERMISSION error", async () => {
    const grant = createGrant({
      issuerId: "agent-1",
      delegateeId: "agent-2",
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

    const error = (result.metadata as Record<string, unknown>).error as Record<string, unknown>;
    expect(error.code).toBe("PERMISSION");
  });

  test("case 4: tool call outside delegated scope returns PERMISSION error", async () => {
    const grant = createGrant({
      issuerId: "agent-1",
      delegateeId: "agent-2",
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

    const error = (result.metadata as Record<string, unknown>).error as Record<string, unknown>;
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

    const error = (result.metadata as Record<string, unknown>).error as Record<string, unknown>;
    expect(error.code).toBe("PERMISSION");
  });

  test("case 7: custom ScopeChecker overrides default scope matching", async () => {
    // Grant only allows read_file, but custom checker allows everything
    const grant = createGrant({
      issuerId: "agent-1",
      delegateeId: "agent-2",
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
    const grant = createGrant({
      issuerId: "agent-1",
      delegateeId: "agent-2",
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

    const error = (result.metadata as Record<string, unknown>).error as Record<string, unknown>;
    expect(error.code).toBe("PERMISSION");
  });
});
