import { describe, expect, mock, test } from "bun:test";
import type { OutboundMessage } from "@koi/core";
import { createPlatformSend } from "./platform-send.js";

function makeMessage(overrides: Partial<OutboundMessage> = {}): OutboundMessage {
  return {
    content: [{ kind: "text", text: "hello" }],
    ...overrides,
  };
}

describe("createPlatformSend", () => {
  test("sends JSON frame to targeted client via threadId", async () => {
    const sendFn = mock(() => {});
    const clients = new Map([["42", { send: sendFn }]]);
    const send = createPlatformSend(() => clients);

    await send(makeMessage({ threadId: "mobile:42" }));

    expect(sendFn).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(sendFn.mock.calls[0]?.[0] as string);
    expect(payload.kind).toBe("message");
    expect(payload.content).toEqual([{ kind: "text", text: "hello" }]);
  });

  test("broadcasts to all clients when no threadId", async () => {
    const send1 = mock(() => {});
    const send2 = mock(() => {});
    const clients = new Map([
      ["a", { send: send1 }],
      ["b", { send: send2 }],
    ]);
    const send = createPlatformSend(() => clients);

    await send(makeMessage());

    expect(send1).toHaveBeenCalledTimes(1);
    expect(send2).toHaveBeenCalledTimes(1);
  });

  test("does nothing when targeted client not found", async () => {
    const clients = new Map<string, { readonly send: (data: string) => void }>();
    const send = createPlatformSend(() => clients);

    // Should not throw
    await send(makeMessage({ threadId: "mobile:nonexistent" }));
  });

  test("strips mobile: prefix from threadId for client lookup", async () => {
    const sendFn = mock(() => {});
    const clients = new Map([["7", { send: sendFn }]]);
    const send = createPlatformSend(() => clients);

    await send(makeMessage({ threadId: "mobile:7" }));
    expect(sendFn).toHaveBeenCalledTimes(1);
  });

  test("chunks oversized text blocks into multiple content entries", async () => {
    const sendFn = mock(() => {});
    const clients = new Map([["42", { send: sendFn }]]);
    const send = createPlatformSend(() => clients);
    const longText = "a".repeat(10000);

    await send(makeMessage({ threadId: "mobile:42", content: [{ kind: "text", text: longText }] }));

    expect(sendFn).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(sendFn.mock.calls[0]?.[0] as string) as {
      readonly content: readonly { readonly kind: string; readonly text: string }[];
    };
    // 10000 chars at 8000 limit = 2 text blocks
    expect(payload.content.length).toBe(2);
    expect(payload.content[0]?.text.length).toBeLessThanOrEqual(8000);
    const totalLength =
      (payload.content[0]?.text.length ?? 0) + (payload.content[1]?.text.length ?? 0);
    expect(totalLength).toBe(10000);
  });

  test("uses raw threadId when no mobile: prefix", async () => {
    const sendFn = mock(() => {});
    const clients = new Map([["raw-id", { send: sendFn }]]);
    const send = createPlatformSend(() => clients);

    await send(makeMessage({ threadId: "raw-id" }));
    expect(sendFn).toHaveBeenCalledTimes(1);
  });
});
