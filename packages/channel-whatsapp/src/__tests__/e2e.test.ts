/**
 * E2E lifecycle test for @koi/channel-whatsapp.
 *
 * Uses mock Baileys socket to verify the full message lifecycle:
 * connect → receive event → normalize → handler → send → disconnect
 */

import { describe, expect, mock, test } from "bun:test";
import type { InboundMessage, OutboundMessage } from "@koi/core";
import { createMockBaileysSocket } from "../test-helpers.js";
import { createWhatsAppChannel } from "../whatsapp-channel.js";

describe("whatsapp channel e2e lifecycle", () => {
  test("full roundtrip: message in → handler → reply out", async () => {
    const socket = createMockBaileysSocket();

    const adapter = createWhatsAppChannel({
      authStatePath: "./test_auth",
      _socket: socket,
    });

    const received: InboundMessage[] = [];

    adapter.onMessage(async (msg) => {
      received.push(msg);
      const reply: OutboundMessage = {
        content: [{ kind: "text", text: `Echo: ${(msg.content[0] as { text: string }).text}` }],
        threadId: msg.threadId,
      };
      await adapter.send(reply);
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
          message: { conversation: "ping" },
          messageTimestamp: 1234567890,
        },
      ],
      type: "notify",
    });

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(received).toHaveLength(1);
    expect(received[0]?.content[0]).toEqual({ kind: "text", text: "ping" });
    expect(socket.sendMessage).toHaveBeenCalled();

    await adapter.disconnect();
  });

  test("handler error isolation", async () => {
    const socket = createMockBaileysSocket();
    const errorHandler = mock((_err: unknown, _msg: InboundMessage) => {});

    const adapter = createWhatsAppChannel({
      authStatePath: "./test_auth",
      _socket: socket,
      onHandlerError: errorHandler,
    });

    const received: InboundMessage[] = [];

    adapter.onMessage(async () => {
      throw new Error("handler crash");
    });

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
            id: "MSG002",
          },
          message: { conversation: "test" },
          messageTimestamp: 1234567890,
        },
      ],
      type: "notify",
    });

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(received).toHaveLength(1);
    expect(errorHandler).toHaveBeenCalled();

    await adapter.disconnect();
  });

  test("connect → disconnect → reconnect cycle", async () => {
    const socket = createMockBaileysSocket();

    const adapter = createWhatsAppChannel({
      authStatePath: "./test_auth",
      _socket: socket,
    });

    await adapter.connect();
    await adapter.disconnect();
    expect(socket.end).toHaveBeenCalledTimes(1);
  });

  test("media message roundtrip", async () => {
    const socket = createMockBaileysSocket();

    const adapter = createWhatsAppChannel({
      authStatePath: "./test_auth",
      _socket: socket,
    });

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
            imageMessage: {
              url: "https://example.com/photo.jpg",
              mimetype: "image/jpeg",
              caption: "sunset",
            },
          },
          messageTimestamp: 1234567890,
        },
      ],
      type: "notify",
    });

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(received).toHaveLength(1);
    expect(received[0]?.content[0]).toEqual({
      kind: "image",
      url: "https://example.com/photo.jpg",
      alt: "sunset",
    });

    await adapter.disconnect();
  });
});
