import { describe, expect, test } from "bun:test";
import { normalizeEmail } from "./normalize.js";

const baseImap = { uidValidity: 1, uid: 100 };

const baseParsed = {
  messageId: "<m1@example.com>",
  from: { value: [{ address: "Alice@Example.com" }] },
  to: { value: [{ address: "bot@x" }] },
  subject: "Hi",
  date: new Date(1_700_000_000_000),
  text: "hello world",
};

describe("normalizeEmail", () => {
  test("happy path: text body produces InboundMessage", () => {
    const r = normalizeEmail({ parsed: baseParsed, imap: baseImap });
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    expect(r.value.senderId).toBe("alice@example.com");
    expect(r.value.timestamp).toBe(1_700_000_000_000);
    expect(r.value.content).toEqual([{ kind: "text", text: "hello world" }]);
    expect(r.value.threadId).toBe("<m1@example.com>");
    expect(r.value.metadata).toMatchObject({
      uidValidity: 1,
      uid: 100,
      messageId: "<m1@example.com>",
    });
  });

  test("missing Message-ID returns UNSUPPORTED_TRANSPORT", () => {
    const r = normalizeEmail({
      parsed: { ...baseParsed, messageId: undefined },
      imap: baseImap,
    });
    expect(r).toEqual({
      ok: false,
      error: {
        code: "UNSUPPORTED_TRANSPORT",
        message: expect.stringContaining("Message-ID"),
      },
    });
  });

  test("missing From returns PARSE_FAILED", () => {
    const r = normalizeEmail({
      parsed: { ...baseParsed, from: undefined },
      imap: baseImap,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("PARSE_FAILED");
  });

  test("uses references root as threadId", () => {
    const r = normalizeEmail({
      parsed: {
        ...baseParsed,
        messageId: "<m3@example.com>",
        inReplyTo: "<m2@example.com>",
        references: "<m1@example.com> <m2@example.com>",
      },
      imap: baseImap,
    });
    if (!r.ok) throw new Error();
    expect(r.value.threadId).toBe("<m1@example.com>");
  });

  test("falls back to html when text missing", () => {
    const r = normalizeEmail({
      parsed: { ...baseParsed, text: undefined, html: "<p>hi <b>there</b>&amp;</p>" },
      imap: baseImap,
    });
    if (!r.ok) throw new Error();
    expect(r.value.content).toEqual([{ kind: "text", text: "hi there&" }]);
  });

  test("missing date uses injected clock", () => {
    const r = normalizeEmail(
      { parsed: { ...baseParsed, date: undefined }, imap: baseImap },
      () => 42,
    );
    if (!r.ok) throw new Error();
    expect(r.value.timestamp).toBe(42);
  });

  test("attachments populate metadata", () => {
    const r = normalizeEmail({
      parsed: {
        ...baseParsed,
        attachments: [{ filename: "a.pdf", contentType: "application/pdf", size: 100 }],
      },
      imap: baseImap,
    });
    if (!r.ok) throw new Error();
    expect((r.value.metadata as { attachments?: unknown }).attachments).toEqual([
      { filename: "a.pdf", contentType: "application/pdf", size: 100 },
    ]);
  });
});
