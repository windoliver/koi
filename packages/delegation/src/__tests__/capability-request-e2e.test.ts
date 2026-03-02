/**
 * End-to-end integration tests for the capability request pull model.
 *
 * Tests the full flow: delegation_request tool → Mailbox → bridge handler → response.
 * Uses mock mailboxes with message routing between agents.
 */

import { afterEach, describe, expect, test } from "bun:test";
import type {
  Agent,
  AgentMessage,
  AgentMessageInput,
  ApprovalDecision,
  ApprovalRequest,
  DelegationComponent,
  MailboxComponent,
  SessionContext,
  TurnContext,
} from "@koi/core";
import { agentId, DEFAULT_CIRCUIT_BREAKER_CONFIG, DELEGATION, MAILBOX, messageId } from "@koi/core";
import { createCapabilityRequestBridge } from "../capability-request-bridge.js";
import { createDelegationManager } from "../delegation-manager.js";
import { createDelegationRequestTool } from "../tools/request.js";

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const SECRET = "test-secret-key-32-bytes-minimum";
const DEFAULT_CONFIG = {
  secret: SECRET,
  maxChainDepth: 5,
  defaultTtlMs: 3600000,
  circuitBreaker: DEFAULT_CIRCUIT_BREAKER_CONFIG,
} as const;

// ---------------------------------------------------------------------------
// Mock mailbox router — routes messages between agents
// ---------------------------------------------------------------------------

interface MailboxRouter {
  readonly createMailbox: (ownerId: string) => MockMailbox;
  readonly route: (msg: AgentMessage) => Promise<void>;
}

interface MockMailbox extends MailboxComponent {
  readonly sentMessages: AgentMessageInput[];
}

