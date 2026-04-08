import { describe, expect, mock, test } from "bun:test";
import { copyToClipboard, MAX_CLIPBOARD_BYTES } from "./clipboard.js";

describe("copyToClipboard", () => {
  test("returns false when stdout is not a TTY", () => {
    const original = process.stdout.isTTY;
    try {
      Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });
      expect(copyToClipboard("hello")).toBe(false);
    } finally {
      Object.defineProperty(process.stdout, "isTTY", { value: original, configurable: true });
    }
  });

  test("writes correct OSC 52 escape sequence with base64 payload", () => {
    const original = process.stdout.isTTY;
    const writeFn = mock((_chunk: string | Uint8Array) => true);
    const originalWrite = process.stdout.write;
    try {
      Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
      // Replace write — cast through unknown to satisfy TS overload signature
      process.stdout.write = writeFn as unknown as typeof process.stdout.write;

      const result = copyToClipboard("hello");

      expect(result).toBe(true);
      expect(writeFn).toHaveBeenCalledTimes(1);

      const expected = Buffer.from("hello").toString("base64");
      expect(writeFn.mock.calls[0]?.[0]).toBe(`\x1b]52;c;${expected}\x07`);
    } finally {
      Object.defineProperty(process.stdout, "isTTY", { value: original, configurable: true });
      process.stdout.write = originalWrite;
    }
  });

  test("empty string produces valid OSC 52 sequence", () => {
    const original = process.stdout.isTTY;
    const writeFn = mock((_chunk: string | Uint8Array) => true);
    const originalWrite = process.stdout.write;
    try {
      Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
      process.stdout.write = writeFn as unknown as typeof process.stdout.write;

      const result = copyToClipboard("");

      expect(result).toBe(true);

      const emptyBase64 = Buffer.from("").toString("base64");
      expect(writeFn.mock.calls[0]?.[0]).toBe(`\x1b]52;c;${emptyBase64}\x07`);
    } finally {
      Object.defineProperty(process.stdout, "isTTY", { value: original, configurable: true });
      process.stdout.write = originalWrite;
    }
  });
});

describe("MAX_CLIPBOARD_BYTES", () => {
  test("is 100000", () => {
    expect(MAX_CLIPBOARD_BYTES).toBe(100_000);
  });
});
