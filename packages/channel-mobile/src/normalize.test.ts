import { describe, expect, test } from "bun:test";
import { createNormalizer } from "./normalize.js";
import type { MobileInboundFrame } from "./protocol.js";

const normalize = createNormalizer();

describe("createNormalizer", () => {
  test("returns InboundMessage for message frame with text content", async () => {
    const frame: MobileInboundFrame = {
      kind: "message",
      content: [{ kind: "text", text: "hello" }],
      senderId: "user-1",
      threadId: "mobile:0",
    };
    const result = await normalize(frame);
    expect(result).not.toBeNull();
    expect(result?.content).toEqual([{ kind: "text", text: "hello" }]);
    expect(result?.senderId).toBe("user-1");
    expect(result?.threadId).toBe("mobile:0");
    expect(result?.timestamp).toBeGreaterThan(0);
  });

  test("returns InboundMessage without threadId when frame omits it", async () => {
    const frame: MobileInboundFrame = {
      kind: "message",
      content: [{ kind: "text", text: "no thread" }],
      senderId: "user-2",
    };
    const result = await normalize(frame);
    expect(result).not.toBeNull();
    expect(result?.threadId).toBeUndefined();
  });

  test("returns null for ping frame", async () => {
    const frame: MobileInboundFrame = { kind: "ping" };
    expect(await normalize(frame)).toBeNull();
  });

  test("returns null for auth frame", async () => {
    const frame: MobileInboundFrame = { kind: "auth", token: "secret" };
    expect(await normalize(frame)).toBeNull();
  });

  test("returns null for tool_result frame", async () => {
    const frame: MobileInboundFrame = {
      kind: "tool_result",
      toolCallId: "call-1",
      result: { lat: 0, lon: 0 },
    };
    expect(await normalize(frame)).toBeNull();
  });

  test("returns null for message frame with empty content", async () => {
    const frame: MobileInboundFrame = {
      kind: "message",
      content: [],
      senderId: "user-3",
    };
    expect(await normalize(frame)).toBeNull();
  });

  test("preserves multiple content blocks", async () => {
    const frame: MobileInboundFrame = {
      kind: "message",
      content: [
        { kind: "text", text: "look at this" },
        { kind: "image", url: "https://example.com/photo.jpg" },
      ],
      senderId: "user-4",
    };
    const result = await normalize(frame);
    expect(result?.content).toHaveLength(2);
    expect(result?.content[0]).toEqual({ kind: "text", text: "look at this" });
    expect(result?.content[1]).toEqual({ kind: "image", url: "https://example.com/photo.jpg" });
  });
});
