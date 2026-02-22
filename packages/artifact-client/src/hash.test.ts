import { describe, expect, test } from "bun:test";
import { computeContentHash } from "./hash.js";
import { contentHash } from "./types.js";

describe("computeContentHash", () => {
  test("returns correct SHA-256 hex for known input", async () => {
    // SHA-256 of "hello" = 2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824
    const hash = await computeContentHash("hello");
    expect(hash).toBe(
      contentHash("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"),
    );
  });

  test("returns correct SHA-256 for empty string", async () => {
    // SHA-256 of "" = e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
    const hash = await computeContentHash("");
    expect(hash).toBe(
      contentHash("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"),
    );
  });

  test("is deterministic (same input → same output)", async () => {
    const hash1 = await computeContentHash("deterministic-test");
    const hash2 = await computeContentHash("deterministic-test");
    expect(hash1).toBe(hash2);
  });

  test("different inputs produce different hashes", async () => {
    const hash1 = await computeContentHash("input-a");
    const hash2 = await computeContentHash("input-b");
    expect(hash1).not.toBe(hash2);
  });

  test("handles unicode content", async () => {
    const hash = await computeContentHash("日本語テスト 🎉");
    expect(typeof hash).toBe("string");
    expect(hash.length).toBe(64); // SHA-256 hex is always 64 chars
  });
});
