import { describe, expect, mock, test } from "bun:test";
import type { InboundMessage } from "@koi/core";
import { createMockBaileysSocket } from "./test-helpers.js";
import { createWhatsAppChannel } from "./whatsapp-channel.js";

describe("createWhatsAppChannel", () => {
  function createTestAdapter() {
    const socket = createMockBaileysSocket();
    const adapter = createWhatsAppChannel({
      authStatePath: "./test_auth",
      _socket: socket,
    });
    return { adapter, socket };
  }

  test("name is 'whatsapp'", () => {
    const { adapter } = createTestAdapter();
    expect(adapter.name).toBe("whatsapp");
  });

  test("capabilities are correct", () => {
    const { adapter } = createTestAdapter();
    expect(adapter.capabilities).toEqual({
      text: true,
      images: true,
      files: true,
      buttons: true,
      audio: true,
      video: true,
      threads: false,
      supportsA2ui: false,
    });
  });

  test("connect() resolves without error", async () => {
    const { adapter } = createTestAdapter();
    await adapter.connect();
    await adapter.disconnect();
  });

  test("connect() is idempotent", async () => {
    const { adapter } = createTestAdapter();
    await adapter.connect();
    await adapter.connect();
    await adapter.disconnect();
  });

  test("disconnect() calls socket.end()", async () => {
    const { adapter, socket } = createTestAdapter();
    await adapter.connect();
    await adapter.disconnect();
    expect(socket.end).toHaveBeenCalledTimes(1);
  });

  test("disconnect() is safe without prior connect", async () => {
    const { adapter } = createTestAdapter();
    await adapter.disconnect();
  });

  test("onMessage() returns unsubscribe function", () => {
    const { adapter } = createTestAdapter();
    const unsub = adapter.onMessage(async () => {});
    expect(typeof unsub).toBe("function");
    unsub();
  });

  test("send() calls socket.sendMessage", async () => {
    const { adapter, socket } = createTestAdapter();
    await adapter.connect();

    await adapter.send({
      content: [{ kind: "text", text: "hello" }],
      threadId: "5511999999999@s.whatsapp.net",
    });

    expect(socket.sendMessage).toHaveBeenCalled();
    await adapter.disconnect();
  });

  test("handler receives normalized messages after connect", async () => {
    const { adapter, socket } = createTestAdapter();
    const received: InboundMessage[] = [];
    adapter.onMessage(async (msg) => {
      received.push(msg);
    });

    await adapter.connect();

    socket.ev._emit("messages.upsert", {
      messages: [
        {
          key: {
            remoteJid: "5511999999999@s.whatsapp.net",
            fromMe: false,
            id: "MSG001",
          },
          message: { conversation: "hello from whatsapp" },
          messageTimestamp: 1234567890,
        },
      ],
      type: "notify",
    });

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(received).toHaveLength(1);
    expect(received[0]?.content[0]).toEqual({ kind: "text", text: "hello from whatsapp" });

    await adapter.disconnect();
  });

  test("filters out own messages", async () => {
    const { adapter, socket } = createTestAdapter();
    const received: InboundMessage[] = [];
    adapter.onMessage(async (msg) => {
      received.push(msg);
    });

    await adapter.connect();

    socket.ev._emit("messages.upsert", {
      messages: [
        {
          key: {
            remoteJid: "5511999999999@s.whatsapp.net",
            fromMe: true,
            id: "MSG002",
          },
          message: { conversation: "my own message" },
          messageTimestamp: 1234567890,
        },
      ],
      type: "notify",
    });

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(received).toHaveLength(0);

    await adapter.disconnect();
  });

  test("dispatches reaction events", async () => {
    const { adapter, socket } = createTestAdapter();
    const received: InboundMessage[] = [];
    adapter.onMessage(async (msg) => {
      received.push(msg);
    });

    await adapter.connect();

    socket.ev._emit("messages.upsert", {
      messages: [
        {
          key: {
            remoteJid: "5511999999999@s.whatsapp.net",
            fromMe: false,
            id: "MSG003",
          },
          message: {
            reactionMessage: {
              text: "❤️",
              key: { remoteJid: "5511999999999@s.whatsapp.net", id: "MSG001" },
            },
          },
          messageTimestamp: 1234567890,
        },
      ],
      type: "notify",
    });

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(received).toHaveLength(1);
    expect(received[0]?.content[0]?.kind).toBe("custom");

    await adapter.disconnect();
  });

  test("ignores non-notify message types", async () => {
    const { adapter, socket } = createTestAdapter();
    const received: InboundMessage[] = [];
    adapter.onMessage(async (msg) => {
      received.push(msg);
    });

    await adapter.connect();

    socket.ev._emit("messages.upsert", {
      messages: [
        {
          key: { remoteJid: "5511999999999@s.whatsapp.net", fromMe: false, id: "MSG004" },
          message: { conversation: "history" },
          messageTimestamp: 1234567890,
        },
      ],
      type: "append",
    });

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(received).toHaveLength(0);

    await adapter.disconnect();
  });

  test("calls onQrCode when QR is received", async () => {
    const socket = createMockBaileysSocket();
    const onQrCode = mock((_qr: string) => {});

    const adapter = createWhatsAppChannel({
      authStatePath: "./test_auth",
      onQrCode,
      _socket: socket,
    });

    await adapter.connect();

    socket.ev._emit("connection.update", { qr: "QR_CODE_DATA" });

    expect(onQrCode).toHaveBeenCalledWith("QR_CODE_DATA");

    await adapter.disconnect();
  });

  test("sendStatus is present", () => {
    const { adapter } = createTestAdapter();
    expect(adapter.sendStatus).toBeDefined();
  });

  test("send() with empty content does not throw", async () => {
    const { adapter } = createTestAdapter();
    await adapter.connect();
    await adapter.send({ content: [], threadId: "5511999999999@s.whatsapp.net" });
    await adapter.disconnect();
  });
});
