import { describe, expect, test } from "bun:test";
import type { AgentMessage, AgentMessageInput, JsonObject, MailboxComponent } from "@koi/core";
import {
  agentId,
  DEFAULT_SANDBOXED_POLICY,
  DEFAULT_UNSANDBOXED_POLICY,
  messageId,
} from "@koi/core";
import {
  CAPABILITY_REQUEST_TYPE,
  CAPABILITY_RESPONSE_STATUS,
} from "../capability-request-constants.js";
import { createDelegationRequestTool } from "./request.js";

// ---------------------------------------------------------------------------
// Mock mailbox factory
// ---------------------------------------------------------------------------

interface MockMailbox extends MailboxComponent {
  readonly sentMessages: AgentMessageInput[];
  readonly respondWith: (payload: JsonObject) => void;
}

function createMockMailbox(): MockMailbox {
  const sentMessages: AgentMessageInput[] = [];
  const handlers: Array<(message: AgentMessage) => void | Promise<void>> = [];
  let nextId = 1;

  return {
    sentMessages,
    send: async (input: AgentMessageInput) => {
      sentMessages.push(input);
      const id = messageId(`msg-${nextId++}`);
      const message: AgentMessage = {
        ...input,
        id,
        createdAt: new Date().toISOString(),
      };
      return { ok: true as const, value: message };
    },
    onMessage: (handler) => {
      handlers.push(handler);
      return () => {
        const idx = handlers.indexOf(handler);
        if (idx >= 0) handlers.splice(idx, 1);
      };
    },
    list: async () => [],
    respondWith: (payload: JsonObject) => {
      // Respond to the last sent message
      const lastSent = sentMessages[sentMessages.length - 1];
      const response: AgentMessage = {
        id: messageId(`resp-${nextId++}`),
        from: lastSent?.to ?? agentId("unknown"),
        to: lastSent?.from ?? agentId("unknown"),
        kind: "response",
        correlationId: messageId(`msg-${nextId - 2}`),
        createdAt: new Date().toISOString(),
        type: CAPABILITY_REQUEST_TYPE,
        payload,
      };
      for (const h of [...handlers]) h(response);
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createDelegationRequestTool", () => {
  function setup(): {
    readonly tool: ReturnType<typeof createDelegationRequestTool>;
    readonly mailbox: MockMailbox;
  } {
    const mailbox = createMockMailbox();
    const tool = createDelegationRequestTool(
      mailbox,
      agentId("requester"),
      "delegation",
      DEFAULT_UNSANDBOXED_POLICY,
    );
    return { tool, mailbox };
  }

  test("descriptor has correct name and schema", () => {
    const { tool } = setup();
    expect(tool.descriptor.name).toBe("delegation_request");
    expect(tool.policy.sandbox).toBe(false);
    expect(tool.descriptor.inputSchema.required).toEqual([
      "targetAgentId",
      "permissions",
      "reason",
    ]);
  });

  test("sends capability_request and returns grant on success", async () => {
    const { tool, mailbox } = setup();

    const executePromise = tool.execute({
      targetAgentId: "parent-agent",
      permissions: { allow: ["read_file"] },
      reason: "Need file access for task",
      timeoutMs: 5000,
    });

    // Respond with grant
    setTimeout(() => {
      mailbox.respondWith({
        status: CAPABILITY_RESPONSE_STATUS.GRANTED,
        grantId: "grant-123",
        scope: { permissions: { allow: ["read_file"] } },
      });
    }, 10);

    const result = (await executePromise) as {
      granted: boolean;
      grantId?: string;
      scope?: unknown;
    };
    expect(result.granted).toBe(true);
    expect(result.grantId).toBe("grant-123");

    // Verify message was sent correctly
    expect(mailbox.sentMessages).toHaveLength(1);
    expect(mailbox.sentMessages[0]?.type).toBe(CAPABILITY_REQUEST_TYPE);
    expect(mailbox.sentMessages[0]?.kind).toBe("request");
    expect(mailbox.sentMessages[0]?.to).toBe(agentId("parent-agent"));
  });

  test("returns denial when target denies", async () => {
    const { tool, mailbox } = setup();

    const executePromise = tool.execute({
      targetAgentId: "parent-agent",
      permissions: { allow: ["write_file"] },
      reason: "Need write access",
      timeoutMs: 5000,
    });

    setTimeout(() => {
      mailbox.respondWith({
        status: CAPABILITY_RESPONSE_STATUS.DENIED,
        reason: "Insufficient trust level",
      });
    }, 10);

    const result = (await executePromise) as { granted: boolean; reason?: string };
    expect(result.granted).toBe(false);
    expect(result.reason).toBe("Insufficient trust level");
  });

  test("returns timeout when no response", async () => {
    const { tool } = setup();

    const result = (await tool.execute({
      targetAgentId: "parent-agent",
      permissions: { allow: ["read_file"] },
      reason: "Need access",
      timeoutMs: 50,
    })) as { granted: boolean; reason?: string };

    expect(result.granted).toBe(false);
    expect(result.reason).toBe("timeout");
  });

  test("validates required input fields", async () => {
    const { tool } = setup();

    await expect(
      tool.execute({ permissions: { allow: ["read_file"] }, reason: "test" }),
    ).rejects.toThrow("targetAgentId");

    await expect(tool.execute({ targetAgentId: "agent", reason: "test" })).rejects.toThrow(
      "permissions",
    );

    await expect(
      tool.execute({ targetAgentId: "agent", permissions: { allow: ["read_file"] } }),
    ).rejects.toThrow("reason");
  });

  test("validates timeoutMs", async () => {
    const { tool } = setup();

    await expect(
      tool.execute({
        targetAgentId: "agent",
        permissions: { allow: ["read_file"] },
        reason: "test",
        timeoutMs: -1,
      }),
    ).rejects.toThrow("timeoutMs");
  });

  test("uses custom prefix", () => {
    const mailbox = createMockMailbox();
    const tool = createDelegationRequestTool(
      mailbox,
      agentId("owner"),
      "custom",
      DEFAULT_SANDBOXED_POLICY,
    );
    expect(tool.descriptor.name).toBe("custom_request");
    expect(tool.policy.sandbox).toBe(true);
  });
});
