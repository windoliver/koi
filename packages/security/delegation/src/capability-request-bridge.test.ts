/**
 * Unit tests for the capability request bridge.
 *
 * Verifies Tier 1 (auto-grant), Tier 2 (HITL/bubble-up), and edge cases.
 */

import { afterEach, describe, expect, test } from "bun:test";
import type {
  Agent,
  AgentMessage,
  AgentMessageInput,
  ApprovalDecision,
  ApprovalRequest,
  DelegationComponent,
  JsonObject,
  MailboxComponent,
  SessionContext,
  TurnContext,
} from "@koi/core";
import {
  agentId,
  DEFAULT_CIRCUIT_BREAKER_CONFIG,
  DELEGATION,
  isAttachResult,
  MAILBOX,
  messageId,
} from "@koi/core";
import { createCapabilityRequestBridge } from "./capability-request-bridge.js";
import {
  CAPABILITY_REQUEST_TYPE,
  CAPABILITY_RESPONSE_STATUS,
} from "./capability-request-constants.js";
import { createDelegationManager } from "./delegation-manager.js";

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const SECRET = "test-secret-key-32-bytes-minimum";
const DEFAULT_CONFIG = {
  secret: SECRET,
  maxChainDepth: 3,
  defaultTtlMs: 3600000,
  circuitBreaker: DEFAULT_CIRCUIT_BREAKER_CONFIG,
} as const;

// ---------------------------------------------------------------------------
// Mock mailbox
// ---------------------------------------------------------------------------

interface MockMailbox extends MailboxComponent {
  readonly sentMessages: AgentMessageInput[];
  readonly triggerMessage: (message: AgentMessage) => Promise<void>;
}

function createMockMailbox(): MockMailbox {
  const handlers: Array<(message: AgentMessage) => void | Promise<void>> = [];
  const sentMessages: AgentMessageInput[] = [];
  let nextId = 1;

  return {
    sentMessages,
    send: async (input: AgentMessageInput) => {
      sentMessages.push(input);
      const msg: AgentMessage = {
        ...input,
        id: messageId(`msg-${nextId++}`),
        createdAt: new Date().toISOString(),
      };
      return { ok: true as const, value: msg };
    },
    onMessage: (handler) => {
      handlers.push(handler);
      return () => {
        const idx = handlers.indexOf(handler);
        if (idx >= 0) handlers.splice(idx, 1);
      };
    },
    list: async () => [],
    triggerMessage: async (message: AgentMessage) => {
      for (const h of [...handlers]) await h(message);
    },
  };
}

// ---------------------------------------------------------------------------
// Mock delegation component
// ---------------------------------------------------------------------------

function createMockDelegationComponent(): DelegationComponent {
  return {
    grant: async () => {
      throw new Error("not implemented");
    },
    revoke: async () => {},
    verify: async () => ({ ok: false as const, reason: "unknown_grant" as const }),
    list: async () => [],
  };
}

// ---------------------------------------------------------------------------
// Mock agent
// ---------------------------------------------------------------------------

function createMockAgent(
  id: string,
  mailbox: MailboxComponent,
  delegation: DelegationComponent,
  parentId?: string,
): Agent {
  const components = new Map<string, unknown>();
  components.set(MAILBOX as string, mailbox);
  components.set(DELEGATION as string, delegation);

  return {
    pid: {
      id: agentId(id),
      parent: parentId !== undefined ? agentId(parentId) : undefined,
      runId: "run-1",
      sessionId: "session-1",
      depth: parentId !== undefined ? 1 : 0,
    },
    manifest: {} as Agent["manifest"],
    state: "running",
    component: <T>(token: { toString(): string }) =>
      components.get(token as string) as T | undefined,
    has: (token: unknown) => components.has(token as string),
    query: () => new Map(),
    components: () => components,
  } as unknown as Agent;
}

// ---------------------------------------------------------------------------
// Mock turn context
// ---------------------------------------------------------------------------

function createMockTurnContext(
  currentAgentId: string,
  requestApproval?: (req: ApprovalRequest) => Promise<ApprovalDecision>,
): TurnContext {
  const base = {
    session: {
      agentId: agentId(currentAgentId),
    } as unknown as SessionContext,
    turnIndex: 0,
    turnId: "turn-1" as TurnContext["turnId"],
    messages: [],
    metadata: {},
    ...(requestApproval !== undefined ? { requestApproval } : {}),
  };
  return base as unknown as TurnContext;
}

// ---------------------------------------------------------------------------
// Helper: create a capability request message
// ---------------------------------------------------------------------------

