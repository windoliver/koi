import { describe, expect, test } from "bun:test";
import { computeContentHash } from "./hash.js";
import { contentHash } from "./types.js";

describe("computeContentHash", () => {
  test("returns correct SHA-256 hex for known input", () => {
    // Deterministic serialization wraps strings in quotes before hashing
    const hash = computeContentHash("hello");
    expect(hash).toBe(
      contentHash("5aa762ae383fbb727af3c7a36d4940a5b8c40a989452d2304fc958ff3f354e7a"),
    );
  });

  test("returns correct SHA-256 for empty string", () => {
    // Deterministic serialization wraps strings in quotes before hashing
    const hash = computeContentHash("");
    expect(hash).toBe(
      contentHash("12ae32cb1ec02d01eda3581b127c1fee3b0dc53572ed6baf239721a03d82e126"),
    );
  });

  test("is deterministic (same input -> same output)", () => {
    const hash1 = computeContentHash("deterministic-test");
    const hash2 = computeContentHash("deterministic-test");
    expect(hash1).toBe(hash2);
  });

  test("different inputs produce different hashes", () => {
    const hash1 = computeContentHash("input-a");
    const hash2 = computeContentHash("input-b");
    expect(hash1).not.toBe(hash2);
  });

  test("handles unicode content", () => {
    const hash = computeContentHash("日本語テスト 🎉");
    expect(typeof hash).toBe("string");
    expect(hash.length).toBe(64); // SHA-256 hex is always 64 chars
  });
});
