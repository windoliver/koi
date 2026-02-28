import { describe, expect, mock, test } from "bun:test";
import type { OutboundMessage } from "@koi/core";
import { createPlatformSend } from "./platform-send.js";
import type { SignalProcess } from "./signal-process.js";

function makeMockProcess(): SignalProcess & { readonly send: ReturnType<typeof mock> } {
  return {
    start: mock(async () => {}),
    stop: mock(async () => {}),
    send: mock(async () => {}),
    onEvent: mock(() => () => {}),
    isRunning: mock(() => true),
  };
}

function makeMessage(overrides: Partial<OutboundMessage> = {}): OutboundMessage {
  return {
    content: [{ kind: "text", text: "hello" }],
    threadId: "+1234567890",
    ...overrides,
  };
}

describe("createPlatformSend", () => {
  test("sends text to individual recipient", async () => {
    const proc = makeMockProcess();
    const send = createPlatformSend(proc, "+0987654321");
    await send(makeMessage());

    expect(proc.send).toHaveBeenCalledTimes(1);
    const call = proc.send.mock.calls[0]?.[0] as {
      readonly method: string;
      readonly params: Record<string, unknown>;
    };
    expect(call.method).toBe("send");
    expect(call.params.message).toBe("hello");
    expect(call.params.recipient).toBe("+1234567890");
    expect(call.params.account).toBe("+0987654321");
  });

  test("sends text to group when threadId starts with group.", async () => {
    const proc = makeMockProcess();
    const send = createPlatformSend(proc, "+0987654321");
    await send(makeMessage({ threadId: "group.abc123" }));

    const call = proc.send.mock.calls[0]?.[0] as { readonly params: Record<string, unknown> };
    expect(call.params.groupId).toBe("group.abc123");
    expect(call.params.recipient).toBeUndefined();
  });

  test("merges multiple text blocks with newlines", async () => {
    const proc = makeMockProcess();
    const send = createPlatformSend(proc, "+0987654321");
    await send(
      makeMessage({
        content: [
          { kind: "text", text: "line 1" },
          { kind: "text", text: "line 2" },
        ],
      }),
    );

    const call = proc.send.mock.calls[0]?.[0] as { readonly params: Record<string, unknown> };
    expect(call.params.message).toBe("line 1\nline 2");
  });

  test("renders image blocks as text fallback", async () => {
    const proc = makeMockProcess();
    const send = createPlatformSend(proc, "+0987654321");
    await send(
      makeMessage({
        content: [{ kind: "image", url: "https://example.com/img.jpg", alt: "photo" }],
      }),
    );

    const call = proc.send.mock.calls[0]?.[0] as { readonly params: Record<string, unknown> };
    expect(call.params.message).toBe("[Image: photo]");
  });

  test("renders button blocks as text fallback", async () => {
    const proc = makeMockProcess();
    const send = createPlatformSend(proc, "+0987654321");
    await send(
      makeMessage({
        content: [{ kind: "button", label: "OK", action: "confirm", payload: {} }],
      }),
    );

    const call = proc.send.mock.calls[0]?.[0] as { readonly params: Record<string, unknown> };
    expect(call.params.message).toBe("[OK]");
  });

  test("skips custom blocks", async () => {
    const proc = makeMockProcess();
    const send = createPlatformSend(proc, "+0987654321");
    await send(
      makeMessage({
        content: [{ kind: "custom", type: "special", data: {} }],
      }),
    );

    expect(proc.send).not.toHaveBeenCalled();
  });

  test("chunks long text into multiple send commands", async () => {
    const proc = makeMockProcess();
    const send = createPlatformSend(proc, "+0987654321");
    const longText = "a".repeat(5000);
    await send(makeMessage({ content: [{ kind: "text", text: longText }] }));

    // 5000 chars at 4000 limit = 2 chunks = 2 send calls
    expect(proc.send).toHaveBeenCalledTimes(2);
    const first = (proc.send.mock.calls[0]?.[0] as { readonly params: Record<string, unknown> })
      .params.message as string;
    const second = (proc.send.mock.calls[1]?.[0] as { readonly params: Record<string, unknown> })
      .params.message as string;
    expect(first.length).toBeLessThanOrEqual(4000);
    expect(first.length + second.length).toBe(5000);
  });

  test("silently skips when threadId is missing", async () => {
    const proc = makeMockProcess();
    const send = createPlatformSend(proc, "+0987654321");
    await send(makeMessage({ threadId: undefined }));
    expect(proc.send).not.toHaveBeenCalled();
  });
});
