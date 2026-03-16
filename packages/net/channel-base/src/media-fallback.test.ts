import { describe, expect, mock, test } from "bun:test";
import type { OutboundMessage } from "@koi/core";
import { createMediaFallback } from "./media-fallback.js";

function textMsg(content: string, threadId = "ch1"): OutboundMessage {
  return { content: [{ kind: "text", text: content }], threadId };
}

function mediaMsg(threadId = "ch1"): OutboundMessage {
  return {
    content: [
      { kind: "text", text: "Check this:" },
      { kind: "image", url: "https://example.com/photo.jpg", alt: "photo" },
      {
        kind: "file",
        url: "https://example.com/doc.pdf",
        mimeType: "application/pdf",
        name: "doc.pdf",
      },
    ],
    threadId,
  };
}

describe("createMediaFallback", () => {
  test("text-only messages pass through directly", async () => {
    const send = mock(async (_msg: OutboundMessage) => {});
    const wrapped = createMediaFallback({ send });

    await wrapped(textMsg("hello"));
    expect(send).toHaveBeenCalledTimes(1);
  });

  test("successful media send passes through", async () => {
    const send = mock(async (_msg: OutboundMessage) => {});
    const wrapped = createMediaFallback({ send });

    await wrapped(mediaMsg());
    expect(send).toHaveBeenCalledTimes(1);
  });

  test("failed media send retries with text fallback", async () => {
    // let justified: track call count to fail first, succeed second
    let callCount = 0;
    const send = mock(async (_msg: OutboundMessage) => {
      callCount++;
      if (callCount === 1) {
        throw new Error("Upload failed");
      }
    });
    const wrapped = createMediaFallback({ send });

    await wrapped(mediaMsg());
    expect(send).toHaveBeenCalledTimes(2);

    // Second call should have text fallbacks instead of media
    const fallbackCall = send.mock.calls[1];
    if (fallbackCall === undefined) throw new Error("Expected fallback call");
    const fallbackMsg = fallbackCall[0] satisfies OutboundMessage;

    // First block (text) unchanged
    expect(fallbackMsg.content[0]).toEqual({ kind: "text", text: "Check this:" });
    // Image replaced with warning
    expect(fallbackMsg.content[1]).toEqual({
      kind: "text",
      text: "[Media failed to send: image]",
    });
    // File replaced with warning
    expect(fallbackMsg.content[2]).toEqual({
      kind: "text",
      text: "[Media failed to send: doc.pdf]",
    });
  });

  test("custom formatWarning is used", async () => {
    // let justified: track call count
    let callCount = 0;
    const send = mock(async (_msg: OutboundMessage) => {
      callCount++;
      if (callCount === 1) {
        throw new Error("Upload failed");
      }
    });
    const wrapped = createMediaFallback({
      send,
      formatWarning: (b) => `FAIL:${b.kind}`,
    });

    await wrapped(mediaMsg());
    const fallbackMsg = (send.mock.calls[1] as readonly [OutboundMessage])[0];
    expect(fallbackMsg.content[1]).toEqual({ kind: "text", text: "FAIL:image" });
  });

  test("text-only messages are not affected by media errors", async () => {
    const send = mock(async (_msg: OutboundMessage) => {});
    const wrapped = createMediaFallback({ send });

    await wrapped(textMsg("just text"));
    expect(send).toHaveBeenCalledTimes(1);
  });

  test("file without name falls back to 'file' in warning", async () => {
    // let justified: track call count
    let callCount = 0;
    const send = mock(async (_msg: OutboundMessage) => {
      callCount++;
      if (callCount === 1) {
        throw new Error("Upload failed");
      }
    });
    const wrapped = createMediaFallback({ send });

    const msg: OutboundMessage = {
      content: [
        { kind: "file", url: "https://example.com/unnamed", mimeType: "application/octet-stream" },
      ],
      threadId: "ch1",
    };

    await wrapped(msg);
    expect(send).toHaveBeenCalledTimes(2);
    const fallbackMsg = (send.mock.calls[1] as readonly [OutboundMessage])[0];
    expect(fallbackMsg.content[0]).toEqual({
      kind: "text",
      text: "[Media failed to send: file]",
    });
  });

  test("mediaMaxMb config does not block when size is unknown", async () => {
    const send = mock(async (_msg: OutboundMessage) => {});
    const wrapped = createMediaFallback({ send, mediaMaxMb: 10 });

    await wrapped(mediaMsg());
    // Should pass through normally since isOversized returns false
    expect(send).toHaveBeenCalledTimes(1);
  });

  test("mediaMaxMb with failed send still falls back to warnings", async () => {
    // let justified: track call count
    let callCount = 0;
    const send = mock(async (_msg: OutboundMessage) => {
      callCount++;
      if (callCount === 1) {
        throw new Error("Upload failed");
      }
    });
    const wrapped = createMediaFallback({ send, mediaMaxMb: 25 });

    await wrapped(mediaMsg());
    expect(send).toHaveBeenCalledTimes(2);

    const fallbackMsg = (send.mock.calls[1] as readonly [OutboundMessage])[0];
    expect(fallbackMsg.content[1]).toEqual({
      kind: "text",
      text: "[Media failed to send: image]",
    });
  });

  test("image-only message falls back correctly", async () => {
    // let justified: track call count
    let callCount = 0;
    const send = mock(async (_msg: OutboundMessage) => {
      callCount++;
      if (callCount === 1) {
        throw new Error("Upload failed");
      }
    });
    const wrapped = createMediaFallback({ send });

    const msg: OutboundMessage = {
      content: [{ kind: "image", url: "https://example.com/img.png" }],
      threadId: "ch1",
    };

    await wrapped(msg);
    expect(send).toHaveBeenCalledTimes(2);
    const fallbackMsg = (send.mock.calls[1] as readonly [OutboundMessage])[0];
    expect(fallbackMsg.content[0]).toEqual({
      kind: "text",
      text: "[Media failed to send: image]",
    });
  });

  describe("isOversized callback", () => {
    test("oversized blocks are replaced with size warning", async () => {
      const send = mock(async (_msg: OutboundMessage) => {});
      const wrapped = createMediaFallback({
        send,
        mediaMaxMb: 10,
        isOversized: (block) => block.kind === "image",
      });

      await wrapped(mediaMsg());
      expect(send).toHaveBeenCalledTimes(1);
      const sentMsg = (send.mock.calls[0] as readonly [OutboundMessage])[0];
      // Text block unchanged
      expect(sentMsg.content[0]).toEqual({ kind: "text", text: "Check this:" });
      // Image replaced with size warning
      expect(sentMsg.content[1]).toEqual({
        kind: "text",
        text: "[File too large (>10MB): photo]",
      });
      // File not oversized — unchanged
      expect(sentMsg.content[2]).toMatchObject({ kind: "file", name: "doc.pdf" });
    });

    test("non-oversized blocks pass through normally", async () => {
      const send = mock(async (_msg: OutboundMessage) => {});
      const wrapped = createMediaFallback({
        send,
        mediaMaxMb: 100,
        isOversized: () => false,
      });

      await wrapped(mediaMsg());
      expect(send).toHaveBeenCalledTimes(1);
      const sentMsg = (send.mock.calls[0] as readonly [OutboundMessage])[0];
      expect(sentMsg.content).toHaveLength(3);
      expect(sentMsg.content[1]?.kind).toBe("image");
      expect(sentMsg.content[2]?.kind).toBe("file");
    });

    test("mixed oversized and normal blocks — only oversized replaced", async () => {
      const send = mock(async (_msg: OutboundMessage) => {});
      const wrapped = createMediaFallback({
        send,
        mediaMaxMb: 5,
        isOversized: (block) => block.kind === "file",
      });

      await wrapped(mediaMsg());
      expect(send).toHaveBeenCalledTimes(1);
      const sentMsg = (send.mock.calls[0] as readonly [OutboundMessage])[0];
      // Text unchanged
      expect(sentMsg.content[0]).toEqual({ kind: "text", text: "Check this:" });
      // Image passes through (not oversized)
      expect(sentMsg.content[1]?.kind).toBe("image");
      // File replaced with warning
      expect(sentMsg.content[2]).toEqual({
        kind: "text",
        text: "[File too large (>5MB): doc.pdf]",
      });
    });

    test("no isOversized callback — default stub preserves existing behavior", async () => {
      const send = mock(async (_msg: OutboundMessage) => {});
      const wrapped = createMediaFallback({
        send,
        mediaMaxMb: 1, // Very low limit, but no checker provided
      });

      await wrapped(mediaMsg());
      // Should pass through normally since default isOversized returns false
      expect(send).toHaveBeenCalledTimes(1);
      const sentMsg = (send.mock.calls[0] as readonly [OutboundMessage])[0];
      expect(sentMsg.content[1]?.kind).toBe("image");
    });
  });

  test("preserves threadId and metadata in fallback message", async () => {
    // let justified: track call count
    let callCount = 0;
    const send = mock(async (_msg: OutboundMessage) => {
      callCount++;
      if (callCount === 1) {
        throw new Error("Upload failed");
      }
    });
    const wrapped = createMediaFallback({ send });

    const msg: OutboundMessage = {
      content: [{ kind: "image", url: "https://example.com/img.png", alt: "test" }],
      threadId: "thread-42",
      metadata: { source: "test" },
    };

    await wrapped(msg);
    const fallbackMsg = (send.mock.calls[1] as readonly [OutboundMessage])[0];
    expect(fallbackMsg.threadId).toBe("thread-42");
    expect(fallbackMsg.metadata).toEqual({ source: "test" });
  });
});
