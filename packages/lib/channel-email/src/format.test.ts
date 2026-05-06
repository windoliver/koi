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
    const env = formatOutbound(baseInput);
    expect(env.from).toBe("bot@example.com");
    expect(env.to).toEqual(["alice@example.com"]);
    expect(env.subject).toBe("Re: Hi");
    expect(env.text).toBe("hello");
    expect(env.html).toBeUndefined();
    expect(env.headers).toEqual({ "Message-ID": "<m1@bot.example.com>" });
  });

  test("multiple text blocks join with double newline", () => {
    const env = formatOutbound({
      ...baseInput,
      message: {
        content: [
          { kind: "text", text: "first" },
          { kind: "text", text: "second" },
        ],
      },
    });
    expect(env.text).toBe("first\n\nsecond");
  });

  test("non-text blocks silently dropped from body", () => {
    const env = formatOutbound({
      ...baseInput,
      message: {
        content: [
          { kind: "text", text: "hi" },
          { kind: "image", url: "https://x/y.png" },
          { kind: "text", text: "bye" },
        ],
      },
    });
    expect(env.text).toBe("hi\n\nbye");
  });

  test("threaded reply includes In-Reply-To and References", () => {
    const env = formatOutbound({
      ...baseInput,
      thread: { chain: ["<m0@example.com>", "<m1@example.com>"] },
    });
    expect(env.headers).toEqual({
      "Message-ID": "<m1@bot.example.com>",
      "In-Reply-To": "<m1@example.com>",
      References: "<m0@example.com> <m1@example.com>",
    });
  });

  test("metadata.html populates html field", () => {
    const env = formatOutbound({
      ...baseInput,
      message: {
        content: [{ kind: "text", text: "fallback" }],
        metadata: { html: "<p>fallback</p>" },
      },
    });
    expect(env.html).toBe("<p>fallback</p>");
  });

  test("empty content yields empty text", () => {
    const env = formatOutbound({ ...baseInput, message: { content: [] } });
    expect(env.text).toBe("");
  });
});
