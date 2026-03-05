import { describe, expect, mock, test } from "bun:test";
import type { InboundMessage } from "@koi/core";
import { createSlackChannel } from "./slack-channel.js";
import { createMockSocketClient, createMockWebClient } from "./test-helpers.js";

describe("createSlackChannel", () => {
  function createTestAdapter(overrides?: {
    readonly features?: Record<string, boolean>;
    readonly mode?: "socket" | "http";
  }) {
    const webClient = createMockWebClient();
    const socketClient = createMockSocketClient();

    const adapter = createSlackChannel({
      botToken: "xoxb-test",
      deployment:
        overrides?.mode === "http"
          ? { mode: "http", signingSecret: "test-secret" }
          : { mode: "socket", appToken: "xapp-test" },
      _webClient: webClient,
      _socketClient: socketClient,
    });

    return { adapter, webClient, socketClient };
  }

  test("name is 'slack'", () => {
    const { adapter } = createTestAdapter();
    expect(adapter.name).toBe("slack");
  });

  test("capabilities are correct", () => {
    const { adapter } = createTestAdapter();
    expect(adapter.capabilities).toEqual({
      text: true,
      images: true,
      files: true,
      buttons: true,
      audio: false,
      video: false,
      threads: true,
      supportsA2ui: false,
    });
  });

  test("connect() calls socketClient.start() in socket mode", async () => {
    const { adapter, socketClient } = createTestAdapter();
    await adapter.connect();
    expect(socketClient.start).toHaveBeenCalledTimes(1);
    await adapter.disconnect();
  });

  test("connect() is idempotent", async () => {
    const { adapter, socketClient } = createTestAdapter();
    await adapter.connect();
    await adapter.connect();
    // createChannelAdapter guarantees idempotency
    expect(socketClient.start).toHaveBeenCalledTimes(1);
    await adapter.disconnect();
  });

  test("disconnect() calls socketClient.disconnect()", async () => {
    const { adapter, socketClient } = createTestAdapter();
    await adapter.connect();
    await adapter.disconnect();
    expect(socketClient.disconnect).toHaveBeenCalledTimes(1);
  });

  test("onMessage() returns unsubscribe function", () => {
    const { adapter } = createTestAdapter();
    const unsub = adapter.onMessage(async () => {});
    expect(typeof unsub).toBe("function");
    unsub();
  });

  test("onMessage() unsubscribe is idempotent", () => {
    const { adapter } = createTestAdapter();
    const unsub = adapter.onMessage(async () => {});
    unsub();
    unsub(); // Should not throw
  });

  test("send() calls webClient.chat.postMessage", async () => {
    const { adapter, webClient } = createTestAdapter();
    await adapter.connect();

    await adapter.send({
      content: [{ kind: "text", text: "hello" }],
      threadId: "C456",
    });

    expect(webClient.chat.postMessage).toHaveBeenCalled();
    await adapter.disconnect();
  });

  test("handler receives normalized messages after connect", async () => {
    const { adapter, socketClient } = createTestAdapter();
    const received: InboundMessage[] = [];
    adapter.onMessage(async (msg) => {
      received.push(msg);
    });

    await adapter.connect();

    // Simulate a message event via socket
    socketClient._emit("message", {
      event: {
        type: "message",
        text: "hello from socket",
        user: "U999",
        channel: "C123",
        ts: "1234567890.000001",
      },
      ack: mock(() => {}),
    });

    // Wait for async dispatch
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(received).toHaveLength(1);
    expect(received[0]?.content).toEqual([{ kind: "text", text: "hello from socket" }]);
    expect(received[0]?.senderId).toBe("U999");

    await adapter.disconnect();
  });

  test("sendStatus is present", () => {
    const { adapter } = createTestAdapter();
    expect(adapter.sendStatus).toBeDefined();
  });

  test("handleEvent is present in http mode", () => {
    const { adapter } = createTestAdapter({ mode: "http" });
    expect((adapter as { readonly handleEvent?: unknown }).handleEvent).toBeDefined();
  });

  test("handleEvent is absent in socket mode", () => {
    const { adapter } = createTestAdapter({ mode: "socket" });
    expect((adapter as { readonly handleEvent?: unknown }).handleEvent).toBeUndefined();
  });

  test("send() with empty content does not throw", async () => {
    const { adapter } = createTestAdapter();
    await adapter.connect();
    await adapter.send({ content: [], threadId: "C456" });
    await adapter.disconnect();
  });

  test("disconnect() is safe without prior connect", async () => {
    const { adapter } = createTestAdapter();
    await adapter.disconnect(); // Should not throw
  });

  test("replyToMode 'off' strips thread_ts from threadId", async () => {
    const webClient = createMockWebClient();
    const socketClient = createMockSocketClient();

    const adapter = createSlackChannel({
      botToken: "xoxb-test",
      deployment: { mode: "socket", appToken: "xapp-test" },
      features: { replyToMode: "off" },
      _webClient: webClient,
      _socketClient: socketClient,
    });

    await adapter.connect();

    await adapter.send({
      content: [{ kind: "text", text: "reply in channel" }],
      threadId: "C456:123.456",
    });

    // calls[0] is auth.test during connect(), calls[1] is the actual send
    const calls = webClient.chat.postMessage.mock.calls;
    const sendCall = calls[calls.length - 1] as [Record<string, unknown>];
    expect(sendCall[0].channel).toBe("C456");
    expect(sendCall[0].thread_ts).toBeUndefined();

    await adapter.disconnect();
  });

  test("replyToMode 'all' (default) keeps thread_ts", async () => {
    const webClient = createMockWebClient();
    const socketClient = createMockSocketClient();

    const adapter = createSlackChannel({
      botToken: "xoxb-test",
      deployment: { mode: "socket", appToken: "xapp-test" },
      _webClient: webClient,
      _socketClient: socketClient,
    });

    await adapter.connect();

    await adapter.send({
      content: [{ kind: "text", text: "reply in thread" }],
      threadId: "C456:123.456",
    });

    // calls[0] is auth.test during connect(), calls[1] is the actual send
    const calls = webClient.chat.postMessage.mock.calls;
    const sendCall = calls[calls.length - 1] as [Record<string, unknown>];
    expect(sendCall[0].channel).toBe("C456");
    expect(sendCall[0].thread_ts).toBe("123.456");

    await adapter.disconnect();
  });

  test("reaction_added events are ACKed", async () => {
    const webClient = createMockWebClient();
    const socketClient = createMockSocketClient();

    const adapter = createSlackChannel({
      botToken: "xoxb-test",
      deployment: { mode: "socket", appToken: "xapp-test" },
      features: { reactions: true },
      _webClient: webClient,
      _socketClient: socketClient,
    });

    await adapter.connect();

    const ackFn = mock(() => {});
    socketClient._emit("reaction_added", {
      event: { type: "reaction_added", user: "U1", reaction: "+1", item: {} },
      ack: ackFn,
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(ackFn).toHaveBeenCalledTimes(1);

    await adapter.disconnect();
  });

  test("reaction_removed events are ACKed", async () => {
    const webClient = createMockWebClient();
    const socketClient = createMockSocketClient();

    const adapter = createSlackChannel({
      botToken: "xoxb-test",
      deployment: { mode: "socket", appToken: "xapp-test" },
      features: { reactions: true },
      _webClient: webClient,
      _socketClient: socketClient,
    });

    await adapter.connect();

    const ackFn = mock(() => {});
    socketClient._emit("reaction_removed", {
      event: { type: "reaction_removed", user: "U1", reaction: "+1", item: {} },
      ack: ackFn,
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(ackFn).toHaveBeenCalledTimes(1);

    await adapter.disconnect();
  });

  test("media send fallback retries with text warning on failure", async () => {
    // let justified: track calls to fail on the first real send (skip auth.test)
    let sendCallCount = 0;
    const failingWebClient = {
      chat: {
        postMessage: mock(async (_args: Record<string, unknown>) => {
          sendCallCount++;
          // First two calls: auth.test (connect) and the actual media send
          if (sendCallCount === 2) {
            throw new Error("Upload failed");
          }
          return { ok: true };
        }),
      },
    };
    const socketClient = createMockSocketClient();

    const adapter = createSlackChannel({
      botToken: "xoxb-test",
      deployment: { mode: "socket", appToken: "xapp-test" },
      _webClient: failingWebClient,
      _socketClient: socketClient,
    });

    await adapter.connect();

    await adapter.send({
      content: [
        { kind: "text", text: "Check this" },
        { kind: "image", url: "https://example.com/photo.jpg", alt: "photo" },
      ],
      threadId: "C456",
    });

    // auth.test (1) + failed media send (2) + fallback text send (3)
    expect(sendCallCount).toBe(3);

    await adapter.disconnect();
  });
});
