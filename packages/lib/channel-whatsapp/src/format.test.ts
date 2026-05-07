import { describe, expect, test } from "bun:test";
import { formatOutbound } from "./format.js";

describe("formatOutbound", () => {
  test("single text block", () => {
    const r = formatOutbound({
      message: { content: [{ kind: "text", text: "hi" }] },
      recipient: "15551234567",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.messaging_product).toBe("whatsapp");
      expect(r.value.recipient_type).toBe("individual");
      expect(r.value.to).toBe("15551234567");
      expect(r.value.type).toBe("text");
      expect(r.value.text).toEqual({ body: "hi", preview_url: false });
      expect(r.value.context).toBeUndefined();
    }
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
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.text.body).toBe("first\n\nsecond");
  });

  test("threaded reply includes context.message_id", () => {
    const r = formatOutbound({
      message: { content: [{ kind: "text", text: "reply" }] },
      recipient: "15551234567",
      contextMessageId: "wamid.parent",
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.context).toEqual({ message_id: "wamid.parent" });
  });

  test("non-text blocks fail closed with UNSUPPORTED_BLOCK", () => {
    // Regression: previously formatOutbound silently dropped image/file/
    // button blocks while still emitting a text-only Cloud API payload.
    // send() resolved while the recipient saw a partial WhatsApp
    // message (or empty body, on all-non-text content) with no operator
    // signal. Now any non-text block returns UNSUPPORTED_BLOCK and
    // send() throws.
    const r = formatOutbound({
      message: {
        content: [
          { kind: "text", text: "kept" },
          { kind: "image", url: "https://x" },
        ],
      },
      recipient: "15551234567",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("UNSUPPORTED_BLOCK");
      expect(r.error.context.kind).toBe("image");
    }
  });

  test("all-non-text content fails closed (does not emit empty body)", () => {
    const r = formatOutbound({
      message: { content: [{ kind: "image", url: "https://x" }] },
      recipient: "15551234567",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.context.kind).toBe("image");
  });
});
