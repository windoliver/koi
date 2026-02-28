import { describe, expect, mock, test } from "bun:test";
import type { OutboundMessage } from "@koi/core";
import type { SlackWebApi } from "./platform-send.js";
import { slackSend } from "./platform-send.js";

function createMockApi(): SlackWebApi & {
  readonly calls: Record<string, unknown>[];
} {
  const calls: Record<string, unknown>[] = [];
  return {
    calls,
    postMessage: mock(async (args: Record<string, unknown>) => {
      calls.push(args);
      return { ok: true };
    }),
  };
}

function msg(content: OutboundMessage["content"], threadId?: string): OutboundMessage {
  if (threadId !== undefined) {
    return { content, threadId };
  }
  return { content };
}

describe("slackSend", () => {
  test("silently skips when threadId is undefined", async () => {
    const api = createMockApi();
    await slackSend(api, msg([{ kind: "text", text: "hello" }]));
    expect(api.calls).toHaveLength(0);
  });

  test("sends text message to channel", async () => {
    const api = createMockApi();
    await slackSend(api, msg([{ kind: "text", text: "hello" }], "C456"));

    expect(api.calls).toHaveLength(1);
    expect(api.calls[0]?.channel).toBe("C456");
    expect(api.calls[0]?.text).toBe("hello");
  });

  test("sends to thread when threadId contains colon", async () => {
    const api = createMockApi();
    await slackSend(api, msg([{ kind: "text", text: "reply" }], "C456:123.456"));

    expect(api.calls).toHaveLength(1);
    expect(api.calls[0]?.channel).toBe("C456");
    expect(api.calls[0]?.thread_ts).toBe("123.456");
  });

  test("splits long text at 4000-char boundary", async () => {
    const api = createMockApi();
    const longText = "x".repeat(5000);
    await slackSend(api, msg([{ kind: "text", text: longText }], "C456"));

    expect(api.calls.length).toBeGreaterThan(1);
  });

  test("sends image block", async () => {
    const api = createMockApi();
    await slackSend(
      api,
      msg([{ kind: "image", url: "https://example.com/img.png", alt: "a cat" }], "C456"),
    );

    expect(api.calls).toHaveLength(1);
    const blocks = api.calls[0]?.blocks as readonly Record<string, unknown>[];
    expect(blocks).toBeDefined();
    const imageBlock = blocks.find((b: Record<string, unknown>) => b.type === "image");
    expect(imageBlock).toBeDefined();
    expect((imageBlock as Record<string, unknown>).image_url).toBe("https://example.com/img.png");
  });

  test("sends button as actions block", async () => {
    const api = createMockApi();
    await slackSend(api, msg([{ kind: "button", label: "Click me", action: "btn_click" }], "C456"));

    expect(api.calls).toHaveLength(1);
    const blocks = api.calls[0]?.blocks as readonly Record<string, unknown>[];
    const actionsBlock = blocks.find((b: Record<string, unknown>) => b.type === "actions");
    expect(actionsBlock).toBeDefined();
  });

  test("sends file as text link", async () => {
    const api = createMockApi();
    await slackSend(
      api,
      msg(
        [
          {
            kind: "file",
            url: "https://example.com/doc.pdf",
            mimeType: "application/pdf",
            name: "doc.pdf",
          },
        ],
        "C456",
      ),
    );

    expect(api.calls).toHaveLength(1);
    const text = api.calls[0]?.text as string;
    expect(text).toContain("<https://example.com/doc.pdf|doc.pdf>");
  });

  test("handles custom slack:block pass-through", async () => {
    const api = createMockApi();
    const customBlock = { type: "divider" };
    await slackSend(api, msg([{ kind: "custom", type: "slack:block", data: customBlock }], "C456"));

    expect(api.calls).toHaveLength(1);
    const blocks = api.calls[0]?.blocks as readonly Record<string, unknown>[];
    expect(blocks).toContainEqual(customBlock);
  });

  test("silently skips unknown custom block types", async () => {
    const api = createMockApi();
    await slackSend(api, msg([{ kind: "custom", type: "unknown:thing", data: {} }], "C456"));

    // Nothing sent — no text, no blocks
    expect(api.calls).toHaveLength(0);
  });

  test("merges adjacent text blocks", async () => {
    const api = createMockApi();
    await slackSend(
      api,
      msg(
        [
          { kind: "text", text: "line 1" },
          { kind: "text", text: "line 2" },
        ],
        "C456",
      ),
    );

    expect(api.calls).toHaveLength(1);
    expect(api.calls[0]?.text).toBe("line 1\nline 2");
  });

  test("flushes when max buttons reached", async () => {
    const api = createMockApi();
    const buttons = Array.from({ length: 6 }, (_, i) => ({
      kind: "button" as const,
      label: `btn${i}`,
      action: `action${i}`,
    }));
    await slackSend(api, msg(buttons, "C456"));

    // 5 buttons flush, then 1 more in a second message
    expect(api.calls).toHaveLength(2);
  });

  test("includes button value when payload is provided", async () => {
    const api = createMockApi();
    await slackSend(
      api,
      msg([{ kind: "button", label: "Approve", action: "approve", payload: "order_123" }], "C456"),
    );

    expect(api.calls).toHaveLength(1);
    const blocks = api.calls[0]?.blocks as readonly Record<string, unknown>[];
    const actionsBlock = blocks.find(
      (b: Record<string, unknown>) => b.type === "actions",
    ) as Record<string, unknown>;
    const elements = actionsBlock.elements as readonly Record<string, unknown>[];
    expect(elements[0]?.value).toBe("order_123");
  });
});
