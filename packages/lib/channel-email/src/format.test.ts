import { describe, expect, test } from "bun:test";
import type { OutboundMessage } from "@koi/core";
import { formatOutbound } from "./format.js";

const baseInput = {
  message: { content: [{ kind: "text", text: "hello" }] } satisfies OutboundMessage,
  thread: { chain: [] as readonly string[] },
  outboundMessageId: "<m1@bot.example.com>",
  from: "bot@example.com",
  to: ["alice@example.com"],
  subject: "Re: Hi",
};

describe("formatOutbound", () => {
  test("text-only happy path", () => {
    const r = formatOutbound(baseInput);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.from).toBe("bot@example.com");
      expect(r.value.to).toEqual(["alice@example.com"]);
      expect(r.value.subject).toBe("Re: Hi");
      expect(r.value.text).toBe("hello");
      expect(r.value.html).toBeUndefined();
      expect(r.value.headers).toEqual({ "Message-ID": "<m1@bot.example.com>" });
    }
  });

  test("multiple text blocks join with double newline", () => {
    const r = formatOutbound({
      ...baseInput,
      message: {
        content: [
          { kind: "text", text: "first" },
          { kind: "text", text: "second" },
        ],
      },
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.text).toBe("first\n\nsecond");
  });

  test("non-text blocks fail closed with UNSUPPORTED_BLOCK", () => {
    // Regression: previously formatOutbound silently dropped image/file/
    // button blocks while still returning an SMTP envelope with only the
    // text portion. The outbox would then advance to `sent` for a
    // truncated mail; if the message was entirely non-text, an empty
    // body was emitted with no operator signal. Now the formatter fails
    // closed and executeOutbound rejects pre-flight before reserving a
    // thread slot.
    const r = formatOutbound({
      ...baseInput,
      message: {
        content: [
          { kind: "text", text: "hi" },
          { kind: "image", url: "https://x/y.png" },
        ],
      },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("UNSUPPORTED_BLOCK");
      expect(r.error.context.kind).toBe("image");
    }
  });

  test("all-non-text content fails closed (does not emit empty body)", () => {
    const r = formatOutbound({
      ...baseInput,
      message: { content: [{ kind: "image", url: "https://x" }] },
    });
    expect(r.ok).toBe(false);
  });

  test("threaded reply includes In-Reply-To and References", () => {
    const r = formatOutbound({
      ...baseInput,
      thread: { chain: ["<m0@example.com>", "<m1@example.com>"] },
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.headers).toEqual({
        "Message-ID": "<m1@bot.example.com>",
        "In-Reply-To": "<m1@example.com>",
        References: "<m0@example.com> <m1@example.com>",
      });
    }
  });

  test("metadata.html populates html field", () => {
    const r = formatOutbound({
      ...baseInput,
      message: {
        content: [{ kind: "text", text: "fallback" }],
        metadata: { html: "<p>fallback</p>" },
      },
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.html).toBe("<p>fallback</p>");
  });

  test("empty content yields empty text envelope", () => {
    const r = formatOutbound({ ...baseInput, message: { content: [] } });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.text).toBe("");
  });
});
