import { describe, expect, test } from "bun:test";
import { formatOutbound } from "./format.js";

describe("formatOutbound", () => {
  test("single text block", () => {
    const r = formatOutbound({
      message: { content: [{ kind: "text", text: "hi" }] },
      recipient: "15551234567",
    });
    expect(r.messaging_product).toBe("whatsapp");
    expect(r.recipient_type).toBe("individual");
    expect(r.to).toBe("15551234567");
    expect(r.type).toBe("text");
    expect(r.text).toEqual({ body: "hi", preview_url: false });
    expect(r.context).toBeUndefined();
  });

  test("multiple text blocks joined by blank lines", () => {
    const r = formatOutbound({
      message: {
        content: [
          { kind: "text", text: "first" },
          { kind: "text", text: "second" },
        ],
      },
      recipient: "15551234567",
    });
    expect(r.text.body).toBe("first\n\nsecond");
  });

  test("threaded reply includes context.message_id", () => {
    const r = formatOutbound({
      message: { content: [{ kind: "text", text: "reply" }] },
      recipient: "15551234567",
      contextMessageId: "wamid.parent",
    });
    expect(r.context).toEqual({ message_id: "wamid.parent" });
  });

  test("non-text blocks silently dropped", () => {
    const r = formatOutbound({
      message: {
        content: [
          { kind: "text", text: "kept" },
          { kind: "image", url: "https://x" },
          { kind: "file", url: "https://x", mimeType: "application/pdf" },
        ],
      },
      recipient: "15551234567",
    });
    expect(r.text.body).toBe("kept");
  });
});
