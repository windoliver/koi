import { describe, expect, test } from "bun:test";
import { createNormalizer, resolveThreadId } from "./normalize.js";

const norm = createNormalizer("BOT123");

describe("normalize.message", () => {
  test("plain text message becomes a TextBlock InboundMessage", () => {
    const result = norm({
      kind: "message",
      event: {
        type: "message",
        text: "hello",
        user: "U1",
        channel: "C1",
        ts: "1700000000.000100",
      },
    });
    expect(result?.senderId).toBe("U1");
    expect(result?.threadId).toBe("C1");
    expect(result?.content).toEqual([{ kind: "text", text: "hello" }]);
  });

  test("threaded message uses channel:thread_ts threadId", () => {
    const result = norm({
      kind: "message",
      event: {
        type: "message",
        text: "in thread",
        user: "U1",
        channel: "C1",
        ts: "1700000001.000100",
        thread_ts: "1700000000.000100",
      },
    });
    expect(result?.threadId).toBe("C1:1700000000.000100");
  });

  test("bot's own messages are dropped", () => {
    const result = norm({
      kind: "message",
      event: {
        type: "message",
        text: "I am the bot",
        user: "BOT123",
        channel: "C1",
        ts: "1.0",
      },
    });
    expect(result).toBeNull();
  });

  test("unknown subtype is dropped", () => {
    const result = norm({
      kind: "message",
      event: {
        type: "message",
        subtype: "channel_join",
        text: "joined",
        user: "U2",
        channel: "C1",
        ts: "1.0",
      },
    });
    expect(result).toBeNull();
  });

  test("file_share with image becomes ImageBlock", () => {
    const result = norm({
      kind: "message",
      event: {
        type: "message",
        subtype: "file_share",
        text: "look",
        user: "U2",
        channel: "C1",
        ts: "1.0",
        files: [
          { id: "F1", name: "cat.png", mimetype: "image/png", url_private: "https://x/cat.png" },
        ],
      },
    });
    expect(result?.content).toEqual([
      { kind: "text", text: "look" },
      { kind: "image", url: "https://x/cat.png", alt: "cat.png" },
    ]);
  });

  test("file_share with non-image becomes FileBlock", () => {
    const result = norm({
      kind: "message",
      event: {
        type: "message",
        subtype: "file_share",
        user: "U2",
        channel: "C1",
        ts: "1.0",
        files: [
          {
            id: "F1",
            name: "report.pdf",
            mimetype: "application/pdf",
            url_private: "https://x/r.pdf",
          },
        ],
      },
    });
    expect(result?.content).toEqual([
      { kind: "file", url: "https://x/r.pdf", mimeType: "application/pdf", name: "report.pdf" },
    ]);
  });

  test("file without url_private is skipped", () => {
    const result = norm({
      kind: "message",
      event: {
        type: "message",
        subtype: "file_share",
        text: "x",
        user: "U2",
        channel: "C1",
        ts: "1.0",
        files: [{ id: "F1" }],
      },
    });
    expect(result?.content).toEqual([{ kind: "text", text: "x" }]);
  });
});

describe("normalize.app_mention", () => {
  test("becomes a text InboundMessage", () => {
    const result = norm({
      kind: "app_mention",
      event: {
        type: "app_mention",
        text: "<@BOT> hi",
        user: "U2",
        channel: "C1",
        ts: "1.0",
      },
    });
    expect(result?.content).toEqual([{ kind: "text", text: "<@BOT> hi" }]);
  });
});

describe("normalize.slash_command", () => {
  test("surfaces as a slack:slash_command custom block", () => {
    const result = norm({
      kind: "slash_command",
      command: {
        command: "/koi",
        text: "help",
        user_id: "U2",
        channel_id: "C1",
        trigger_id: "T1",
        response_url: "https://hooks.slack.com/x",
      },
    });
    expect(result?.senderId).toBe("U2");
    expect(result?.threadId).toBe("C1");
    expect(result?.content[0]?.kind).toBe("custom");
  });
});

describe("normalize.block_action", () => {
  test("surfaces as a slack:block_action custom block", () => {
    const result = norm({
      kind: "block_action",
      action: {
        type: "button",
        action_id: "approve",
        block_id: "b1",
        value: "yes",
        user: { id: "U9" },
        channel: { id: "C2" },
        message: { ts: "1.0", thread_ts: "0.5" },
      },
    });
    expect(result?.senderId).toBe("U9");
    expect(result?.threadId).toBe("C2:0.5");
    expect(result?.content[0]?.kind).toBe("custom");
  });
});

describe("resolveThreadId", () => {
  test("plain channel without thread_ts", () => {
    expect(resolveThreadId("C1")).toBe("C1");
  });
  test("channel with thread_ts", () => {
    expect(resolveThreadId("C1", "0.5")).toBe("C1:0.5");
  });
});
