/**
 * E2E smoke test — MCP server full round-trip via InMemoryTransport.
 *
 * Exercises: server startup, tools/list, koi_send_message, koi_list_messages,
 * callerId enforcement, kind enforcement, server shutdown.
 */

import { describe, expect, test } from "bun:test";
import type { AgentMessage, KoiError, Result } from "@koi/core";
import { agentId } from "@koi/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../server.js";

describe("E2E: MCP server round-trip", () => {
  test("full lifecycle: start → list → send → list → stop", async () => {
    const sent: unknown[] = [];
    const mailbox = {
      send: async (input: unknown) => {
        sent.push(input);
        return {
          ok: true as const,
          value: {
            ...(input as Record<string, unknown>),
            id: "msg-1",
            createdAt: new Date().toISOString(),
          },
        } as Result<AgentMessage, KoiError>;
      },
      onMessage: () => () => {},
      list: async () =>
        sent.map((s, i) => ({
          ...(s as Record<string, unknown>),
          id: `msg-${i + 1}`,
          createdAt: new Date().toISOString(),
        })) as unknown as readonly AgentMessage[],
    };

    const agent = {
      manifest: { name: "e2e-agent", version: "0.0.0", description: "test" },
      component: () => undefined,
      has: () => false,
      hasAll: () => false,
      query: () => new Map(),
      components: () => new Map(),
    };

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const CALLER = agentId("e2e-caller");

    const server = createMcpServer({
      agent: agent as never,
      transport: serverTransport,
      platform: { callerId: CALLER, mailbox: mailbox as never },
    });

    // Start
    await server.start();
    expect(server.toolCount()).toBe(2); // koi_send_message + koi_list_messages

    const client = new Client({ name: "e2e-client", version: "1.0.0" });
    await client.connect(clientTransport);

    // List tools
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name).sort()).toEqual([
      "koi_list_messages",
      "koi_send_message",
    ]);

    // Send a message
    const sendResult = await client.callTool({
      name: "koi_send_message",
      arguments: { to: "target-agent", type: "status", payload: { ready: true } },
    });
    const sendText = (sendResult.content as readonly { text: string }[])[0]?.text ?? "";
    expect(sendText).toContain("msg-1");

    // Verify callerId + kind enforcement
    expect(sent).toHaveLength(1);
    const sentMsg = sent[0] as Record<string, unknown>;
    expect(sentMsg.from).toBe(CALLER);
    expect(sentMsg.kind).toBe("event");
    expect(sentMsg.to).toBe(agentId("target-agent"));

    // List messages (returns the sent message)
    const listResult = await client.callTool({
      name: "koi_list_messages",
      arguments: {},
    });
    const listText = (listResult.content as readonly { text: string }[])[0]?.text ?? "";
    const messages = JSON.parse(listText);
    expect(messages).toHaveLength(1);
    expect(messages[0].kind).toBe("event");

    // Stop
    await server.stop();
  });
});
