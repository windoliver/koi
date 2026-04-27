/**
 * Clipboard utilities tests.
 *
 * OSC 52 text copy (copyToClipboard) was removed in #1940 — TUI components
 * now call renderer.copyToClipboardOSC52() directly so the sequence flows
 * through the renderer's output path instead of bypassing it via direct
 * process.stdout.write. Size guards moved to isBelowOsc52Limit().
 */

import { describe, expect, test } from "bun:test";
import { isBelowOsc52Limit, MAX_CLIPBOARD_BYTES, readClipboardImage } from "./clipboard.js";

describe("MAX_CLIPBOARD_BYTES", () => {
  test("is 100_000", () => {
    expect(MAX_CLIPBOARD_BYTES).toBe(100_000);
  });
});

describe("isBelowOsc52Limit", () => {
  test("returns true for empty string", () => {
    expect(isBelowOsc52Limit("")).toBe(true);
  });

  test("returns true for short text", () => {
    expect(isBelowOsc52Limit("hello")).toBe(true);
  });

  test("returns false for text whose base64 exceeds MAX_CLIPBOARD_BYTES", () => {
    // base64 expands ~4/3; generate raw bytes that will exceed the limit.
    const oversize = "x".repeat(MAX_CLIPBOARD_BYTES);
    expect(isBelowOsc52Limit(oversize)).toBe(false);
  });

  test("returns true for text right at the limit boundary", () => {
    // 3 raw bytes → 4 base64 chars. MAX_CLIPBOARD_BYTES / (4/3) ≈ 75000 raw bytes.
    const atLimit = "x".repeat(Math.floor((MAX_CLIPBOARD_BYTES * 3) / 4));
    expect(isBelowOsc52Limit(atLimit)).toBe(true);
  });
});

describe("readClipboardImage", () => {
  test("returns null on unsupported platform when tool is missing", async () => {
    // Always catches errors and returns null — safe to call without platform tools.
    const result = await readClipboardImage();
    expect(result).toBeNull();
  });
});