function createCapabilityRequestMessage(
  from: string,
  to: string,
  overrides?: Partial<{
    requesterId: string;
    _originalCorrelationId: string;
    _forwardDepth: number;
  }>,
): AgentMessage {
  return {
    id: messageId("req-1"),
    from: agentId(from),
    to: agentId(to),
    kind: "request",
    createdAt: new Date().toISOString(),
    type: CAPABILITY_REQUEST_TYPE,
    payload: {
      permissions: { allow: ["read_file"] },
      reason: "Need file access",
      ...(overrides?.requesterId !== undefined ? { requesterId: overrides.requesterId } : {}),
      ...(overrides?._originalCorrelationId !== undefined
        ? { _originalCorrelationId: overrides._originalCorrelationId }
        : {}),
      ...(overrides?._forwardDepth !== undefined ? { _forwardDepth: overrides._forwardDepth } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createCapabilityRequestBridge", () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    for (const fn of cleanups) fn();
    cleanups.length = 0;
  });

  test("Tier 1: auto-grants when canAutoGrant returns true", async () => {
    const manager = createDelegationManager({ config: DEFAULT_CONFIG });
    cleanups.push(manager.dispose);

    const bridge = createCapabilityRequestBridge({
      manager,
      canAutoGrant: () => true,
    });

    const mailbox = createMockMailbox();
    const delegation = createMockDelegationComponent();
    const agent = createMockAgent("parent", mailbox, delegation);

    await bridge.provider.attach(agent);

    // Trigger incoming capability request
    const request = createCapabilityRequestMessage("child", "parent");
    await mailbox.triggerMessage(request);

    // Should have sent a granted response
    const responses = mailbox.sentMessages.filter(
      (m) =>
        m.kind === "response" &&
        (m.payload as JsonObject).status === CAPABILITY_RESPONSE_STATUS.GRANTED,
    );
    expect(responses).toHaveLength(1);
    expect(responses[0]?.payload).toHaveProperty("grantId");
  });

  test("Tier 1: queues request when canAutoGrant not provided", async () => {
    const manager = createDelegationManager({ config: DEFAULT_CONFIG });
    cleanups.push(manager.dispose);

    const bridge = createCapabilityRequestBridge({ manager });

    const mailbox = createMockMailbox();
    const delegation = createMockDelegationComponent();
    const agent = createMockAgent("parent", mailbox, delegation);

    await bridge.provider.attach(agent);

    const request = createCapabilityRequestMessage("child", "parent");
    await mailbox.triggerMessage(request);

    // No response sent (queued for Tier 2)
    const responses = mailbox.sentMessages.filter((m) => m.kind === "response");
    expect(responses).toHaveLength(0);
  });

  test("Tier 1: queues request when canAutoGrant returns false", async () => {
    const manager = createDelegationManager({ config: DEFAULT_CONFIG });
    cleanups.push(manager.dispose);

    const bridge = createCapabilityRequestBridge({
      manager,
      canAutoGrant: () => false,
    });

    const mailbox = createMockMailbox();
    const delegation = createMockDelegationComponent();
    const agent = createMockAgent("parent", mailbox, delegation);

    await bridge.provider.attach(agent);

    const request = createCapabilityRequestMessage("child", "parent");
    await mailbox.triggerMessage(request);

    // No response sent (queued for Tier 2)
    const responses = mailbox.sentMessages.filter((m) => m.kind === "response");
    expect(responses).toHaveLength(0);
  });

  test("Tier 2: HITL approve → grants and responds", async () => {
    const manager = createDelegationManager({ config: DEFAULT_CONFIG });
    cleanups.push(manager.dispose);

    const bridge = createCapabilityRequestBridge({ manager });

    const mailbox = createMockMailbox();
    const delegation = createMockDelegationComponent();
    const agent = createMockAgent("parent", mailbox, delegation);

    await bridge.provider.attach(agent);

    // Queue a request
    const request = createCapabilityRequestMessage("child", "parent");
    await mailbox.triggerMessage(request);

    // Process in Tier 2 with HITL approval
    const ctx = createMockTurnContext("parent", async () => ({ kind: "allow" }));
    await bridge.middleware.onBeforeTurn?.(ctx);

    const responses = mailbox.sentMessages.filter(
      (m) =>
        m.kind === "response" &&
        (m.payload as JsonObject).status === CAPABILITY_RESPONSE_STATUS.GRANTED,
    );
    expect(responses).toHaveLength(1);
  });

  test("Tier 2: HITL deny → sends denial response", async () => {
    const manager = createDelegationManager({ config: DEFAULT_CONFIG });
    cleanups.push(manager.dispose);

    const bridge = createCapabilityRequestBridge({ manager });

    const mailbox = createMockMailbox();
    const delegation = createMockDelegationComponent();
    const agent = createMockAgent("parent", mailbox, delegation);

    await bridge.provider.attach(agent);

    const request = createCapabilityRequestMessage("child", "parent");
    await mailbox.triggerMessage(request);

    const ctx = createMockTurnContext("parent", async () => ({
      kind: "deny",
      reason: "Not authorized",
    }));
    await bridge.middleware.onBeforeTurn?.(ctx);

    const responses = mailbox.sentMessages.filter(
      (m) =>
        m.kind === "response" &&
        (m.payload as JsonObject).status === CAPABILITY_RESPONSE_STATUS.DENIED,
    );
    expect(responses).toHaveLength(1);
    expect((responses[0]?.payload as JsonObject).reason).toBe("Not authorized");
  });

  test("Tier 2: HITL modify → grants with narrowed scope", async () => {
    const manager = createDelegationManager({ config: DEFAULT_CONFIG });
    cleanups.push(manager.dispose);

    const bridge = createCapabilityRequestBridge({ manager });

    const mailbox = createMockMailbox();
    const delegation = createMockDelegationComponent();
    const agent = createMockAgent("parent", mailbox, delegation);

    await bridge.provider.attach(agent);

    // Request read_file and write_file
    const request: AgentMessage = {
      id: messageId("req-modify"),
      from: agentId("child"),
      to: agentId("parent"),
      kind: "request",
      createdAt: new Date().toISOString(),
      type: CAPABILITY_REQUEST_TYPE,
      payload: {
        permissions: { allow: ["read_file", "write_file"] },
        reason: "Need full access",
      },
    };
    await mailbox.triggerMessage(request);

    // Human narrows to read_file only
    const ctx = createMockTurnContext("parent", async () => ({
      kind: "modify",
      updatedInput: {
        permissions: { allow: ["read_file"] },
        reason: "Narrowed to read only",
      },
    }));
    await bridge.middleware.onBeforeTurn?.(ctx);

    const responses = mailbox.sentMessages.filter(
      (m) =>
        m.kind === "response" &&
        (m.payload as JsonObject).status === CAPABILITY_RESPONSE_STATUS.GRANTED,
    );
    expect(responses).toHaveLength(1);
  });

  test("Tier 2: bubble-up to parent when no requestApproval", async () => {
    const manager = createDelegationManager({ config: DEFAULT_CONFIG });
    cleanups.push(manager.dispose);

    const bridge = createCapabilityRequestBridge({ manager });

    const mailbox = createMockMailbox();
    const delegation = createMockDelegationComponent();
    const agent = createMockAgent("child-agent", mailbox, delegation, "parent-agent");

    await bridge.provider.attach(agent);

    const request = createCapabilityRequestMessage("grandchild", "child-agent");
    await mailbox.triggerMessage(request);

    // No requestApproval → should bubble up
    const ctx = createMockTurnContext("child-agent");
    await bridge.middleware.onBeforeTurn?.(ctx);

    // Should have forwarded to parent
    const forwarded = mailbox.sentMessages.filter(
      (m) => m.kind === "request" && m.to === agentId("parent-agent"),
    );
    expect(forwarded).toHaveLength(1);
    expect((forwarded[0]?.payload as JsonObject).requesterId).toBe("grandchild");
    expect((forwarded[0]?.payload as JsonObject)._forwardDepth).toBe(1);
  });

  test("Tier 2: denies at root agent (no parent, no HITL)", async () => {
    const manager = createDelegationManager({ config: DEFAULT_CONFIG });
    cleanups.push(manager.dispose);

    const bridge = createCapabilityRequestBridge({ manager });

    const mailbox = createMockMailbox();
    const delegation = createMockDelegationComponent();
    // Root agent — no parent
    const agent = createMockAgent("root", mailbox, delegation);

    await bridge.provider.attach(agent);

    const request = createCapabilityRequestMessage("child", "root");
    await mailbox.triggerMessage(request);

    const ctx = createMockTurnContext("root");
    await bridge.middleware.onBeforeTurn?.(ctx);

    const responses = mailbox.sentMessages.filter(
      (m) =>
        m.kind === "response" &&
        (m.payload as JsonObject).status === CAPABILITY_RESPONSE_STATUS.DENIED,
    );
    expect(responses).toHaveLength(1);
    expect((responses[0]?.payload as JsonObject).reason).toContain("No approval handler");
  });

  test("Tier 2: denies when forward depth exceeded", async () => {
    const manager = createDelegationManager({ config: DEFAULT_CONFIG });
    cleanups.push(manager.dispose);

    const bridge = createCapabilityRequestBridge({
      manager,
      maxForwardDepth: 2,
    });

    const mailbox = createMockMailbox();
    const delegation = createMockDelegationComponent();
    const agent = createMockAgent("mid-agent", mailbox, delegation, "parent-agent");

    await bridge.provider.attach(agent);

    // Request already at depth 2 (== maxForwardDepth)
    const request = createCapabilityRequestMessage("original", "mid-agent", {
      requesterId: "original",
      _forwardDepth: 2,
    });
    await mailbox.triggerMessage(request);

    const ctx = createMockTurnContext("mid-agent");
    await bridge.middleware.onBeforeTurn?.(ctx);

    const responses = mailbox.sentMessages.filter(
      (m) =>
        m.kind === "response" &&
        (m.payload as JsonObject).status === CAPABILITY_RESPONSE_STATUS.DENIED,
    );
    expect(responses).toHaveLength(1);
    expect((responses[0]?.payload as JsonObject).reason).toContain("forward depth");
  });

  test("provider skips when MAILBOX not attached", async () => {
    const manager = createDelegationManager({ config: DEFAULT_CONFIG });
    cleanups.push(manager.dispose);

    const bridge = createCapabilityRequestBridge({ manager });

    // Agent without mailbox
    const components = new Map<string, unknown>();
    components.set(DELEGATION as string, createMockDelegationComponent());

    const agent = {
      pid: { id: agentId("no-mailbox"), parent: undefined, runId: "r", sessionId: "s", depth: 0 },
      manifest: {},
      state: "running",
      component: <T>(token: { toString(): string }) =>
        components.get(token as string) as T | undefined,
      has: (token: unknown) => components.has(token as string),
      query: () => new Map(),
      components: () => components,
    } as unknown as Agent;

    const result = await bridge.provider.attach(agent);
    const attached = isAttachResult(result) ? result.components : result;
    expect(attached.size).toBe(0);
  });

  test("provider skips when DELEGATION not attached", async () => {
    const manager = createDelegationManager({ config: DEFAULT_CONFIG });
    cleanups.push(manager.dispose);

    const bridge = createCapabilityRequestBridge({ manager });

    // Agent without delegation
    const components = new Map<string, unknown>();
    components.set(MAILBOX as string, createMockMailbox());

    const agent = {
      pid: {
        id: agentId("no-delegation"),
        parent: undefined,
        runId: "r",
        sessionId: "s",
        depth: 0,
      },
      manifest: {},
      state: "running",
      component: <T>(token: { toString(): string }) =>
        components.get(token as string) as T | undefined,
      has: (token: unknown) => components.has(token as string),
      query: () => new Map(),
      components: () => components,
    } as unknown as Agent;

    const result = await bridge.provider.attach(agent);
    const attached = isAttachResult(result) ? result.components : result;
    expect(attached.size).toBe(0);
  });

  test("responds to original requesterId on forwarded requests", async () => {
    const manager = createDelegationManager({ config: DEFAULT_CONFIG });
    cleanups.push(manager.dispose);

    const bridge = createCapabilityRequestBridge({
      manager,
      canAutoGrant: () => true,
    });

    const mailbox = createMockMailbox();
    const delegation = createMockDelegationComponent();
    const agent = createMockAgent("parent", mailbox, delegation);

    await bridge.provider.attach(agent);

    // Forwarded request: from=mid-agent, but requesterId=original-child
    const request = createCapabilityRequestMessage("mid-agent", "parent", {
      requesterId: "original-child",
      _originalCorrelationId: "orig-corr-1",
      _forwardDepth: 1,
    });
    await mailbox.triggerMessage(request);

    // Response should go to original-child, not mid-agent
    const responses = mailbox.sentMessages.filter(
      (m) =>
        m.kind === "response" &&
        (m.payload as JsonObject).status === CAPABILITY_RESPONSE_STATUS.GRANTED,
    );
    expect(responses).toHaveLength(1);
    expect(responses[0]?.to).toBe(agentId("original-child"));
    expect(responses[0]?.correlationId).toBe(messageId("orig-corr-1"));
  });

  test("middleware is no-op when no pending requests", async () => {
    const manager = createDelegationManager({ config: DEFAULT_CONFIG });
    cleanups.push(manager.dispose);

    const bridge = createCapabilityRequestBridge({ manager });
    const ctx = createMockTurnContext("some-agent");

    // Should not throw
    await bridge.middleware.onBeforeTurn?.(ctx);
  });

  test("describeCapabilities returns correct fragment", () => {
    const manager = createDelegationManager({ config: DEFAULT_CONFIG });
    cleanups.push(manager.dispose);

    const bridge = createCapabilityRequestBridge({ manager });
    const ctx = createMockTurnContext("agent");
    const caps = bridge.middleware.describeCapabilities(ctx);

    expect(caps).toBeDefined();
    expect(caps?.label).toBe("cap-requests");
  });
});
