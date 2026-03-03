import { describe, expect, mock, test } from "bun:test";
import type { AgentMessage, AgentMessageInput, MailboxComponent } from "@koi/core";
import { agentId, messageId } from "@koi/core";
import type { KoiError, Result } from "@koi/core/errors";

import { EXEC_APPROVAL_REQUEST_TYPE } from "./ipc-types.js";
import { createParentApprovalHandler } from "./parent-approval-handler.js";
import type { ExecApprovalRequest, ProgressiveDecision } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PARENT_ID = agentId("parent-1");
const CHILD_ID = agentId("child-1");

function createMockMailbox(): {
  readonly mailbox: MailboxComponent;
  readonly responses: AgentMessageInput[];
  readonly triggerMessage: (msg: AgentMessage) => void;
} {
  const handlers: Array<(msg: AgentMessage) => void | Promise<void>> = [];
  const responses: AgentMessageInput[] = [];
  let counter = 0;

  const mailbox: MailboxComponent = {
    send: async (input: AgentMessageInput): Promise<Result<AgentMessage, KoiError>> => {
      responses.push(input);
      counter++;
      return {
        ok: true,
        value: { ...input, id: messageId(`resp-${counter}`), createdAt: new Date().toISOString() },
      };
    },
    onMessage: (handler: (msg: AgentMessage) => void | Promise<void>): (() => void) => {
      handlers.push(handler);
      return () => {
        const idx = handlers.indexOf(handler);
        if (idx >= 0) handlers.splice(idx, 1);
      };
    },
    list: async () => [],
  };

  const triggerMessage = (msg: AgentMessage): void => {
    for (const handler of handlers) {
      handler(msg);
    }
  };

  return { mailbox, responses, triggerMessage };
}

function makeApprovalRequest(overrides: Partial<AgentMessage> = {}): AgentMessage {
  return {
    id: messageId("req-1"),
    from: CHILD_ID,
    to: PARENT_ID,
    kind: "request",
    createdAt: new Date().toISOString(),
    type: EXEC_APPROVAL_REQUEST_TYPE,
    payload: {
      toolId: "bash",
      input: { command: "ls" },
      matchedPattern: "bash",
      childAgentId: CHILD_ID as string,
    },
    ...overrides,
  };
}

// Helper to wait for async handler to complete
async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 10));
}

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe("createParentApprovalHandler — happy path", () => {
  test("parent allows: tool in allow list → respond allow_once", async () => {
    const { mailbox, responses, triggerMessage } = createMockMailbox();
    using _handler = createParentApprovalHandler({
      agentId: PARENT_ID,
      mailbox,
      rules: { allow: ["bash"], deny: [], ask: [] },
    });

    triggerMessage(makeApprovalRequest());
    await tick();

    expect(responses).toHaveLength(1);
    const payload = responses[0]?.payload as Record<string, unknown>;
    const decision = payload.decision as Record<string, unknown>;
    expect(decision.kind).toBe("allow_once");
  });

  test("parent denies: tool in deny list → respond deny_once", async () => {
    const { mailbox, responses, triggerMessage } = createMockMailbox();
    using _handler = createParentApprovalHandler({
      agentId: PARENT_ID,
      mailbox,
      rules: { allow: [], deny: ["bash"], ask: [] },
    });

    triggerMessage(makeApprovalRequest());
    await tick();

    expect(responses).toHaveLength(1);
    const payload = responses[0]?.payload as Record<string, unknown>;
    const decision = payload.decision as Record<string, unknown>;
    expect(decision.kind).toBe("deny_once");
    expect(decision.reason).toContain("denied by policy");
  });

  test("parent escalates to onAsk: tool in ask list → call onAsk, respond with result", async () => {
    const { mailbox, responses, triggerMessage } = createMockMailbox();
    const onAsk = mock(
      async (_req: ExecApprovalRequest): Promise<ProgressiveDecision> => ({
        kind: "allow_session",
        pattern: "bash",
      }),
    );
    using _handler = createParentApprovalHandler({
      agentId: PARENT_ID,
      mailbox,
      rules: { allow: [], deny: [], ask: ["bash"] },
      onAsk,
    });

    triggerMessage(makeApprovalRequest());
    await tick();

    expect(onAsk).toHaveBeenCalledTimes(1);
    expect(responses).toHaveLength(1);
    const payload = responses[0]?.payload as Record<string, unknown>;
    const decision = payload.decision as Record<string, unknown>;
    expect(decision.kind).toBe("allow_session");
    expect(decision.pattern).toBe("bash");
  });

  test("default deny: tool matches no rule → respond deny_once", async () => {
    const { mailbox, responses, triggerMessage } = createMockMailbox();
    using _handler = createParentApprovalHandler({
      agentId: PARENT_ID,
      mailbox,
      rules: { allow: [], deny: [], ask: [] },
    });

    triggerMessage(makeApprovalRequest());
    await tick();

    expect(responses).toHaveLength(1);
    const payload = responses[0]?.payload as Record<string, unknown>;
    const decision = payload.decision as Record<string, unknown>;
    expect(decision.kind).toBe("deny_once");
    expect(decision.reason).toContain("default deny");
  });
});

