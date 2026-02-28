import { describe, expect, test } from "bun:test";
import { normalizeEmail } from "./normalize.js";
import { createMockParsedEmail } from "./test-helpers.js";

describe("normalizeEmail", () => {
  test("normalizes text email", () => {
    const email = createMockParsedEmail({ text: "Hello world" });
    const result = normalizeEmail({ kind: "email", email, uid: 1 });

    expect(result).not.toBeNull();
    expect(result?.content[0]).toEqual({ kind: "text", text: "Hello world" });
    expect(result?.senderId).toBe("sender@example.com");
    expect(result?.threadId).toBe("<msg001@example.com>");
  });

  test("includes subject in metadata", () => {
    const email = createMockParsedEmail({ subject: "Important" });
    const result = normalizeEmail({ kind: "email", email, uid: 1 });

    expect(result?.metadata?.subject).toBe("Important");
  });

  test("includes inReplyTo in metadata", () => {
    const email = createMockParsedEmail({
      inReplyTo: "<original@example.com>",
    });
    const result = normalizeEmail({ kind: "email", email, uid: 1 });

    expect(result?.metadata?.inReplyTo).toBe("<original@example.com>");
  });

  test("includes references in metadata", () => {
    const email = createMockParsedEmail({
      references: "<ref1@example.com> <ref2@example.com>",
    });
    const result = normalizeEmail({ kind: "email", email, uid: 1 });

    expect(result?.metadata?.references).toBe("<ref1@example.com> <ref2@example.com>");
  });

  test("returns null when sender is missing", () => {
    const email = createMockParsedEmail({ from: undefined });
    expect(normalizeEmail({ kind: "email", email, uid: 1 })).toBeNull();
  });

  test("returns null for empty email content", () => {
    const email = createMockParsedEmail({ text: undefined, html: undefined });
    expect(normalizeEmail({ kind: "email", email, uid: 1 })).toBeNull();
  });

  test("stores HTML as custom block when text is available", () => {
    const email = createMockParsedEmail({
      text: "plain text",
      html: "<p>html content</p>",
    });
    const result = normalizeEmail({ kind: "email", email, uid: 1 });

    expect(result?.content).toHaveLength(2);
    expect(result?.content[0]?.kind).toBe("text");
    expect(result?.content[1]).toEqual({
      kind: "custom",
      type: "email:html",
      data: { html: "<p>html content</p>" },
    });
  });

  test("adds placeholder text when only HTML is available", () => {
    const email = createMockParsedEmail({ text: undefined, html: "<p>only html</p>" });
    const result = normalizeEmail({ kind: "email", email, uid: 1 });

    expect(result?.content[0]).toEqual({
      kind: "text",
      text: "[HTML email — see metadata for full content]",
    });
  });

  test("normalizes image attachment", () => {
    const email = createMockParsedEmail({
      attachments: [
        {
          filename: "photo.jpg",
          contentType: "image/jpeg",
          content: Buffer.from("fake-image"),
          size: 100,
        },
      ],
    });
    const result = normalizeEmail({ kind: "email", email, uid: 1 });

    const imageBlock = result?.content.find((b) => b.kind === "image");
    expect(imageBlock).toBeDefined();
    expect(imageBlock?.kind).toBe("image");
  });

  test("normalizes file attachment", () => {
    const email = createMockParsedEmail({
      attachments: [
        {
          filename: "report.pdf",
          contentType: "application/pdf",
          content: Buffer.from("fake-pdf"),
          size: 200,
        },
      ],
    });
    const result = normalizeEmail({ kind: "email", email, uid: 1 });

    const fileBlock = result?.content.find((b) => b.kind === "file");
    expect(fileBlock).toBeDefined();
    expect(fileBlock?.kind).toBe("file");
  });

  test("skips inline CID attachments", () => {
    const email = createMockParsedEmail({
      text: "text content",
      attachments: [
        {
          filename: "inline.png",
          contentType: "image/png",
          content: Buffer.from("fake"),
          cid: "inline-id",
          contentDisposition: "inline",
        },
      ],
    });
    const result = normalizeEmail({ kind: "email", email, uid: 1 });

    // Should only have text block, not the inline image
    expect(result?.content.filter((b) => b.kind === "image")).toHaveLength(0);
  });

  test("uses uid as fallback threadId when messageId is missing", () => {
    const email = createMockParsedEmail({ messageId: undefined });
    const result = normalizeEmail({ kind: "email", email, uid: 42 });

    expect(result?.threadId).toBe("uid:42");
  });

  test("uses current time when date is missing", () => {
    const email = createMockParsedEmail({ date: undefined });
    const before = Date.now();
    const result = normalizeEmail({ kind: "email", email, uid: 1 });
    const after = Date.now();

    expect(result?.timestamp).toBeGreaterThanOrEqual(before);
    expect(result?.timestamp).toBeLessThanOrEqual(after);
  });

  test("handles attachment without content", () => {
    const email = createMockParsedEmail({
      attachments: [
        {
          filename: "missing.bin",
          contentType: "application/octet-stream",
        },
      ],
    });
    const result = normalizeEmail({ kind: "email", email, uid: 1 });

    const fileBlock = result?.content.find((b) => b.kind === "file");
    expect(fileBlock).toBeDefined();
  });
});
