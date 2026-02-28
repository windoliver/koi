import { describe, expect, it } from "bun:test";
import { sha256Hex } from "./sha256.js";

describe("sha256Hex", () => {
  it("returns a 64-character hex string", () => {
    const result = sha256Hex("hello");
    expect(result).toHaveLength(64);
    expect(result).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic — same input produces same output", () => {
    const a = sha256Hex("mandate:test-agent:session-123");
    const b = sha256Hex("mandate:test-agent:session-123");
    expect(a).toBe(b);
  });

  it("produces different hashes for different inputs", () => {
    const a = sha256Hex("input-A");
    const b = sha256Hex("input-B");
    expect(a).not.toBe(b);
  });

  it("handles empty string", () => {
    // SHA-256 of empty string is a well-known value
    const result = sha256Hex("");
    expect(result).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });

  it("handles unicode content", () => {
    const result = sha256Hex("こんにちは世界");
    expect(result).toHaveLength(64);
    expect(result).toMatch(/^[0-9a-f]{64}$/);
  });
});