// ---------------------------------------------------------------------------
// Failure modes
// ---------------------------------------------------------------------------

describe("createParentApprovalHandler — failure modes", () => {
  test("malformed payload → respond deny_once", async () => {
    const { mailbox, responses, triggerMessage } = createMockMailbox();
    using _handler = createParentApprovalHandler({
      agentId: PARENT_ID,
      mailbox,
      rules: { allow: ["*"], deny: [], ask: [] },
    });

    triggerMessage(
      makeApprovalRequest({
        payload: { garbage: true },
      }),
    );
    await tick();

    expect(responses).toHaveLength(1);
    const payload = responses[0]?.payload as Record<string, unknown>;
    const decision = payload.decision as Record<string, unknown>;
    expect(decision.kind).toBe("deny_once");
    expect(decision.reason).toContain("Invalid payload");
  });

  test("expired TTL → message ignored (no response sent)", async () => {
    const { mailbox, responses, triggerMessage } = createMockMailbox();
    using _handler = createParentApprovalHandler({
      agentId: PARENT_ID,
      mailbox,
      rules: { allow: ["*"], deny: [], ask: [] },
    });

    triggerMessage(
      makeApprovalRequest({
        ttlSeconds: 1,
        createdAt: new Date(Date.now() - 5000).toISOString(), // 5s ago, 1s TTL
      }),
    );
    await tick();

    expect(responses).toHaveLength(0);
  });

  test("no onAsk configured + ask evaluation → respond with 'ask'", async () => {
    const { mailbox, responses, triggerMessage } = createMockMailbox();
    using _handler = createParentApprovalHandler({
      agentId: PARENT_ID,
      mailbox,
      rules: { allow: [], deny: [], ask: ["bash"] },
      // no onAsk
    });

    triggerMessage(makeApprovalRequest());
    await tick();

    expect(responses).toHaveLength(1);
    const payload = responses[0]?.payload as Record<string, unknown>;
    const decision = payload.decision as Record<string, unknown>;
    expect(decision.kind).toBe("ask");
  });
});

// ---------------------------------------------------------------------------
// Message filtering
// ---------------------------------------------------------------------------

describe("createParentApprovalHandler — message filtering", () => {
  test("ignores non-request messages", async () => {
    const { mailbox, responses, triggerMessage } = createMockMailbox();
    using _handler = createParentApprovalHandler({
      agentId: PARENT_ID,
      mailbox,
      rules: { allow: ["*"], deny: [], ask: [] },
    });

    triggerMessage(makeApprovalRequest({ kind: "response" }));
    await tick();

    expect(responses).toHaveLength(0);
  });

  test("ignores messages with different type", async () => {
    const { mailbox, responses, triggerMessage } = createMockMailbox();
    using _handler = createParentApprovalHandler({
      agentId: PARENT_ID,
      mailbox,
      rules: { allow: ["*"], deny: [], ask: [] },
    });

    triggerMessage(makeApprovalRequest({ type: "some-other-type" }));
    await tick();

    expect(responses).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

describe("createParentApprovalHandler — cleanup", () => {
  test("dispose unsubscribes, no more processing", async () => {
    const { mailbox, responses, triggerMessage } = createMockMailbox();
    const handler = createParentApprovalHandler({
      agentId: PARENT_ID,
      mailbox,
      rules: { allow: ["*"], deny: [], ask: [] },
    });

    // First message should be processed
    triggerMessage(makeApprovalRequest());
    await tick();
    expect(responses).toHaveLength(1);

    // Dispose
    handler[Symbol.dispose]();

    // Second message should be ignored
    triggerMessage(makeApprovalRequest({ id: messageId("req-2") }));
    await tick();
    expect(responses).toHaveLength(1); // Still 1
  });
});

// ---------------------------------------------------------------------------
// Response message shape
// ---------------------------------------------------------------------------

describe("createParentApprovalHandler — response shape", () => {
  test("response message has correct from, to, kind, correlationId, type", async () => {
    const { mailbox, responses, triggerMessage } = createMockMailbox();
    using _handler = createParentApprovalHandler({
      agentId: PARENT_ID,
      mailbox,
      rules: { allow: ["*"], deny: [], ask: [] },
    });

    triggerMessage(makeApprovalRequest());
    await tick();

    expect(responses).toHaveLength(1);
    const resp = responses[0];
    expect(resp?.from).toBe(PARENT_ID);
    expect(resp?.to).toBe(CHILD_ID);
    expect(resp?.kind).toBe("response");
    expect(resp?.correlationId).toBe(messageId("req-1"));
    expect(resp?.type).toBe(EXEC_APPROVAL_REQUEST_TYPE);
  });
});
