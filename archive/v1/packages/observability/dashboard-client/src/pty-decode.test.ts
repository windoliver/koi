import { describe, expect, test } from "bun:test";
import { decodePtyChunks } from "./pty-decode.js";

describe("decodePtyChunks", () => {
  test("returns empty Uint8Array for empty input", () => {
    const result = decodePtyChunks([]);
    expect(result).toBeInstanceOf(Uint8Array);
    expect(result.length).toBe(0);
  });

  test("decodes single base64 chunk", () => {
    const input = Buffer.from("hello").toString("base64");
    const result = decodePtyChunks([input]);
    expect(Buffer.from(result).toString("utf-8")).toBe("hello");
  });

  test("decodes and concatenates multiple chunks", () => {
    const chunk1 = Buffer.from("hello ").toString("base64");
    const chunk2 = Buffer.from("world").toString("base64");
    const result = decodePtyChunks([chunk1, chunk2]);
    expect(Buffer.from(result).toString("utf-8")).toBe("hello world");
  });
});
