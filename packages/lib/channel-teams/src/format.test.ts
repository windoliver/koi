import { describe, expect, test } from "bun:test";
import { formatOutbound } from "./format.js";

describe("formatOutbound", () => {
  test("single text block", () => {
    const r = formatOutbound({ content: [{ kind: "text", text: "hi" }] });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ type: "message", text: "hi" });
  });

  test("multiple text blocks joined by blank lines", () => {
    const r = formatOutbound({
      content: [
        { kind: "text", text: "first" },
        { kind: "text", text: "second" },
      ],
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.text).toBe("first\n\nsecond");
  });

  test("non-text blocks fail closed with UNSUPPORTED_BLOCK", () => {
    // Regression: previously formatOutbound silently dropped image/file/
    // button blocks, so send() resolved while the user saw a partial
    // message on the wire and there was no operator signal. Now any
    // non-text block returns UNSUPPORTED_BLOCK and the channel send()
    // throws — the caller learns immediately that capability advertising
    // and outbound serializer disagree.
    const r = formatOutbound({
      content: [
        { kind: "text", text: "kept" },
        { kind: "image", url: "https://x/y.png" },
      ],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("UNSUPPORTED_BLOCK");
      expect(r.error.context.kind).toBe("image");
    }
  });

  test("file block fails closed", () => {
    const r = formatOutbound({
      content: [{ kind: "file", url: "https://x/y.pdf", mimeType: "application/pdf" }],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.context.kind).toBe("file");
  });
});
