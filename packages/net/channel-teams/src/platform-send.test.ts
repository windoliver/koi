import { describe, expect, mock, test } from "bun:test";
import type { OutboundMessage } from "@koi/core";
import type { TeamsTurnContext, TurnContextStore } from "./platform-send.js";
import { createPlatformSend } from "./platform-send.js";

function makeStore(): TurnContextStore & {
  readonly sendActivity: ReturnType<typeof mock>;
} {
  const sendActivity = mock(async (_activity: unknown) => ({}));
  const contexts = new Map<string, TeamsTurnContext>();
  contexts.set("conv-1", { sendActivity });

  return {
    get: (id: string) => contexts.get(id),
    set: (id, ctx) => contexts.set(id, ctx),
    sendActivity,
  };
}

function makeMessage(overrides: Partial<OutboundMessage> = {}): OutboundMessage {
  return {
    content: [{ kind: "text", text: "hello" }],
    threadId: "conv-1",
    ...overrides,
  };
}

describe("createPlatformSend", () => {
  test("sends text via turn context", async () => {
    const store = makeStore();
    const send = createPlatformSend(store);
    await send(makeMessage());

    expect(store.sendActivity).toHaveBeenCalledTimes(1);
    const call = store.sendActivity.mock.calls[0]?.[0] as {
      readonly type: string;
      readonly text: string;
    };
    expect(call.type).toBe("message");
    expect(call.text).toBe("hello");
  });

  test("merges multiple text blocks with newlines", async () => {
    const store = makeStore();
    const send = createPlatformSend(store);
    await send(
      makeMessage({
        content: [
          { kind: "text", text: "line 1" },
          { kind: "text", text: "line 2" },
        ],
      }),
    );

    const call = store.sendActivity.mock.calls[0]?.[0] as { readonly text: string };
    expect(call.text).toBe("line 1\nline 2");
  });

  test("renders image as markdown", async () => {
    const store = makeStore();
    const send = createPlatformSend(store);
    await send(
      makeMessage({
        content: [{ kind: "image", url: "https://example.com/img.jpg", alt: "photo" }],
      }),
    );

    const call = store.sendActivity.mock.calls[0]?.[0] as { readonly text: string };
    expect(call.text).toBe("![photo](https://example.com/img.jpg)");
  });

  test("renders file as markdown link", async () => {
    const store = makeStore();
    const send = createPlatformSend(store);
    await send(
      makeMessage({
        content: [
          {
            kind: "file",
            url: "https://example.com/doc.pdf",
            mimeType: "application/pdf",
            name: "doc.pdf",
          },
        ],
      }),
    );

    const call = store.sendActivity.mock.calls[0]?.[0] as { readonly text: string };
    expect(call.text).toBe("[doc.pdf](https://example.com/doc.pdf)");
  });

  test("renders button as text fallback", async () => {
    const store = makeStore();
    const send = createPlatformSend(store);
    await send(
      makeMessage({
        content: [{ kind: "button", label: "Click", action: "click", payload: {} }],
      }),
    );

    const call = store.sendActivity.mock.calls[0]?.[0] as { readonly text: string };
    expect(call.text).toBe("[Click]");
  });

  test("skips custom blocks", async () => {
    const store = makeStore();
    const send = createPlatformSend(store);
    await send(
      makeMessage({
        content: [{ kind: "custom", type: "special", data: {} }],
      }),
    );

    expect(store.sendActivity).not.toHaveBeenCalled();
  });

  test("chunks long text into multiple activity sends", async () => {
    const store = makeStore();
    const send = createPlatformSend(store);
    const longText = "a".repeat(5000);
    await send(makeMessage({ content: [{ kind: "text", text: longText }] }));

    // 5000 chars at 4000 limit = 2 chunks = 2 sendActivity calls
    expect(store.sendActivity).toHaveBeenCalledTimes(2);
    const first = (store.sendActivity.mock.calls[0]?.[0] as { readonly text: string }).text;
    const second = (store.sendActivity.mock.calls[1]?.[0] as { readonly text: string }).text;
    expect(first.length).toBeLessThanOrEqual(4000);
    expect(first.length + second.length).toBe(5000);
  });

  test("throws when threadId is undefined", async () => {
    const store = makeStore();
    const send = createPlatformSend(store);
    const msg: OutboundMessage = { content: [{ kind: "text", text: "hello" }] };
    await expect(send(msg)).rejects.toThrow("threadId is required");
  });

  test("silently skips when no turn context found", async () => {
    const store = makeStore();
    const send = createPlatformSend(store);
    await send(makeMessage({ threadId: "unknown-conv" }));
    expect(store.sendActivity).not.toHaveBeenCalled();
  });
});
