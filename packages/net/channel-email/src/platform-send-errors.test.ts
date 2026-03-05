/**
 * Error path tests for emailSend().
 *
 * Validates SMTP failures propagate correctly.
 */

import { describe, expect, mock, test } from "bun:test";
import type { EmailTransporter, ReplyContext } from "./platform-send.js";
import { emailSend } from "./platform-send.js";

const FROM_ADDRESS = "bot@example.com";
const REPLY_CONTEXT: ReplyContext = {
  originalMessageId: "<msg001@example.com>",
  toAddress: "user@example.com",
  subject: "Test",
};

describe("emailSend — error paths", () => {
  test("propagates SMTP send failure", async () => {
    const transporter: EmailTransporter = {
      sendMail: mock(async () => {
        throw new Error("SMTP connection refused");
      }),
    };

    await expect(
      emailSend(
        transporter,
        FROM_ADDRESS,
        undefined,
        {
          content: [{ kind: "text", text: "hello" }],
          threadId: "thread-1",
        },
        REPLY_CONTEXT,
      ),
    ).rejects.toThrow("SMTP connection refused");
  });

  test("propagates authentication error", async () => {
    const transporter: EmailTransporter = {
      sendMail: mock(async () => {
        throw new Error("535 Authentication failed");
      }),
    };

    await expect(
      emailSend(
        transporter,
        FROM_ADDRESS,
        undefined,
        {
          content: [{ kind: "text", text: "hello" }],
          threadId: "thread-1",
        },
        REPLY_CONTEXT,
      ),
    ).rejects.toThrow("535 Authentication failed");
  });

  test("does not call sendMail when replyContext is undefined", async () => {
    const sendMail = mock(async () => ({ messageId: "<test>" }));
    const transporter: EmailTransporter = { sendMail };

    await emailSend(transporter, FROM_ADDRESS, undefined, {
      content: [{ kind: "text", text: "hello" }],
      threadId: "thread-1",
    });

    expect(sendMail).not.toHaveBeenCalled();
  });
});
