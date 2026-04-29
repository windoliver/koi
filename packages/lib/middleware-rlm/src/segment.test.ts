import { describe, expect, test } from "bun:test";
import type { InboundMessage, ModelRequest } from "@koi/core";
import {
  SiblingNonTextBlocksError,
  SiblingTextBlocksError,
  segmentRequest,
  splitText,
} from "./segment.js";

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

  test("segmentRequest preserves surrogate pairs end-to-end at maxChunkChars=1", () => {
    // Boundary path: validateRlmConfig allows maxChunkChars=1, so the
    // hard-cut surrogate guard must hold across the full segmentRequest
    // pipeline (not just splitText). Each chunk's last UTF-16 unit must
    // never be a dangling high surrogate, even though some chunks will
    // exceed maxChunkChars by one code unit (the alternative is invalid
    // UTF-16, which corrupts byte-faithful transforms in providers).
    const emoji = "🙂🙂🙂".repeat(10); // pure astral-plane text
    const out = segmentRequest(makeRequest([userMessage(emoji)]), 1);
    expect(out.length).toBeGreaterThan(1);
    let recovered = ""; // let: rejoin chunks to verify byte-faithful output
    for (const seg of out) {
      const block = seg.messages[0]?.content[0];
      if (block === undefined || block.kind !== "text") {
        throw new Error("expected text block");
      }
      const last = block.text.charCodeAt(block.text.length - 1);
      const isHighSurrogate = last >= 0xd800 && last <= 0xdbff;
      expect(isHighSurrogate).toBe(false);
      recovered += block.text;
    }
    expect(recovered).toBe(emoji);
  });

  test("preserves surrogate pairs even when maxChars is 1 (advances through full pair)", () => {
    // Pathological budget: maxChars=1 cannot fit a 2-code-unit emoji, but
    // splitting between surrogates corrupts the prompt. Forward progress
    // must consume the full pair instead of emitting a dangling high
    // surrogate.
    const chunks = splitText("🙂🙂", 1);
    expect(chunks.join("")).toBe("🙂🙂");
    for (const c of chunks) {
      const last = c.charCodeAt(c.length - 1);
      const isHighSurrogate = last >= 0xd800 && last <= 0xdbff;
      expect(isHighSurrogate).toBe(false);
    }
  });

  test("does not split UTF-16 surrogate pairs at hard-cut boundaries", () => {
    // Astral-plane characters (e.g. emoji) occupy two UTF-16 code units.
    // A naive slice on odd boundaries lands between the high and low
    // surrogate, producing invalid UTF-16 that providers may corrupt.
    // Each emoji "🙂" is 2 code units; build a long emoji-only string
    // and force the hard-cut path with a small maxChars.
    const emoji = "🙂".repeat(50); // 100 UTF-16 code units, no whitespace
    const chunks = splitText(emoji, 7);
    expect(chunks.join("")).toBe(emoji);
    for (const c of chunks) {
      // Every emoji occupies 2 code units; valid chunks must contain an
      // even number of UTF-16 code units (no dangling surrogate).
      const last = c.charCodeAt(c.length - 1);
      const isHighSurrogate = last >= 0xd800 && last <= 0xdbff;
      expect(isHighSurrogate).toBe(false);
    }
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

  test("throws SiblingTextBlocksError when the oversized message has additional text blocks", () => {
    // Replacing only the oversized block per segment leaves sibling text
    // blocks intact in every downstream call, duplicating that text
    // across N chunks. For exact-copy / extraction tasks that is silent
    // data corruption — fail closed and ask the caller to combine the
    // text blocks upstream.
    const big = "x".repeat(300);
    const msg: InboundMessage = {
      senderId: "user",
      timestamp: 0,
      content: [
        { kind: "text", text: "prefix" },
        { kind: "text", text: big },
        { kind: "text", text: "suffix" },
      ],
    };
    expect(() => segmentRequest(makeRequest([msg]), 100)).toThrow(SiblingTextBlocksError);
  });

  test("throws SiblingNonTextBlocksError when the oversized message has non-text siblings", () => {
    // A multimodal turn carrying an image + an oversized text block must
    // not be segmented: replacing only the text block leaves the image
    // intact in every chunked request, so each downstream call replays
    // and re-bills the same attachment N times while reassembly only
    // concatenates the answers. Fail closed and ask the caller to route
    // the multimodal payload through an explicit reducer.
    const big = "x".repeat(300);
    const msg: InboundMessage = {
      senderId: "user",
      timestamp: 0,
      content: [
        { kind: "image", url: "https://example.com/x.png" },
        { kind: "text", text: big },
      ],
    };
    expect(() => segmentRequest(makeRequest([msg]), 100)).toThrow(SiblingNonTextBlocksError);
  });

  test("throws MultipleOversizedBlocksError when the active user turn has multiple oversized text blocks", () => {
    // A true multi-block partition would require an explicit reducer
    // stage. Cross-product fan-out would duplicate work and corrupt
    // reassembly. Fail closed and ask the caller to combine upstream.
    const a = "a".repeat(300);
    const b = "b".repeat(200);
    const activeTurn: InboundMessage = {
      senderId: "user",
      timestamp: 0,
      content: [
        { kind: "text", text: a },
        { kind: "text", text: b },
      ],
    };
    expect(() => segmentRequest(makeRequest([activeTurn]), 100)).toThrow(/multiple oversized/i);
  });

  test("does not chunk a historical user message even if it is the longest text in the request", () => {
    // The active turn is the LAST user-role message. An earlier user
    // message that happens to be longer (e.g. an uploaded document)
    // must not be rewritten — later assistant/tool messages were
    // produced from the FULL historical text, so chunking it would
    // make the transcript internally inconsistent and silently corrupt
    // the model's answer. Pass through unchanged.
    const oldDoc = "d".repeat(500);
    const assistantReply: InboundMessage = {
      senderId: "assistant",
      timestamp: 1,
      content: [{ kind: "text", text: "ok" }],
    };
    const activeTurn = userMessage("short follow-up");
    const req = makeRequest([userMessage(oldDoc), assistantReply, activeTurn]);
    const out = segmentRequest(req, 100);
    expect(out).toEqual([req]);
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

  test("ignores untrusted metadata.role by default (security: caller-controlled field)", () => {
    // metadata is caller-controlled in this codebase; honoring metadata.role
    // by default would let an external caller stamp `role: "assistant"` on
    // an oversized user turn to bypass RLM's size guard. Default behavior
    // is to ignore the field — the message still classifies as user-role
    // by senderId heuristic and gets chunked.
    const oversized: InboundMessage = {
      senderId: "user:1",
      timestamp: 0,
      content: [{ kind: "text", text: "z".repeat(500) }],
      metadata: { role: "assistant" },
    };
    const out = segmentRequest(makeRequest([oversized]), 100);
    expect(out.length).toBeGreaterThan(1);
  });

  test("honors trusted metadata.role override only with opt-in (assistant)", () => {
    // L1 / session-repair sets metadata.role for resumed non-user content.
    // When the caller has confirmed the upstream path is trusted via
    // `trustMetadataRole: true`, RLM honors the override and does not
    // chunk resumed assistant content.
    const assistantMsg: InboundMessage = {
      senderId: "user:1",
      timestamp: 0,
      content: [{ kind: "text", text: "z".repeat(500) }],
      metadata: { role: "assistant" },
    };
    expect(segmentRequest(makeRequest([assistantMsg]), 100, { trustMetadataRole: true })).toEqual([
      makeRequest([assistantMsg]),
    ]);
  });

  test("honors trusted metadata.role override only with opt-in (tool)", () => {
    const toolMsg: InboundMessage = {
      senderId: "user:tooluser",
      timestamp: 0,
      content: [{ kind: "text", text: "z".repeat(500) }],
      metadata: { role: "tool" },
    };
    expect(segmentRequest(makeRequest([toolMsg]), 100, { trustMetadataRole: true })).toEqual([
      makeRequest([toolMsg]),
    ]);
  });

  test("honors trusted metadata.role === 'system' (privileged content must not be chunked)", () => {
    // A trusted message stamped role: "system" carries privileged
    // instructions; rewriting it chunk-by-chunk would change instruction
    // semantics across calls and weaken the trust boundary the option
    // claims to mirror. Same exclusion as literal `system*` senderIds.
    const sysMsg: InboundMessage = {
      senderId: "user:1",
      timestamp: 0,
      content: [{ kind: "text", text: "s".repeat(500) }],
      metadata: { role: "system" },
    };
    expect(segmentRequest(makeRequest([sysMsg]), 100, { trustMetadataRole: true })).toEqual([
      makeRequest([sysMsg]),
    ]);
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

  test("fails closed when a non-text block lives in a different message (not just same-message siblings)", () => {
    // Earlier guard scoped the non-text check to the target message
    // only; an image in a prior turn's message was passed through
    // verbatim per segment, billing the same attachment N times.
    // Scan all messages, fail closed if any non-text block exists.
    const big = "y".repeat(300);
    const priorImage: InboundMessage = {
      senderId: "user",
      timestamp: 0,
      content: [{ kind: "image", url: "http://example/prior.png" }],
    };
    const oversizedTurn: InboundMessage = {
      senderId: "user",
      timestamp: 1,
      content: [{ kind: "text", text: big }],
    };
    expect(() => segmentRequest(makeRequest([priorImage, oversizedTurn]), 100)).toThrow(
      SiblingNonTextBlocksError,
    );
  });

  test("fails closed when the oversized message has non-text siblings instead of duplicating them", () => {
    // Earlier behavior duplicated the image across every chunk. That
    // re-bills the multimodal attachment N times while reassembly only
    // concatenates the answers — corruption + cost regression. Fail
    // closed so the caller routes multimodal turns through an explicit
    // reducer or moves the attachment to its own message.
    const big = "y".repeat(300);
    const msg: InboundMessage = {
      senderId: "user",
      timestamp: 0,
      content: [
        { kind: "image", url: "http://example/img.png" },
        { kind: "text", text: big },
      ],
    };
    expect(() => segmentRequest(makeRequest([msg]), 100)).toThrow(SiblingNonTextBlocksError);
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
