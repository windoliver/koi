import { describe, expect, test } from "bun:test";
import { createReplyHeaders, extractDomain, generateMessageId } from "./threading.js";

describe("createReplyHeaders", () => {
  test("creates In-Reply-To and References headers", () => {
    const headers = createReplyHeaders("<original@example.com>");

    expect(headers.inReplyTo).toBe("<original@example.com>");
    expect(headers.references).toBe("<original@example.com>");
  });

  test("appends to existing references (string)", () => {
    const headers = createReplyHeaders("<msg2@example.com>", "<msg1@example.com>");

    expect(headers.inReplyTo).toBe("<msg2@example.com>");
    expect(headers.references).toBe("<msg1@example.com> <msg2@example.com>");
  });

  test("appends to existing references (array)", () => {
    const headers = createReplyHeaders("<msg3@example.com>", [
      "<msg1@example.com>",
      "<msg2@example.com>",
    ]);

    expect(headers.references).toBe("<msg1@example.com> <msg2@example.com> <msg3@example.com>");
  });

  test("handles undefined references", () => {
    const headers = createReplyHeaders("<msg@example.com>", undefined);
    expect(headers.references).toBe("<msg@example.com>");
  });

  test("handles empty string references", () => {
    const headers = createReplyHeaders("<msg@example.com>", "");
    expect(headers.references).toBe("<msg@example.com>");
  });
});

describe("generateMessageId", () => {
  test("generates a valid Message-ID format", () => {
    const id = generateMessageId("example.com");
    expect(id).toMatch(/^<\d+\.\w+@example\.com>$/);
  });

  test("generates unique IDs", () => {
    const id1 = generateMessageId("example.com");
    const id2 = generateMessageId("example.com");
    expect(id1).not.toBe(id2);
  });
});

describe("extractDomain", () => {
  test("extracts domain from email address", () => {
    expect(extractDomain("user@example.com")).toBe("example.com");
  });

  test("returns 'localhost' for invalid address", () => {
    expect(extractDomain("no-at-sign")).toBe("localhost");
  });
});
