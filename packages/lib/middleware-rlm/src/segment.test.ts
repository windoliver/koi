import { describe, expect, test } from "bun:test";
import type { InboundMessage, ModelRequest } from "@koi/core";
import { segmentRequest, splitText } from "./segment.js";

function userMessage(text: string): InboundMessage {
  return {
    senderId: "user",
    timestamp: 0,
    content: [{ kind: "text", text }],
  };
}

function makeRequest(messages: readonly InboundMessage[]): ModelRequest {
  return { messages };
}

describe("splitText", () => {
  test("returns single chunk when text fits", () => {
    expect(splitText("hello world", 100)).toEqual(["hello world"]);
  });

  test("splits on paragraph boundaries when possible", () => {
    const text = "para one\n\npara two\n\npara three";
    const chunks = splitText(text, 12);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("")).toBe(text);
  });

  test("splits on line boundaries when paragraphs overflow", () => {
    const text = "line a\nline b\nline c\nline d";
    const chunks = splitText(text, 8);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("")).toBe(text);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(8);
  });

  test("hard-cuts lines that themselves overflow", () => {
    const text = "x".repeat(100);
    const chunks = splitText(text, 30);
    expect(chunks.length).toBe(4);
    expect(chunks.join("")).toBe(text);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(30);
  });

  test("rejects non-positive maxChars", () => {
    expect(() => splitText("hi", 0)).toThrow();
    expect(() => splitText("hi", -1)).toThrow();
  });
});

describe("segmentRequest", () => {
  test("returns the original request unchanged when nothing exceeds the chunk size", () => {
    const req = makeRequest([userMessage("small input")]);
    const out = segmentRequest(req, 1000);
    expect(out).toEqual([req]);
  });

  test("returns the original request when there are no user text blocks", () => {
    const req = makeRequest([
      {
        senderId: "assistant",
        timestamp: 0,
        content: [{ kind: "text", text: "x".repeat(500) }],
      },
    ]);
    const out = segmentRequest(req, 100);
    expect(out).toEqual([req]);
  });

  test("splits the largest user text block into N segments", () => {
    const big = `${"a".repeat(50)}\n\n${"b".repeat(50)}\n\n${"c".repeat(50)}`;
    const req = makeRequest([userMessage(big)]);
    const out = segmentRequest(req, 60);
    expect(out.length).toBeGreaterThan(1);
  });

  test("rewrites the user payload with raw chunk text only — no synthetic labels", () => {
    // The middleware must not inject ordinal markers into the user content,
    // because exact-copy and structured-transformation prompts would echo
    // them. Per-segment ordering lives in reassembly metadata, not in the
    // payload sent to the model.
    const big = "x".repeat(300);
    const req = makeRequest([userMessage(big)]);
    const out = segmentRequest(req, 100);
    expect(out.length).toBe(3);
    let recovered = ""; // let: rejoin chunks to verify no synthetic prefix
    for (const seg of out) {
      const block = seg.messages[0]?.content[0];
      if (block === undefined || block.kind !== "text") {
        throw new Error("expected text block");
      }
      expect(block.text).not.toMatch(/^Segment \d+\/\d+/);
      recovered += block.text;
    }
    expect(recovered).toBe(big);
  });

  test("recursively segments multiple oversized user text blocks in one request", () => {
    // Two large user blocks must both be split. Without recursion the
    // unchunked block would push every produced segment back over the
    // budget at re-validation time and cause an avoidable hard failure.
    const a = "a".repeat(300);
    const b = "b".repeat(200);
    const req = makeRequest([userMessage(a), userMessage(b)]);
    const out = segmentRequest(req, 100);
    // 3 chunks of A × 2 chunks of B = 6 segments
    expect(out.length).toBe(6);
    for (const seg of out) {
      const aBlock = seg.messages[0]?.content[0];
      const bBlock = seg.messages[1]?.content[0];
      if (aBlock === undefined || aBlock.kind !== "text") throw new Error("expected text A");
      if (bBlock === undefined || bBlock.kind !== "text") throw new Error("expected text B");
      expect(aBlock.text.length).toBeLessThanOrEqual(100);
      expect(bBlock.text.length).toBeLessThanOrEqual(100);
    }
  });

  test("preserves system prompt, tools, and prior messages", () => {
    const big = "z".repeat(300);
    const sysMessage: InboundMessage = {
      senderId: "system:root",
      timestamp: 0,
      content: [{ kind: "text", text: "system rules" }],
    };
    const req: ModelRequest = {
      messages: [sysMessage, userMessage(big)],
      systemPrompt: "be helpful",
      tools: [],
    };
    const out = segmentRequest(req, 100);
    expect(out.length).toBeGreaterThan(1);
    for (const seg of out) {
      expect(seg.systemPrompt).toBe("be helpful");
      expect(seg.tools).toEqual([]);
      expect(seg.messages[0]).toBe(sysMessage);
    }
  });

  test("preserves non-text blocks alongside the chunked text block", () => {
    const big = "y".repeat(300);
    const msg: InboundMessage = {
      senderId: "user",
      timestamp: 0,
      content: [
        { kind: "image", url: "http://example/img.png" },
        { kind: "text", text: big },
      ],
    };
    const req = makeRequest([msg]);
    const out = segmentRequest(req, 100);
    expect(out.length).toBeGreaterThan(1);
    for (const seg of out) {
      const blocks = seg.messages[0]?.content ?? [];
      expect(blocks[0]).toEqual({ kind: "image", url: "http://example/img.png" });
      const text = blocks[1];
      if (text === undefined || text.kind !== "text") {
        throw new Error("expected text block at index 1");
      }
    }
  });

  test("only segments the single largest user text block", () => {
    const small = "small";
    const big = "Q".repeat(300);
    const req = makeRequest([userMessage(small), userMessage(big)]);
    const out = segmentRequest(req, 100);
    expect(out.length).toBeGreaterThan(1);
    for (const seg of out) {
      const firstText = seg.messages[0]?.content[0];
      if (firstText === undefined || firstText.kind !== "text") {
        throw new Error("expected text block");
      }
      expect(firstText.text).toBe(small);
    }
  });
});
