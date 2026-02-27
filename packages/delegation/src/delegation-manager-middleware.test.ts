/**
 * DelegationManager-integrated middleware tests.
 *
 * Tests the enhanced middleware that uses DelegationManager for
 * circuit breaker checks, event emission, and lifecycle binding.
 */

import { afterEach, describe, expect, test } from "bun:test";
import type {
  DelegationEvent,
  KoiMiddleware,
  ToolRequest,
  ToolResponse,
  TurnContext,
} from "@koi/core";
import { agentId, DEFAULT_CIRCUIT_BREAKER_CONFIG, runId, sessionId, turnId } from "@koi/core";
import { createDelegationManager } from "./delegation-manager.js";
import { createDelegationMiddleware } from "./middleware.js";

const SECRET = "test-secret-key-32-bytes-minimum";
const DEFAULT_CONFIG = {
  secret: SECRET,
  maxChainDepth: 3,
  defaultTtlMs: 3600000,
  circuitBreaker: DEFAULT_CIRCUIT_BREAKER_CONFIG,
} as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("DelegationManager middleware integration", () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    for (const fn of cleanups) {
      fn();
    }
    cleanups.length = 0;
  });

  test("valid delegation passes through via manager", async () => {
    const manager = createDelegationManager({ config: DEFAULT_CONFIG });
    cleanups.push(manager.dispose);

    const grantResult = manager.grant(agentId("agent-1"), agentId("agent-2"), {
      permissions: { allow: ["read_file"] },
    });
    expect(grantResult.ok).toBe(true);
    if (!grantResult.ok) return;

    const mw = createDelegationMiddleware({
      secret: SECRET,
      registry: { isRevoked: () => false, revoke: () => {} },
      grantStore: new Map([[grantResult.value.id, grantResult.value]]),
    });

    const ctx = makeTurnContext(grantResult.value.id);
    const req = makeToolRequest("read_file");
    const result = await callWrapToolCall(mw, ctx, req, passthrough);

    expect(result.output).toEqual({ success: true, tool: "read_file" });
  });

  test("manager verify detects revoked grants via middleware", async () => {
    const manager = createDelegationManager({ config: DEFAULT_CONFIG });
    cleanups.push(manager.dispose);

    const grantResult = manager.grant(agentId("agent-1"), agentId("agent-2"), {
      permissions: { allow: ["read_file"] },
    });
    expect(grantResult.ok).toBe(true);
    if (!grantResult.ok) return;

    // Revoke the grant through the manager
    await manager.revoke(grantResult.value.id);

    // Verify should fail
    const verifyResult = await manager.verify(grantResult.value.id, "read_file");
    expect(verifyResult.ok).toBe(false);
    if (!verifyResult.ok) {
      expect(verifyResult.reason).toBe("unknown_grant");
    }
  });

  test("circuit breaker integration — open circuit fast-fails", () => {
    const manager = createDelegationManager({
      config: {
        ...DEFAULT_CONFIG,
        circuitBreaker: { failureThreshold: 2, resetTimeoutMs: 30_000, halfOpenMaxProbes: 1 },
      },
    });
    cleanups.push(manager.dispose);

    // Trip the circuit
    manager.recordFailure(agentId("agent-2"));
    manager.recordFailure(agentId("agent-2"));

    expect(manager.canDelegate(agentId("agent-2"))).toBe(false);
    expect(manager.circuitState(agentId("agent-2"))).toBe("open");
  });

  test("emits delegation:denied event on verification failure", async () => {
    const events: DelegationEvent[] = [];
    const manager = createDelegationManager({
      config: DEFAULT_CONFIG,
      onEvent: (e) => events.push(e),
    });
    cleanups.push(manager.dispose);

    const grantResult = manager.grant(agentId("agent-1"), agentId("agent-2"), {
      permissions: { allow: ["read_file"] },
    });
    expect(grantResult.ok).toBe(true);
    if (!grantResult.ok) return;

    // Verify for a tool outside scope
    await manager.verify(grantResult.value.id, "exec");

    const deniedEvents = events.filter((e) => e.kind === "delegation:denied");
    expect(deniedEvents).toHaveLength(1);
    if (deniedEvents[0]?.kind === "delegation:denied") {
      expect(deniedEvents[0].reason).toBe("scope_exceeded");
      expect(deniedEvents[0].toolId).toBe("exec");
    }
  });

  test("emits delegation:circuit_opened event when threshold reached", () => {
    const events: DelegationEvent[] = [];
    const manager = createDelegationManager({
      config: {
        ...DEFAULT_CONFIG,
        circuitBreaker: { failureThreshold: 2, resetTimeoutMs: 30_000, halfOpenMaxProbes: 1 },
      },
      onEvent: (e) => events.push(e),
    });
    cleanups.push(manager.dispose);

    manager.recordFailure(agentId("agent-2"));
    manager.recordFailure(agentId("agent-2"));

    const circuitEvents = events.filter((e) => e.kind === "delegation:circuit_opened");
    expect(circuitEvents).toHaveLength(1);
    if (circuitEvents[0]?.kind === "delegation:circuit_opened") {
      expect(circuitEvents[0].delegateeId).toBe("agent-2");
      expect(circuitEvents[0].failureCount).toBe(2);
    }
  });

  test("emits delegation:granted event on new grant", () => {
    const events: DelegationEvent[] = [];
    const manager = createDelegationManager({
      config: DEFAULT_CONFIG,
      onEvent: (e) => events.push(e),
    });
    cleanups.push(manager.dispose);

    manager.grant(agentId("agent-1"), agentId("agent-2"), {
      permissions: { allow: ["read_file"] },
    });

    const grantedEvents = events.filter((e) => e.kind === "delegation:granted");
    expect(grantedEvents).toHaveLength(1);
  });
});
