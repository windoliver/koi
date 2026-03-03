/**
 * E2E lifecycle test for @koi/channel-slack.
 *
 * Uses mock clients to verify the full message lifecycle:
 * connect → receive event → normalize → handler → send → disconnect
 */

import { describe, expect, mock, test } from "bun:test";
import type { InboundMessage, OutboundMessage } from "@koi/core";
import { createSlackChannel } from "../slack-channel.js";
import { createMockSocketClient, createMockWebClient } from "../test-helpers.js";

describe("slack channel e2e lifecycle", () => {
  test("full roundtrip: message in → handler → reply out", async () => {
    const webClient = createMockWebClient();
    const socketClient = createMockSocketClient();

    const adapter = createSlackChannel({
      botToken: "xoxb-test",
      deployment: { mode: "socket", appToken: "xapp-test" },
      _webClient: webClient,
      _socketClient: socketClient,
    });

    const received: InboundMessage[] = [];
    const sent: OutboundMessage[] = [];

    adapter.onMessage(async (msg) => {
      received.push(msg);
      const reply: OutboundMessage = {
        content: [{ kind: "text", text: `Echo: ${(msg.content[0] as { text: string }).text}` }],
        ...(msg.threadId !== undefined ? { threadId: msg.threadId } : {}),
      };
      sent.push(reply);
      await adapter.send(reply);
    });

    await adapter.connect();

    // Simulate inbound message
    socketClient._emit("message", {
      event: {
        type: "message",
        text: "ping",
        user: "U123",
        channel: "C456",
        ts: "1234567890.000001",
      },
      ack: mock(() => {}),
    });

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(received).toHaveLength(1);
    expect(received[0]?.content[0]).toEqual({ kind: "text", text: "ping" });
    expect(webClient.chat.postMessage).toHaveBeenCalled();

    await adapter.disconnect();
  });

  test("slash command lifecycle", async () => {
    const webClient = createMockWebClient();
    const socketClient = createMockSocketClient();

    const adapter = createSlackChannel({
      botToken: "xoxb-test",
      deployment: { mode: "socket", appToken: "xapp-test" },
      _webClient: webClient,
      _socketClient: socketClient,
    });

    const received: InboundMessage[] = [];
    adapter.onMessage(async (msg) => {
      received.push(msg);
    });

    await adapter.connect();

    socketClient._emit("slash_commands", {
      command: "/deploy",
      text: "production",
      user_id: "U123",
      channel_id: "C456",
      trigger_id: "T789",
      response_url: "https://hooks.slack.com/response/xxx",
      ack: mock(() => {}),
    });

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(received).toHaveLength(1);
    expect(received[0]?.metadata?.isSlashCommand).toBe(true);
    expect(received[0]?.metadata?.commandName).toBe("/deploy");

    await adapter.disconnect();
  });

  test("bot self-filtering works", async () => {
    const webClient = createMockWebClient();
    const socketClient = createMockSocketClient();

    // Return bot user ID from auth.test mock
    webClient.chat.postMessage.mockImplementation(async (args: Record<string, unknown>) => {
      if (args._authTest === true) {
        return { user_id: "B001" };
      }
      return { ok: true };
    });

    const adapter = createSlackChannel({
      botToken: "xoxb-test",
      deployment: { mode: "socket", appToken: "xapp-test" },
      _webClient: webClient,
      _socketClient: socketClient,
    });

    const received: InboundMessage[] = [];
    adapter.onMessage(async (msg) => {
      received.push(msg);
    });

    await adapter.connect();

    // Message from bot itself
    socketClient._emit("message", {
      event: {
        type: "message",
        text: "bot echo",
        user: "B001",
        channel: "C456",
        ts: "1234567890.000001",
      },
      ack: mock(() => {}),
    });

    await new Promise((resolve) => setTimeout(resolve, 50));

    // Should be filtered
    expect(received).toHaveLength(0);

    await adapter.disconnect();
  });

  test("reaction event lifecycle", async () => {
    const webClient = createMockWebClient();
    const socketClient = createMockSocketClient();

    const adapter = createSlackChannel({
      botToken: "xoxb-test",
      deployment: { mode: "socket", appToken: "xapp-test" },
      _webClient: webClient,
      _socketClient: socketClient,
    });

    const received: InboundMessage[] = [];
    adapter.onMessage(async (msg) => {
      received.push(msg);
    });

    await adapter.connect();

    socketClient._emit("reaction_added", {
      event: {
        type: "reaction_added",
        user: "U123",
        reaction: "thumbsup",
        item: { type: "message", channel: "C456", ts: "123.456" },
        event_ts: "1234567890.000001",
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(received).toHaveLength(1);
    expect(received[0]?.content[0]?.kind).toBe("custom");
    const customBlock = received[0]?.content[0] as {
      type: string;
      data: { action: string; reaction: string };
    };
    expect(customBlock.type).toBe("slack:reaction");
    expect(customBlock.data.action).toBe("add");
    expect(customBlock.data.reaction).toBe("thumbsup");

    await adapter.disconnect();
  });

  test("app_mention event lifecycle", async () => {
    const webClient = createMockWebClient();
    const socketClient = createMockSocketClient();

    const adapter = createSlackChannel({
      botToken: "xoxb-test",
      deployment: { mode: "socket", appToken: "xapp-test" },
      _webClient: webClient,
      _socketClient: socketClient,
    });

    const received: InboundMessage[] = [];
    adapter.onMessage(async (msg) => {
      received.push(msg);
    });

    await adapter.connect();

    socketClient._emit("app_mention", {
      event: {
        type: "app_mention",
        text: "<@B001> hello",
        user: "U123",
        channel: "C456",
        ts: "1234567890.000001",
      },
      ack: mock(() => {}),
    });

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(received).toHaveLength(1);
    expect(received[0]?.senderId).toBe("U123");

    await adapter.disconnect();
  });

  test("block action (interactive) event lifecycle", async () => {
    const webClient = createMockWebClient();
    const socketClient = createMockSocketClient();

    const adapter = createSlackChannel({
      botToken: "xoxb-test",
      deployment: { mode: "socket", appToken: "xapp-test" },
      _webClient: webClient,
      _socketClient: socketClient,
    });

    const received: InboundMessage[] = [];
    adapter.onMessage(async (msg) => {
      received.push(msg);
    });

    await adapter.connect();

    socketClient._emit("interactive", {
      payload: {
        type: "block_actions",
        actions: [
          {
            type: "button",
            action_id: "approve_btn",
            block_id: "B1",
            value: "yes",
          },
        ],
        user: { id: "U123" },
        channel: { id: "C456" },
      },
      ack: mock(() => {}),
    });

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(received).toHaveLength(1);
    expect(received[0]?.content[0]?.kind).toBe("button");

    await adapter.disconnect();
  });

  test("reaction_removed event lifecycle", async () => {
    const webClient = createMockWebClient();
    const socketClient = createMockSocketClient();

    const adapter = createSlackChannel({
      botToken: "xoxb-test",
      deployment: { mode: "socket", appToken: "xapp-test" },
      _webClient: webClient,
      _socketClient: socketClient,
    });

    const received: InboundMessage[] = [];
    adapter.onMessage(async (msg) => {
      received.push(msg);
    });

    await adapter.connect();

    socketClient._emit("reaction_removed", {
      event: {
        type: "reaction_removed",
        user: "U123",
        reaction: "thumbsup",
        item: { type: "message", channel: "C456", ts: "123.456" },
        event_ts: "1234567890.000001",
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(received).toHaveLength(1);
    const customBlock = received[0]?.content[0] as { type: string; data: { action: string } };
    expect(customBlock.data.action).toBe("remove");

    await adapter.disconnect();
  });

  test("HTTP mode handleEvent dispatches event_callback", async () => {
    const webClient = createMockWebClient();
    const socketClient = createMockSocketClient();

    const adapter = createSlackChannel({
      botToken: "xoxb-test",
      deployment: { mode: "http", signingSecret: "test-secret" },
      _webClient: webClient,
      _socketClient: socketClient,
    });

    const received: InboundMessage[] = [];
    adapter.onMessage(async (msg) => {
      received.push(msg);
    });

    await adapter.connect();

    const handleEvent = (adapter as { readonly handleEvent?: (p: unknown) => void }).handleEvent;
    expect(handleEvent).toBeDefined();

    handleEvent?.({
      type: "event_callback",
      event: {
        type: "message",
        text: "http message",
        user: "U123",
        channel: "C789",
        ts: "1234567890.000001",
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(received).toHaveLength(1);
    expect(received[0]?.content[0]).toEqual({ kind: "text", text: "http message" });

    await adapter.disconnect();
  });

  test("HTTP mode handleEvent dispatches app_mention", async () => {
    const webClient = createMockWebClient();
    const socketClient = createMockSocketClient();

    const adapter = createSlackChannel({
      botToken: "xoxb-test",
      deployment: { mode: "http", signingSecret: "test-secret" },
      _webClient: webClient,
      _socketClient: socketClient,
    });

    const received: InboundMessage[] = [];
    adapter.onMessage(async (msg) => {
      received.push(msg);
    });

    await adapter.connect();

    const handleEvent = (adapter as { readonly handleEvent?: (p: unknown) => void }).handleEvent;
    handleEvent?.({
      type: "event_callback",
      event: {
        type: "app_mention",
        text: "<@B001> hi",
        user: "U456",
        channel: "C789",
        ts: "1234567890.000001",
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(received).toHaveLength(1);
    expect(received[0]?.senderId).toBe("U456");

    await adapter.disconnect();
  });

  test("auth.test failure does not prevent connect", async () => {
    const webClient = createMockWebClient();
    webClient.chat.postMessage.mockImplementation(async () => {
      throw new Error("auth failed");
    });
    const socketClient = createMockSocketClient();

    const adapter = createSlackChannel({
      botToken: "xoxb-test",
      deployment: { mode: "socket", appToken: "xapp-test" },
      _webClient: webClient,
      _socketClient: socketClient,
    });

    // Should not throw
    await adapter.connect();
    expect(socketClient.start).toHaveBeenCalledTimes(1);
    await adapter.disconnect();
  });

  test("handler error isolation", async () => {
    const webClient = createMockWebClient();
    const socketClient = createMockSocketClient();
    const errorHandler = mock((_err: unknown, _msg: InboundMessage) => {});

    const adapter = createSlackChannel({
      botToken: "xoxb-test",
      deployment: { mode: "socket", appToken: "xapp-test" },
      _webClient: webClient,
      _socketClient: socketClient,
      onHandlerError: errorHandler,
    });

    const received: InboundMessage[] = [];

    // First handler throws
    adapter.onMessage(async () => {
      throw new Error("handler crash");
    });

    // Second handler should still receive the message
    adapter.onMessage(async (msg) => {
      received.push(msg);
    });

    await adapter.connect();

    socketClient._emit("message", {
      event: {
        type: "message",
        text: "test",
        user: "U123",
        channel: "C456",
        ts: "1234567890.000001",
      },
      ack: mock(() => {}),
    });

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(received).toHaveLength(1);
    expect(errorHandler).toHaveBeenCalled();

    await adapter.disconnect();
  });
});
