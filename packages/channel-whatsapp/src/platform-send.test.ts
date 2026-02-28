import { describe, expect, mock, test } from "bun:test";
import type { OutboundMessage } from "@koi/core";
import type { WASocketApi } from "./platform-send.js";
import { whatsappSend } from "./platform-send.js";

function createMockSocket(): WASocketApi & {
  readonly calls: { readonly jid: string; readonly content: Record<string, unknown> }[];
} {
  const calls: { readonly jid: string; readonly content: Record<string, unknown> }[] = [];
  return {
    calls,
    sendMessage: mock(async (jid: string, content: Record<string, unknown>) => {
      calls.push({ jid, content });
      return {};
    }),
  };
}

function msg(content: OutboundMessage["content"], threadId?: string): OutboundMessage {
  if (threadId !== undefined) {
    return { content, threadId };
  }
  return { content };
}

describe("whatsappSend", () => {
  const JID = "5511999999999@s.whatsapp.net";

  test("silently skips when threadId is undefined", async () => {
    const socket = createMockSocket();
    await whatsappSend(socket, msg([{ kind: "text", text: "hello" }]));
    expect(socket.calls).toHaveLength(0);
  });

  test("sends text message", async () => {
    const socket = createMockSocket();
    await whatsappSend(socket, msg([{ kind: "text", text: "hello" }], JID));

    expect(socket.calls).toHaveLength(1);
    expect(socket.calls[0]?.jid).toBe(JID);
    expect(socket.calls[0]?.content).toEqual({ text: "hello" });
  });

  test("merges adjacent text blocks", async () => {
    const socket = createMockSocket();
    await whatsappSend(
      socket,
      msg(
        [
          { kind: "text", text: "line 1" },
          { kind: "text", text: "line 2" },
        ],
        JID,
      ),
    );

    expect(socket.calls).toHaveLength(1);
    expect(socket.calls[0]?.content).toEqual({ text: "line 1\nline 2" });
  });

  test("splits long text at 4096-char boundary", async () => {
    const socket = createMockSocket();
    const longText = "x".repeat(5000);
    await whatsappSend(socket, msg([{ kind: "text", text: longText }], JID));

    expect(socket.calls.length).toBeGreaterThan(1);
  });

  test("sends image with caption", async () => {
    const socket = createMockSocket();
    await whatsappSend(
      socket,
      msg([{ kind: "image", url: "https://example.com/img.jpg", alt: "a photo" }], JID),
    );

    expect(socket.calls).toHaveLength(1);
    expect(socket.calls[0]?.content).toEqual({
      image: { url: "https://example.com/img.jpg" },
      caption: "a photo",
    });
  });

  test("sends image without caption when alt is undefined", async () => {
    const socket = createMockSocket();
    await whatsappSend(socket, msg([{ kind: "image", url: "https://example.com/img.jpg" }], JID));

    expect(socket.calls).toHaveLength(1);
    expect(socket.calls[0]?.content).toEqual({
      image: { url: "https://example.com/img.jpg" },
    });
  });

  test("sends document with filename", async () => {
    const socket = createMockSocket();
    await whatsappSend(
      socket,
      msg(
        [
          {
            kind: "file",
            url: "https://example.com/doc.pdf",
            mimeType: "application/pdf",
            name: "doc.pdf",
          },
        ],
        JID,
      ),
    );

    expect(socket.calls).toHaveLength(1);
    expect(socket.calls[0]?.content).toEqual({
      document: { url: "https://example.com/doc.pdf" },
      mimetype: "application/pdf",
      fileName: "doc.pdf",
    });
  });

  test("sends button with action", async () => {
    const socket = createMockSocket();
    await whatsappSend(
      socket,
      msg([{ kind: "button", label: "Click me", action: "btn_click" }], JID),
    );

    expect(socket.calls).toHaveLength(1);
    expect(socket.calls[0]?.content.text).toBe("Click me");
    expect(socket.calls[0]?.content.buttons).toBeDefined();
  });

  test("silently skips custom blocks", async () => {
    const socket = createMockSocket();
    await whatsappSend(socket, msg([{ kind: "custom", type: "something", data: {} }], JID));

    expect(socket.calls).toHaveLength(0);
  });

  test("flushes text before media blocks", async () => {
    const socket = createMockSocket();
    await whatsappSend(
      socket,
      msg(
        [
          { kind: "text", text: "check this out" },
          { kind: "image", url: "https://example.com/img.jpg" },
        ],
        JID,
      ),
    );

    expect(socket.calls).toHaveLength(2);
    expect(socket.calls[0]?.content).toEqual({ text: "check this out" });
    expect(socket.calls[1]?.content).toHaveProperty("image");
  });
});
