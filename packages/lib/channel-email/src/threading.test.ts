import { describe, expect, test } from "bun:test";
import { deriveReplyHeaders, extractThreadKey } from "./threading.js";

describe("extractThreadKey", () => {
  test("uses references root if present", () => {
    expect(
      extractThreadKey({
        messageId: "<m3@a>",
        inReplyTo: "<m2@a>",
        references: ["<m1@a>", "<m2@a>"],
      }),
    ).toBe("<m1@a>");
  });

  test("falls back to inReplyTo when references missing", () => {
    expect(extractThreadKey({ messageId: "<m2@a>", inReplyTo: "<m1@a>", references: [] })).toBe(
      "<m1@a>",
    );
  });

  test("falls back to messageId for new thread", () => {
    expect(extractThreadKey({ messageId: "<m1@a>", references: [] })).toBe("<m1@a>");
  });
});

describe("deriveReplyHeaders", () => {
  test("empty chain produces no headers", () => {
    expect(deriveReplyHeaders({ chain: [] })).toEqual({});
  });

  test("single-element chain sets In-Reply-To and References", () => {
    expect(deriveReplyHeaders({ chain: ["<m1@a>"] })).toEqual({
      "In-Reply-To": "<m1@a>",
      References: "<m1@a>",
    });
  });

  test("multi-element chain references whole chain, In-Reply-To is last", () => {
    expect(deriveReplyHeaders({ chain: ["<m1@a>", "<m2@a>", "<m3@a>"] })).toEqual({
      "In-Reply-To": "<m3@a>",
      References: "<m1@a> <m2@a> <m3@a>",
    });
  });
});