function createMailboxRouter(): MailboxRouter {
  const mailboxes = new Map<
    string,
    {
      readonly handlers: Array<(msg: AgentMessage) => void | Promise<void>>;
      readonly sentMessages: AgentMessageInput[];
    }
  >();
  let nextId = 1;

  const route = async (msg: AgentMessage): Promise<void> => {
    const target = mailboxes.get(msg.to);
    if (target === undefined) return;
    for (const h of [...target.handlers]) await h(msg);
  };

  return {
    route,
    createMailbox: (ownerId: string): MockMailbox => {
      const entry = {
        handlers: [] as Array<(msg: AgentMessage) => void | Promise<void>>,
        sentMessages: [] as AgentMessageInput[],
      };
      mailboxes.set(ownerId, entry);

      return {
        sentMessages: entry.sentMessages,
        send: async (input: AgentMessageInput) => {
          entry.sentMessages.push(input);
          const msg: AgentMessage = {
            ...input,
            id: messageId(`msg-${nextId++}`),
            createdAt: new Date().toISOString(),
          };
          // Route asynchronously to simulate real delivery
          setTimeout(() => route(msg), 0);
          return { ok: true as const, value: msg };
        },
        onMessage: (handler) => {
          entry.handlers.push(handler);
          return () => {
            const idx = entry.handlers.indexOf(handler);
            if (idx >= 0) entry.handlers.splice(idx, 1);
          };
        },
        list: async () => [],
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Mock agent factory
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

function createMockTurnContext(
  currentAgentId: string,
  requestApproval?: (req: ApprovalRequest) => Promise<ApprovalDecision>,
): TurnContext {
  return {
    session: { agentId: agentId(currentAgentId) } as SessionContext,
    turnIndex: 0,
    turnId: "turn-1" as TurnContext["turnId"],
    messages: [],
    metadata: {},
    requestApproval,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("capability request E2E", () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    for (const fn of cleanups) fn();
    cleanups.length = 0;
  });

  test("auto-grant: request → grant → response", async () => {
    const manager = createDelegationManager({ config: DEFAULT_CONFIG });
    cleanups.push(manager.dispose);

    const router = createMailboxRouter();
    const childMailbox = router.createMailbox("child");
    const parentMailbox = router.createMailbox("parent");

    // Set up bridge on parent with auto-grant
    const bridge = createCapabilityRequestBridge({
      manager,
      canAutoGrant: () => true,
    });

    const parentAgent = createMockAgent("parent", parentMailbox, createMockDelegationComponent());
    await bridge.provider.attach(parentAgent);

    // Child uses delegation_request tool
    const requestTool = createDelegationRequestTool(
      childMailbox,
      agentId("child"),
      "delegation",
      "verified",
    );

    const resultPromise = requestTool.execute({
      targetAgentId: "parent",
      permissions: { allow: ["read_file"] },
      reason: "Need file access for analysis",
      timeoutMs: 5000,
    });

    const result = (await resultPromise) as { granted: boolean; grantId?: string };
    expect(result.granted).toBe(true);
    expect(result.grantId).toBeDefined();
  });

  test("HITL: request → pending → human approves → response", async () => {
    const manager = createDelegationManager({ config: DEFAULT_CONFIG });
    cleanups.push(manager.dispose);

    const router = createMailboxRouter();
    const childMailbox = router.createMailbox("child");
    const parentMailbox = router.createMailbox("parent");

    const bridge = createCapabilityRequestBridge({ manager });

    const parentAgent = createMockAgent("parent", parentMailbox, createMockDelegationComponent());
    await bridge.provider.attach(parentAgent);

    // Child sends request
    const requestTool = createDelegationRequestTool(
      childMailbox,
      agentId("child"),
      "delegation",
      "verified",
    );
    const resultPromise = requestTool.execute({
      targetAgentId: "parent",
      permissions: { allow: ["read_file"] },
      reason: "Need to read config files",
      timeoutMs: 5000,
    });

    // Wait for message delivery
    await new Promise((r) => setTimeout(r, 50));

    // Parent processes Tier 2 with HITL approval
    const ctx = createMockTurnContext("parent", async () => ({ kind: "allow" }));
    await bridge.middleware.onBeforeTurn?.(ctx);

    const result = (await resultPromise) as { granted: boolean; grantId?: string };
    expect(result.granted).toBe(true);
    expect(result.grantId).toBeDefined();
  });

  test("bubble-up: child → parent → human approves → response to original requester", async () => {
    const manager = createDelegationManager({ config: DEFAULT_CONFIG });
    cleanups.push(manager.dispose);

    const router = createMailboxRouter();
    const grandchildMailbox = router.createMailbox("grandchild");
    const childMailbox = router.createMailbox("child");
    const parentMailbox = router.createMailbox("parent");

    const bridge = createCapabilityRequestBridge({ manager });

    // Wire up child agent (has parent)
    const childAgent = createMockAgent(
      "child",
      childMailbox,
      createMockDelegationComponent(),
      "parent",
    );
    await bridge.provider.attach(childAgent);

    // Wire up parent agent (root)
    const parentAgent = createMockAgent("parent", parentMailbox, createMockDelegationComponent());
    await bridge.provider.attach(parentAgent);

    // Grandchild sends request to child
    const requestTool = createDelegationRequestTool(
      grandchildMailbox,
      agentId("grandchild"),
      "delegation",
      "verified",
    );
    const resultPromise = requestTool.execute({
      targetAgentId: "child",
      permissions: { allow: ["read_file"] },
      reason: "Need read access",
      timeoutMs: 5000,
    });

    // Wait for message delivery
    await new Promise((r) => setTimeout(r, 50));

    // Child has no HITL → should bubble up
    const childCtx = createMockTurnContext("child");
    await bridge.middleware.onBeforeTurn?.(childCtx);

    // Wait for forward delivery
    await new Promise((r) => setTimeout(r, 50));

    // Parent approves with HITL
    const parentCtx = createMockTurnContext("parent", async () => ({ kind: "allow" }));
    await bridge.middleware.onBeforeTurn?.(parentCtx);

    const result = (await resultPromise) as { granted: boolean; grantId?: string };
    expect(result.granted).toBe(true);
    expect(result.grantId).toBeDefined();
  });

  test("timeout: request with no handler → tool returns timeout", async () => {
    const router = createMailboxRouter();
    const childMailbox = router.createMailbox("child");
    // No parent mailbox set up — message goes nowhere

    const requestTool = createDelegationRequestTool(
      childMailbox,
      agentId("child"),
      "delegation",
      "verified",
    );
    const result = (await requestTool.execute({
      targetAgentId: "nonexistent",
      permissions: { allow: ["read_file"] },
      reason: "test",
      timeoutMs: 100,
    })) as { granted: boolean; reason?: string };

    expect(result.granted).toBe(false);
    expect(result.reason).toBe("timeout");
  });
});
