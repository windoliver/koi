import { describe, expect, test } from "bun:test";
import type { Message, Thread } from "chat";
import { normalizeChatSdkEvent as normalize } from "./normalize.js";
import type { ChatSdkEvent } from "./types.js";

/**
 * Creates a minimal Chat SDK Message stub for testing.
 */
function makeMessage(overrides: {
  readonly text?: string;
  readonly userId?: string;
  readonly userName?: string;
  readonly threadId?: string;
  readonly isMention?: boolean;
  readonly isBot?: boolean;
  readonly isMe?: boolean;
  readonly dateSent?: Date;
  readonly attachments?: ReadonlyArray<{
    readonly type: string;
    readonly url?: string;
    readonly name?: string;
    readonly mimeType?: string;
  }>;
}): Message {
  return {
    id: "msg-1",
    threadId: overrides.threadId ?? "slack:C123:ts456",
    text: overrides.text ?? "",
    isMention: overrides.isMention ?? false,
    author: {
      userId: overrides.userId ?? "U001",
      userName: overrides.userName ?? "testuser",
      fullName: "Test User",
      isBot: overrides.isBot ?? false,
      isMe: overrides.isMe ?? false,
    },
    metadata: {
      dateSent: overrides.dateSent ?? new Date("2024-01-15T12:00:00Z"),
      edited: false,
    },
    attachments: (overrides.attachments as Message["attachments"]) ?? [],
    formatted: { type: "root", children: [] },
    raw: {},
  } as unknown as Message;
}

function makeThread(overrides?: { readonly id?: string; readonly adapterName?: string }): Thread {
  return {
    id: overrides?.id ?? "slack:C123:ts456",
    channelId: "C123",
    isDM: false,
    adapter: { name: overrides?.adapterName ?? "slack" },
  } as unknown as Thread;
}

function makeEvent(overrides?: {
  readonly text?: string;
  readonly userId?: string;
  readonly isMention?: boolean;
  readonly isBot?: boolean;
  readonly isMe?: boolean;
  readonly threadId?: string;
  readonly adapterName?: string;
  readonly dateSent?: Date;
  readonly attachments?: ReadonlyArray<{
    readonly type: string;
    readonly url?: string;
    readonly name?: string;
    readonly mimeType?: string;
  }>;
}): ChatSdkEvent {
  const adapterName = overrides?.adapterName ?? "slack";
  const threadId = overrides?.threadId ?? `${adapterName}:C123:ts456`;
  return {
    thread: makeThread({ id: threadId, adapterName }),
    message: makeMessage({ ...overrides, threadId }),
    adapterName,
  };
}

describe("normalize", () => {
  test("returns InboundMessage for text message", () => {
    const result = normalize(makeEvent({ text: "hello world" }));
    expect(result).not.toBeNull();
    expect(result?.content).toEqual([{ kind: "text", text: "hello world" }]);
    expect(result?.senderId).toBe("U001");
    expect(result?.threadId).toBe("slack:C123:ts456");
  });

  test("extracts timestamp from message metadata", () => {
    const date = new Date("2024-06-15T10:30:00Z");
    const result = normalize(makeEvent({ text: "hi", dateSent: date }));
    expect(result).not.toBeNull();
    expect(result?.timestamp).toBe(date.getTime());
  });

  test("returns null for bot's own messages", () => {
    const result = normalize(makeEvent({ text: "bot reply", isMe: true }));
    expect(result).toBeNull();
  });

  test("returns null for empty text without attachments", () => {
    const result = normalize(makeEvent({ text: "" }));
    expect(result).toBeNull();
  });

  test("returns InboundMessage for message with image attachment", () => {
    const result = normalize(
      makeEvent({
        text: "check this",
        attachments: [{ type: "image", url: "https://example.com/img.png", name: "img.png" }],
      }),
    );
    expect(result).not.toBeNull();
    expect(result?.content).toHaveLength(2);
    expect(result?.content[0]).toEqual({ kind: "text", text: "check this" });
    expect(result?.content[1]).toEqual({
      kind: "image",
      url: "https://example.com/img.png",
      alt: "img.png",
    });
  });

  test("returns InboundMessage for message with file attachment", () => {
    const result = normalize(
      makeEvent({
        text: "here's the doc",
        attachments: [
          {
            type: "file",
            url: "https://example.com/doc.pdf",
            name: "doc.pdf",
            mimeType: "application/pdf",
          },
        ],
      }),
    );
    expect(result).not.toBeNull();
    expect(result?.content).toHaveLength(2);
    expect(result?.content[1]).toEqual({
      kind: "file",
      url: "https://example.com/doc.pdf",
      mimeType: "application/pdf",
      name: "doc.pdf",
    });
  });

  test("handles attachment without URL gracefully", () => {
    const result = normalize(
      makeEvent({
        text: "file attached",
        attachments: [{ type: "file", name: "secret.pdf" }],
      }),
    );
    expect(result).not.toBeNull();
    // Attachment without URL is skipped, only text block remains
    expect(result?.content).toEqual([{ kind: "text", text: "file attached" }]);
  });

  test("returns InboundMessage for attachment-only message (no text)", () => {
    const result = normalize(
      makeEvent({
        text: "",
        attachments: [{ type: "image", url: "https://example.com/img.png", name: "photo" }],
      }),
    );
    expect(result).not.toBeNull();
    expect(result?.content).toHaveLength(1);
    expect(result?.content[0]).toEqual({
      kind: "image",
      url: "https://example.com/img.png",
      alt: "photo",
    });
  });

  test("sets correct threadId from thread.id", () => {
    const result = normalize(
      makeEvent({
        text: "hello",
        threadId: "discord:G789:T111",
        adapterName: "discord",
      }),
    );
    expect(result?.threadId).toBe("discord:G789:T111");
  });

  test("sets correct senderId from message author", () => {
    const result = normalize(makeEvent({ text: "hi", userId: "U999" }));
    expect(result?.senderId).toBe("U999");
  });

  test("handles image attachment without name", () => {
    const result = normalize(
      makeEvent({
        text: "",
        attachments: [{ type: "image", url: "https://example.com/img.png" }],
      }),
    );
    expect(result).not.toBeNull();
    expect(result?.content).toEqual([{ kind: "image", url: "https://example.com/img.png" }]);
  });

  test("handles file attachment without name", () => {
    const result = normalize(
      makeEvent({
        text: "",
        attachments: [
          {
            type: "file",
            url: "https://example.com/data.bin",
            mimeType: "application/octet-stream",
          },
        ],
      }),
    );
    expect(result).not.toBeNull();
    expect(result?.content).toEqual([
      { kind: "file", url: "https://example.com/data.bin", mimeType: "application/octet-stream" },
    ]);
  });

  test("handles video attachment as file block", () => {
    const result = normalize(
      makeEvent({
        text: "",
        attachments: [
          {
            type: "video",
            url: "https://example.com/video.mp4",
            name: "clip.mp4",
            mimeType: "video/mp4",
          },
        ],
      }),
    );
    expect(result).not.toBeNull();
    expect(result?.content).toEqual([
      {
        kind: "file",
        url: "https://example.com/video.mp4",
        mimeType: "video/mp4",
        name: "clip.mp4",
      },
    ]);
  });

  test("includes isMention in metadata when true", () => {
    const result = normalize(makeEvent({ text: "@bot help", isMention: true }));
    expect(result).not.toBeNull();
    expect(result?.metadata?.isMention).toBe(true);
  });
});
