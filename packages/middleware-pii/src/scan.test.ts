import { describe, expect, test } from "bun:test";
import type { ContentBlock, InboundMessage } from "@koi/core/message";
import { createEmailDetector, createIPDetector } from "./detectors.js";
import { scanBlock, scanJson, scanMessage, scanString } from "./scan.js";

const detectors = [createEmailDetector(), createIPDetector()];

describe("scanString", () => {
  test("returns unchanged for clean text", () => {
    const result = scanString("hello world", detectors, "redact");
    expect(result.text).toBe("hello world");
    expect(result.changed).toBe(false);
    expect(result.matches).toHaveLength(0);
  });

  test("redacts email in text", () => {
    const result = scanString("Contact user@example.com", detectors, "redact");
    expect(result.text).toBe("Contact [REDACTED_EMAIL]");
    expect(result.changed).toBe(true);
    expect(result.matches).toHaveLength(1);
  });

  test("redacts multiple PII types", () => {
    const result = scanString("user@test.com at 10.0.0.1", detectors, "redact");
    expect(result.text).toContain("[REDACTED_EMAIL]");
    expect(result.text).toContain("[REDACTED_IP]");
    expect(result.matches).toHaveLength(2);
  });
});

describe("scanBlock", () => {
  test("scans text blocks", () => {
    const block: ContentBlock = { kind: "text", text: "Email: a@b.com" };
    const result = scanBlock(block, detectors, "redact");
    expect(result.changed).toBe(true);
    expect(result.block).toEqual({ kind: "text", text: "Email: [REDACTED_EMAIL]" });
  });

  test("returns identity for non-text blocks", () => {
    const block: ContentBlock = { kind: "image", url: "http://example.com/img.png" };
    const result = scanBlock(block, detectors, "redact");
    expect(result.changed).toBe(false);
    expect(result.block).toBe(block);
  });

  test("returns identity for clean text blocks", () => {
    const block: ContentBlock = { kind: "text", text: "no pii here" };
    const result = scanBlock(block, detectors, "redact");
    expect(result.changed).toBe(false);
    expect(result.block).toBe(block);
  });
});

describe("scanMessage", () => {
  test("scans all text blocks in a message", () => {
    const message: InboundMessage = {
      senderId: "user",
      timestamp: Date.now(),
      content: [
        { kind: "text", text: "Email: user@test.com" },
        { kind: "text", text: "IP: 192.168.1.1" },
      ],
    };
    const result = scanMessage(message, detectors, "redact");
    expect(result.changed).toBe(true);
    expect(result.matches).toHaveLength(2);
  });

  test("returns identity for clean messages", () => {
    const message: InboundMessage = {
      senderId: "user",
      timestamp: Date.now(),
      content: [{ kind: "text", text: "nothing to see" }],
    };
    const result = scanMessage(message, detectors, "redact");
    expect(result.changed).toBe(false);
    expect(result.message).toBe(message);
  });
});

describe("scanJson", () => {
  test("scans string values in objects", () => {
    const value = { email: "user@test.com", name: "John" };
    const result = scanJson(value, detectors, "redact");
    expect(result.changed).toBe(true);
    expect((result.value as Record<string, unknown>).email).toBe("[REDACTED_EMAIL]");
    expect((result.value as Record<string, unknown>).name).toBe("John");
  });

  test("scans nested arrays", () => {
    const value = { data: ["user@test.com", "clean", "10.0.0.1"] };
    const result = scanJson(value, detectors, "redact");
    expect(result.changed).toBe(true);
    const arr = (result.value as Record<string, unknown>).data as string[];
    expect(arr[0]).toBe("[REDACTED_EMAIL]");
    expect(arr[1]).toBe("clean");
    expect(arr[2]).toBe("[REDACTED_IP]");
  });

  test("returns identity for non-string values", () => {
    const value = { count: 42, flag: true, nothing: null };
    const result = scanJson(value, detectors, "redact");
    expect(result.changed).toBe(false);
    expect(result.value).toBe(value);
  });

  test("respects max depth", () => {
    const deep = { a: { b: { c: "user@test.com" } } };
    const result = scanJson(deep, detectors, "redact", undefined, 1);
    // At depth > 1, stops recursing — email should not be redacted
    expect(result.changed).toBe(false);
  });
});
