import { describe, expect, mock, test } from "bun:test";
import type { OutboundMessage } from "@koi/core";
import type { EmailTransporter, ReplyContext } from "./platform-send.js";
import { emailSend } from "./platform-send.js";

function createMockTransporter(): EmailTransporter & {
  readonly calls: Record<string, unknown>[];
} {
  const calls: Record<string, unknown>[] = [];
  return {
    calls,
    sendMail: mock(async (options: Record<string, unknown>) => {
      calls.push(options);
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

const DEFAULT_REPLY: ReplyContext = {
  originalMessageId: "<orig@example.com>",
  toAddress: "user@example.com",
  subject: "Test",
};

describe("emailSend", () => {
  test("returns without sending when replyContext is undefined", async () => {
    const transporter = createMockTransporter();
    await emailSend(
      transporter,
      "bot@example.com",
      undefined,
      msg([{ kind: "text", text: "hello" }]),
    );
    expect(transporter.calls).toHaveLength(0);
  });

  test("returns without sending when content is empty", async () => {
    const transporter = createMockTransporter();
    await emailSend(transporter, "bot@example.com", undefined, msg([]), DEFAULT_REPLY);
    expect(transporter.calls).toHaveLength(0);
  });

  test("sends text email with reply headers", async () => {
    const transporter = createMockTransporter();
    await emailSend(
      transporter,
      "bot@example.com",
      "Bot",
      msg([{ kind: "text", text: "Hello back" }], "<orig@example.com>"),
      DEFAULT_REPLY,
    );

    expect(transporter.calls).toHaveLength(1);
    const email = transporter.calls[0];
    expect(email?.from).toBe('"Bot" <bot@example.com>');
    expect(email?.to).toBe("user@example.com");
    expect(email?.subject).toBe("Re: Test");
    expect(email?.text).toBe("Hello back");
    expect(email?.html).toContain("Hello back");
  });

  test("uses fromAddress without name when fromName is undefined", async () => {
    const transporter = createMockTransporter();
    await emailSend(
      transporter,
      "bot@example.com",
      undefined,
      msg([{ kind: "text", text: "hello" }], "<orig@example.com>"),
      DEFAULT_REPLY,
    );

    expect(transporter.calls[0]?.from).toBe("bot@example.com");
  });

  test("includes In-Reply-To and References headers", async () => {
    const transporter = createMockTransporter();
    await emailSend(
      transporter,
      "bot@example.com",
      undefined,
      msg([{ kind: "text", text: "hello" }], "<orig@example.com>"),
      {
        originalMessageId: "<orig@example.com>",
        originalReferences: "<ref1@example.com>",
        toAddress: "user@example.com",
        subject: "Test",
      },
    );

    const headers = transporter.calls[0]?.headers as Record<string, string>;
    expect(headers["In-Reply-To"]).toBe("<orig@example.com>");
    expect(headers.References).toContain("<ref1@example.com>");
    expect(headers.References).toContain("<orig@example.com>");
  });

  test("sends image as attachment", async () => {
    const transporter = createMockTransporter();
    await emailSend(
      transporter,
      "bot@example.com",
      undefined,
      msg(
        [{ kind: "image", url: "https://example.com/img.jpg", alt: "photo" }],
        "<orig@example.com>",
      ),
      DEFAULT_REPLY,
    );

    const attachments = transporter.calls[0]?.attachments as readonly Record<string, unknown>[];
    expect(attachments).toHaveLength(1);
    expect(attachments[0]?.filename).toBe("photo");
  });

  test("sends file as attachment", async () => {
    const transporter = createMockTransporter();
    await emailSend(
      transporter,
      "bot@example.com",
      undefined,
      msg(
        [
          {
            kind: "file",
            url: "https://example.com/doc.pdf",
            mimeType: "application/pdf",
            name: "doc.pdf",
          },
        ],
        "<orig@example.com>",
      ),
      DEFAULT_REPLY,
    );

    const attachments = transporter.calls[0]?.attachments as readonly Record<string, unknown>[];
    expect(attachments).toHaveLength(1);
    expect(attachments[0]?.filename).toBe("doc.pdf");
    expect(attachments[0]?.contentType).toBe("application/pdf");
  });

  test("renders button as text link", async () => {
    const transporter = createMockTransporter();
    await emailSend(
      transporter,
      "bot@example.com",
      undefined,
      msg([{ kind: "button", label: "Click me", action: "btn" }], "<orig@example.com>"),
      DEFAULT_REPLY,
    );

    expect(transporter.calls[0]?.text).toContain("[Click me]");
  });

  test("skips custom blocks", async () => {
    const transporter = createMockTransporter();
    await emailSend(
      transporter,
      "bot@example.com",
      undefined,
      msg(
        [
          { kind: "text", text: "hello" },
          { kind: "custom", type: "something", data: {} },
        ],
        "<orig@example.com>",
      ),
      DEFAULT_REPLY,
    );

    expect(transporter.calls[0]?.text).toBe("hello");
  });

  test("merges adjacent text blocks", async () => {
    const transporter = createMockTransporter();
    await emailSend(
      transporter,
      "bot@example.com",
      undefined,
      msg(
        [
          { kind: "text", text: "line 1" },
          { kind: "text", text: "line 2" },
        ],
        "<orig@example.com>",
      ),
      DEFAULT_REPLY,
    );

    expect(transporter.calls[0]?.text).toBe("line 1\nline 2");
  });

  test("uses (no subject) when subject is missing", async () => {
    const transporter = createMockTransporter();
    await emailSend(
      transporter,
      "bot@example.com",
      undefined,
      msg([{ kind: "text", text: "hello" }], "<orig@example.com>"),
      {
        originalMessageId: "<orig@example.com>",
        toAddress: "user@example.com",
      },
    );

    expect(transporter.calls[0]?.subject).toBe("Re: (no subject)");
  });
});
