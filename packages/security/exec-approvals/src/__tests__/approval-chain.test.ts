/**
 * Integration tests for the full child→parent→HITL approval chain.
 *
 * Uses linked mailbox pairs to simulate real IPC routing between agents.
 */

import { describe, expect, mock, test } from "bun:test";
import type { AgentMessage, AgentMessageInput, MailboxComponent } from "@koi/core";
import { agentId, messageId } from "@koi/core";
import type { KoiError, Result } from "@koi/core/errors";

import { createAgentApprovalHandler } from "../agent-approval-handler.js";
import { createParentApprovalHandler } from "../parent-approval-handler.js";
import type { ExecApprovalRequest, ProgressiveDecision } from "../types.js";

// ---------------------------------------------------------------------------
// Linked mailbox pair helper
// ---------------------------------------------------------------------------

interface LinkedMailbox extends MailboxComponent {
  readonly deliver: (msg: AgentMessage) => void;
}

/**
 * Create two in-memory mailboxes that route messages to each other based on `to` field.
 */
function createLinkedMailboxPair(
  childId: string,
  parentId: string,
): {
  readonly child: LinkedMailbox;
  readonly parent: LinkedMailbox;
} {
  const childHandlers: Array<(msg: AgentMessage) => void | Promise<void>> = [];
  const parentHandlers: Array<(msg: AgentMessage) => void | Promise<void>> = [];
  let counter = 0;

  const deliverToChild = (msg: AgentMessage): void => {
    for (const handler of childHandlers) {
      handler(msg);
    }
  };

  const deliverToParent = (msg: AgentMessage): void => {
    for (const handler of parentHandlers) {
      handler(msg);
    }
  };

  function route(msg: AgentMessage): void {
    const to = msg.to as string;
    if (to === childId) {
      deliverToChild(msg);
    } else if (to === parentId) {
      deliverToParent(msg);
    }
  }

  function createMailbox(
    handlers: Array<(msg: AgentMessage) => void | Promise<void>>,
  ): LinkedMailbox {
    return {
      send: async (input: AgentMessageInput): Promise<Result<AgentMessage, KoiError>> => {
        counter++;
        const msg: AgentMessage = {
          ...input,
          id: messageId(`msg-${counter}`),
          createdAt: new Date().toISOString(),
        };
        // Route asynchronously to simulate real IPC
        setTimeout(() => route(msg), 1);
        return { ok: true, value: msg };
      },
      onMessage: (handler: (msg: AgentMessage) => void | Promise<void>): (() => void) => {
        handlers.push(handler);
        return () => {
          const idx = handlers.indexOf(handler);
          if (idx >= 0) handlers.splice(idx, 1);
        };
      },
      list: async () => [],
      deliver: (msg: AgentMessage) => {
        for (const handler of handlers) {
          handler(msg);
        }
      },
    };
  }

  return {
    child: createMailbox(childHandlers),
    parent: createMailbox(parentHandlers),
  };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CHILD_ID = agentId("child-1");
const PARENT_ID = agentId("parent-1");

function makeRequest(overrides: Partial<ExecApprovalRequest> = {}): ExecApprovalRequest {
  return {
    toolId: "bash",
    input: { command: "ls" },
    matchedPattern: "bash",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Full chain tests
// ---------------------------------------------------------------------------

describe("approval chain — full integration", () => {
  test("child ask → parent auto-allow → child receives allow_once", async () => {
    const { child, parent } = createLinkedMailboxPair(CHILD_ID as string, PARENT_ID as string);

    // Wire parent-side handler: parent allows bash
    using _parentHandler = createParentApprovalHandler({
      agentId: PARENT_ID,
      mailbox: parent,
      rules: { allow: ["bash"], deny: [], ask: [] },
    });

    // Wire child-side handler
    const handler = createAgentApprovalHandler({
      parentId: PARENT_ID,
      childAgentId: CHILD_ID,
      mailbox: child,
      timeoutMs: 5000,
    });

    const result = await handler(makeRequest());
    expect(result).toEqual({ kind: "allow_once" });
  });

  test("child ask → parent auto-deny → child receives deny_once", async () => {
    const { child, parent } = createLinkedMailboxPair(CHILD_ID as string, PARENT_ID as string);

    using _parentHandler = createParentApprovalHandler({
      agentId: PARENT_ID,
      mailbox: parent,
      rules: { allow: [], deny: ["bash"], ask: [] },
    });

    const handler = createAgentApprovalHandler({
      parentId: PARENT_ID,
      childAgentId: CHILD_ID,
      mailbox: child,
      timeoutMs: 5000,
    });

    const result = await handler(makeRequest());
    expect(result.kind).toBe("deny_once");
    if (result.kind === "deny_once") {
      expect(result.reason).toContain("denied by policy");
    }
  });

  test("child ask → parent ask → parent HITL approves → child receives allow_once", async () => {
    const { child, parent } = createLinkedMailboxPair(CHILD_ID as string, PARENT_ID as string);

    // Parent has bash in ask list, and a HITL that always approves
    const parentOnAsk = mock(
      async (_req: ExecApprovalRequest): Promise<ProgressiveDecision> => ({
        kind: "allow_once",
      }),
    );
    using _parentHandler = createParentApprovalHandler({
      agentId: PARENT_ID,
      mailbox: parent,
      rules: { allow: [], deny: [], ask: ["bash"] },
      onAsk: parentOnAsk,
    });

    const handler = createAgentApprovalHandler({
      parentId: PARENT_ID,
      childAgentId: CHILD_ID,
      mailbox: child,
      timeoutMs: 5000,
    });

    const result = await handler(makeRequest());
    expect(result).toEqual({ kind: "allow_once" });
    expect(parentOnAsk).toHaveBeenCalledTimes(1);
  });

  test("child ask → parent default deny → child receives deny_once", async () => {
    const { child, parent } = createLinkedMailboxPair(CHILD_ID as string, PARENT_ID as string);

    // Parent has empty rules → default deny
    using _parentHandler = createParentApprovalHandler({
      agentId: PARENT_ID,
      mailbox: parent,
      rules: { allow: [], deny: [], ask: [] },
    });

    const handler = createAgentApprovalHandler({
      parentId: PARENT_ID,
      childAgentId: CHILD_ID,
      mailbox: child,
      timeoutMs: 5000,
    });

    const result = await handler(makeRequest());
    expect(result.kind).toBe("deny_once");
    if (result.kind === "deny_once") {
      expect(result.reason).toContain("default deny");
    }
  });

  test("timeout: child ask → parent never responds → child fallback fires", async () => {
    const { child } = createLinkedMailboxPair(CHILD_ID as string, PARENT_ID as string);
    // No parent handler wired — messages go nowhere

    const fallback = mock(
      async (_req: ExecApprovalRequest): Promise<ProgressiveDecision> => ({
        kind: "deny_once",
        reason: "timeout fallback",
      }),
    );

    const handler = createAgentApprovalHandler({
      parentId: PARENT_ID,
      childAgentId: CHILD_ID,
      mailbox: child,
      timeoutMs: 50,
      fallback,
    });

    const result = await handler(makeRequest());
    expect(result).toEqual({ kind: "deny_once", reason: "timeout fallback" });
    expect(fallback).toHaveBeenCalledTimes(1);
  });

  test("escalation: parent has no onAsk + ask rule → child falls back to HITL", async () => {
    const { child, parent } = createLinkedMailboxPair(CHILD_ID as string, PARENT_ID as string);

    // Parent has bash in ask list but NO onAsk → responds with "ask"
    using _parentHandler = createParentApprovalHandler({
      agentId: PARENT_ID,
      mailbox: parent,
      rules: { allow: [], deny: [], ask: ["bash"] },
      // no onAsk
    });

    const childFallback = mock(
      async (_req: ExecApprovalRequest): Promise<ProgressiveDecision> => ({
        kind: "allow_once",
      }),
    );

    const handler = createAgentApprovalHandler({
      parentId: PARENT_ID,
      childAgentId: CHILD_ID,
      mailbox: child,
      timeoutMs: 5000,
      fallback: childFallback,
    });

    const result = await handler(makeRequest());
    expect(result).toEqual({ kind: "allow_once" });
    expect(childFallback).toHaveBeenCalledTimes(1);
  });

  test("compound patterns: parent allows specific command only", async () => {
    const { child, parent } = createLinkedMailboxPair(CHILD_ID as string, PARENT_ID as string);

    using _parentHandler = createParentApprovalHandler({
      agentId: PARENT_ID,
      mailbox: parent,
      rules: { allow: ["bash:ls*"], deny: ["bash:rm*"], ask: [] },
    });

    const handler = createAgentApprovalHandler({
      parentId: PARENT_ID,
      childAgentId: CHILD_ID,
      mailbox: child,
      timeoutMs: 5000,
    });

    // ls should be allowed
    const lsResult = await handler(makeRequest({ input: { command: "ls -la" } }));
    expect(lsResult).toEqual({ kind: "allow_once" });

    // rm should be denied
    const rmResult = await handler(
      makeRequest({ toolId: "bash", input: { command: "rm -rf /" }, matchedPattern: "bash" }),
    );
    expect(rmResult.kind).toBe("deny_once");
  });
});
