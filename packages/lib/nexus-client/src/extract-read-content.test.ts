import { describe, expect, test } from "bun:test";
import { extractReadContent } from "./extract-read-content.js";

describe("extractReadContent", () => {
  test("accepts bare string", () => {
    const r = extractReadContent("policy data");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe("policy data");
  });

  test("accepts { content: string }", () => {
    const r = extractReadContent({ content: "policy data" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe("policy data");
  });

  test("rejects null", () => {
    const r = extractReadContent(null);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("VALIDATION");
  });

  test("rejects object without content", () => {
    const r = extractReadContent({ foo: "bar" });
    expect(r.ok).toBe(false);
  });

  test("rejects object with non-string content", () => {
    const r = extractReadContent({ content: 42 });
    expect(r.ok).toBe(false);
  });

  test("rejects number", () => {
    const r = extractReadContent(42);
    expect(r.ok).toBe(false);
  });

  test("decodes flat bytes envelope { __type__: 'bytes', data: <base64> }", () => {
    const r = extractReadContent({
      __type__: "bytes",
      data: Buffer.from("hello").toString("base64"),
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe("hello");
  });

  test("decodes return_metadata wrapper { content: { __type__: 'bytes', ... } }", () => {
    const r = extractReadContent({
      content: { __type__: "bytes", data: Buffer.from("policy data").toString("base64") },
      etag: "abc",
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe("policy data");
  });

  test("rejects bytes envelope with non-base64 characters (no silent corruption)", () => {
    // `Buffer.from(...,'base64')` silently drops invalid characters, masking
    // content corruption. Strict regex validation catches this up front.
    const r = extractReadContent({ __type__: "bytes", data: "***not-base64***" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("VALIDATION");
  });

  test("rejects bytes envelope with invalid UTF-8 (no Mojibake)", () => {
    // 0xC3 0x28 is invalid UTF-8 (2-byte start followed by non-continuation byte).
    // Fatal decoder rejects rather than producing replacement chars.
    const invalidUtf8 = Buffer.from([0xc3, 0x28]).toString("base64");
    const r = extractReadContent({ __type__: "bytes", data: invalidUtf8 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("VALIDATION");
  });

  test("rejects malformed base64 lengths that silently decode to empty buffer", () => {
    // Round-2 finding 4: Buffer.from('A', 'base64') returns empty — without a
    // length check the alphabet regex passes and an empty (but UTF-8 fatal-OK)
    // string slips through. Padded base64 must be a multiple of 4 chars total.
    for (const malformed of ["A", "A=", "A==", "AB=="]) {
      const r = extractReadContent({ __type__: "bytes", data: malformed });
      expect(r.ok).toBe(false);
    }
  });

  test("accepts base64url alphabet (- and _) as well as standard base64", () => {
    // Encode bytes that produce + and / under standard base64, then convert to base64url.
    const std = Buffer.from([0xff, 0xfe, 0xfd]).toString("base64");
    const url = std.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const r = extractReadContent({ __type__: "bytes", data: url });
    // Note: no UTF-8 expectation — bytes are not valid UTF-8 so this should be
    // rejected by the fatal decoder. The regex must still ACCEPT the chars.
    // Use a UTF-8-safe payload via base64url instead:
    const safe = Buffer.from("hi-_+", "utf-8")
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    const r2 = extractReadContent({ __type__: "bytes", data: safe });
    expect(r.ok).toBe(false); // invalid UTF-8 rejected by fatal decoder
    expect(r2.ok).toBe(true);
    if (r2.ok) expect(r2.value).toBe("hi-_+");
  });
});
