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

  test("throws MultipleOversizedBlocksError when more than one user-role block exceeds maxChunkChars", () => {
    // A true multi-block partition would require an explicit reducer
    // stage. Cross-product fan-out would duplicate work and corrupt
    // reassembly. Fail closed and ask the caller to combine upstream.
    const a = "a".repeat(300);
    const b = "b".repeat(200);
    const req = makeRequest([userMessage(a), userMessage(b)]);
    expect(() => segmentRequest(req, 100)).toThrow(/multiple oversized/i);
  });

  test("treats non-literal user senders (e.g. 'user:1', 'watch-patterns') as user-role for chunk eligibility", () => {
    // The model adapter normalizes anything except 'assistant' / 'system*'
    // to user role. RLM must follow the same rule so middleware-authored
    // turns and multi-user senders are not silently exempt from chunking.
    const big = "p".repeat(300);
    const customSender: InboundMessage = {
      senderId: "watch-patterns",
      timestamp: 0,
      content: [{ kind: "text", text: big }],
    };
    const req = makeRequest([customSender]);
    const out = segmentRequest(req, 100);
    expect(out.length).toBeGreaterThan(1);
  });

  test("treats look-alike system senders ('systemic-user', 'system2') as user-role", () => {
    // mapSenderIdToRole only matches literal 'system' and 'system:*'. RLM
    // must not exempt look-alike senders or oversized payloads under those
    // ids will bypass segmentation.
    const big = "p".repeat(300);
    const lookalike: InboundMessage = {
      senderId: "systemic-user",
      timestamp: 0,
      content: [{ kind: "text", text: big }],
    };
    const out = segmentRequest(makeRequest([lookalike]), 100);
    expect(out.length).toBeGreaterThan(1);
  });

  test("does not chunk senderId === 'tool' even when oversized", () => {
    // Tool results carry tool_call/tool_result correlation. Splitting them
    // into 'user-like' chunks would break tool linkage and corrupt
    // conversation semantics.
    const toolMsg: InboundMessage = {
      senderId: "tool",
      timestamp: 0,
      content: [{ kind: "text", text: "z".repeat(500) }],
    };
    expect(segmentRequest(makeRequest([toolMsg]), 100)).toEqual([makeRequest([toolMsg])]);
  });

  test("respects trusted metadata.role override (assistant)", () => {
    // L1 / session-repair set metadata.role for non-escalating roles.
    // RLM must honor that override so resumed assistant content is not
    // reclassified as chunkable user input.
    const assistantMsg: InboundMessage = {
      senderId: "user:1",
      timestamp: 0,
      content: [{ kind: "text", text: "z".repeat(500) }],
      metadata: { role: "assistant" },
    };
    expect(segmentRequest(makeRequest([assistantMsg]), 100)).toEqual([makeRequest([assistantMsg])]);
  });

  test("respects trusted metadata.role override (tool)", () => {
    const toolMsg: InboundMessage = {
      senderId: "user:tooluser",
      timestamp: 0,
      content: [{ kind: "text", text: "z".repeat(500) }],
      metadata: { role: "tool" },
    };
    expect(segmentRequest(makeRequest([toolMsg]), 100)).toEqual([makeRequest([toolMsg])]);
  });

  test("never chunks bare senderId === 'system' (trust boundary, even though openai-compat treats it as user)", () => {
    // The two canonical resolvers disagree: openai-compat treats bare
    // 'system' as user, model-router/normalize treats it as system.
    // Take the conservative stance — never chunk privileged-looking
    // content. Oversized bare-system messages are a compaction concern.
    const big = "p".repeat(300);
    const bareSystem: InboundMessage = {
      senderId: "system",
      timestamp: 0,
      content: [{ kind: "text", text: big }],
    };
    expect(segmentRequest(makeRequest([bareSystem]), 100)).toEqual([makeRequest([bareSystem])]);
  });

  test("ignores oversized text blocks under system:* senders (handled by compaction, not RLM)", () => {
    const sysMsg: InboundMessage = {
      senderId: "system:root",
      timestamp: 0,
      content: [{ kind: "text", text: "z".repeat(500) }],
    };
    const req = makeRequest([sysMsg]);
    expect(segmentRequest(req, 100)).toEqual([req]);
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
