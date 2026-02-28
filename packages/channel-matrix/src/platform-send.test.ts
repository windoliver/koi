import { describe, expect, mock, test } from "bun:test";
import type { OutboundMessage } from "@koi/core";
import type { MatrixSender } from "./platform-send.js";
import { createPlatformSend } from "./platform-send.js";

function makeSender(): MatrixSender & {
  readonly sendText: ReturnType<typeof mock>;
  readonly sendMessage: ReturnType<typeof mock>;
} {
  return {
    sendText: mock(async () => "$event1"),
    sendMessage: mock(async () => "$event2"),
  };
}

function makeMessage(overrides: Partial<OutboundMessage> = {}): OutboundMessage {
  return {
    content: [{ kind: "text", text: "hello" }],
    threadId: "!room1:matrix.org",
    ...overrides,
  };
}

describe("createPlatformSend", () => {
  test("sends text block via sendText", async () => {
    const sender = makeSender();
    const send = createPlatformSend(sender);
    await send(makeMessage());

    expect(sender.sendText).toHaveBeenCalledTimes(1);
    expect(sender.sendText).toHaveBeenCalledWith("!room1:matrix.org", "hello");
  });

  test("sends image block via sendMessage with m.image msgtype", async () => {
    const sender = makeSender();
    const send = createPlatformSend(sender);
    await send(
      makeMessage({
        content: [{ kind: "image", url: "mxc://matrix.org/img1", alt: "photo" }],
      }),
    );

    expect(sender.sendMessage).toHaveBeenCalledTimes(1);
    expect(sender.sendMessage).toHaveBeenCalledWith("!room1:matrix.org", {
      msgtype: "m.image",
      body: "photo",
      url: "mxc://matrix.org/img1",
    });
  });

  test("sends file block via sendMessage with m.file msgtype", async () => {
    const sender = makeSender();
    const send = createPlatformSend(sender);
    await send(
      makeMessage({
        content: [
          {
            kind: "file",
            url: "mxc://matrix.org/file1",
            mimeType: "application/pdf",
            name: "doc.pdf",
          },
        ],
      }),
    );

    expect(sender.sendMessage).toHaveBeenCalledTimes(1);
    expect(sender.sendMessage).toHaveBeenCalledWith("!room1:matrix.org", {
      msgtype: "m.file",
      body: "doc.pdf",
      url: "mxc://matrix.org/file1",
      info: { mimetype: "application/pdf" },
    });
  });

  test("renders button as text fallback", async () => {
    const sender = makeSender();
    const send = createPlatformSend(sender);
    await send(
      makeMessage({
        content: [{ kind: "button", label: "Click me", action: "click", payload: {} }],
      }),
    );

    expect(sender.sendText).toHaveBeenCalledTimes(1);
    expect(sender.sendText).toHaveBeenCalledWith("!room1:matrix.org", "[Click me]");
  });

  test("skips custom blocks", async () => {
    const sender = makeSender();
    const send = createPlatformSend(sender);
    await send(
      makeMessage({
        content: [{ kind: "custom", type: "special", data: {} }],
      }),
    );

    expect(sender.sendText).not.toHaveBeenCalled();
    expect(sender.sendMessage).not.toHaveBeenCalled();
  });

  test("silently skips when threadId is missing", async () => {
    const sender = makeSender();
    const send = createPlatformSend(sender);
    const msg: OutboundMessage = { content: [{ kind: "text", text: "hello" }] };
    await send(msg);
    expect(sender.sendText).not.toHaveBeenCalled();
    expect(sender.sendMessage).not.toHaveBeenCalled();
  });

  test("chunks long text blocks into multiple sends", async () => {
    const sender = makeSender();
    const send = createPlatformSend(sender);
    const longText = "a".repeat(5000);
    await send(makeMessage({ content: [{ kind: "text", text: longText }] }));

    // 5000 chars at 4000 limit = 2 chunks
    expect(sender.sendText).toHaveBeenCalledTimes(2);
    const first = sender.sendText.mock.calls[0]?.[1] as string;
    const second = sender.sendText.mock.calls[1]?.[1] as string;
    expect(first.length).toBeLessThanOrEqual(4000);
    expect(first.length + second.length).toBe(5000);
  });

  test("sends multiple blocks in order", async () => {
    const sender = makeSender();
    const send = createPlatformSend(sender);
    await send(
      makeMessage({
        content: [
          { kind: "text", text: "line 1" },
          { kind: "text", text: "line 2" },
        ],
      }),
    );

    expect(sender.sendText).toHaveBeenCalledTimes(2);
    expect(sender.sendText.mock.calls[0]).toEqual(["!room1:matrix.org", "line 1"]);
    expect(sender.sendText.mock.calls[1]).toEqual(["!room1:matrix.org", "line 2"]);
  });
});
