/**
 * Stream parser tests — explicit state machine + 7 edge cases.
 */

import { describe, expect, test } from "bun:test";
import type { ModelChunk } from "@koi/core";
import { createEmptyAccumulator } from "./response-mapper.js";
import { createStreamParser, parseSSELines, sanitizeUnicode } from "./stream-parser.js";
import type { ChatCompletionChunk } from "./types.js";

function feedAll(
  parser: ReturnType<typeof createStreamParser>,
  chunks: readonly ChatCompletionChunk[],
): ModelChunk[] {
  const result: ModelChunk[] = [];
  for (const chunk of chunks) {
    result.push(...parser.feed(chunk));
  }
  return result;
}

function parseFixtureResults(text: string): ChatCompletionChunk[] {
  const results = [...parseSSELines(text)];
  return results
    .filter((r) => r.ok)
    .map((r) => {
      if (!r.ok) throw new Error("unexpected");
      return r.chunk;
    });
}

// ---------------------------------------------------------------------------
// parseSSELines
// ---------------------------------------------------------------------------

describe("parseSSELines", () => {
  test("parses data lines and skips [DONE]", () => {
    const text = `data: {"id":"g1","choices":[]}\n\ndata: [DONE]\n\n`;
    const results = [...parseSSELines(text)];
    expect(results).toHaveLength(1);
    expect(results[0]?.ok).toBe(true);
    if (results[0]?.ok) expect(results[0].chunk.id).toBe("g1");
  });

  test("yields error for malformed JSON", () => {
    const text = `data: not-json\n\ndata: {"id":"g1","choices":[]}\n\n`;
    const results = [...parseSSELines(text)];
    expect(results).toHaveLength(2);
    const first = results[0];
    expect(first?.ok).toBe(false);
    if (first !== undefined && !first.ok) expect(first.raw).toBe("not-json");
    expect(results[1]?.ok).toBe(true);
  });

  test("handles multi-line data: events (SSE spec compliance)", () => {
    // SSE allows splitting one event payload across multiple data: lines
    const text = [`data: {"id":"g2",`, `data: "choices":[]}`, ``, `data: [DONE]`, ``].join("\n");
    const results = [...parseSSELines(text)];
    expect(results).toHaveLength(1);
    const first = results[0];
    expect(first?.ok).toBe(true);
    if (first?.ok) {
      expect(first.chunk.id).toBe("g2");
    }
  });

  test("handles CRLF line endings", () => {
    const text = 'data: {"id":"g5","choices":[]}\r\n\r\ndata: [DONE]\r\n\r\n';
    const results = [...parseSSELines(text)];
    expect(results).toHaveLength(1);
    expect(results[0]?.ok).toBe(true);
    if (results[0]?.ok) expect(results[0].chunk.id).toBe("g5");
  });

  test("handles bare CR line endings", () => {
    const text = 'data: {"id":"g6","choices":[]}\r\rdata: [DONE]\r\r';
    const results = [...parseSSELines(text)];
    expect(results).toHaveLength(1);
    expect(results[0]?.ok).toBe(true);
    if (results[0]?.ok) expect(results[0].chunk.id).toBe("g6");
  });

  test("handles data: with no trailing space", () => {
    const text = `data:{"id":"g3","choices":[]}\n\n`;
    const results = [...parseSSELines(text)];
    expect(results).toHaveLength(1);
    expect(results[0]?.ok).toBe(true);
  });

  test("flushes data without trailing blank line", () => {
    const text = `data: {"id":"g4","choices":[]}`;
    const results = [...parseSSELines(text)];
    expect(results).toHaveLength(1);
    expect(results[0]?.ok).toBe(true);
    if (results[0]?.ok) expect(results[0].chunk.id).toBe("g4");
  });
});

// ---------------------------------------------------------------------------
// sanitizeUnicode
// ---------------------------------------------------------------------------

describe("sanitizeUnicode", () => {
  test("passes through valid text unchanged", () => {
    expect(sanitizeUnicode("hello world")).toBe("hello world");
  });

  test("replaces lone high surrogate", () => {
    const text = "before\uD800after";
    expect(sanitizeUnicode(text)).toBe("before\uFFFDafter");
  });

  test("replaces lone low surrogate", () => {
    const text = "before\uDC00after";
    expect(sanitizeUnicode(text)).toBe("before\uFFFDafter");
  });

  test("preserves valid surrogate pairs", () => {
    // U+1F600 = \uD83D\uDE00 (grinning face)
    const text = "hi \uD83D\uDE00";
    expect(sanitizeUnicode(text)).toBe("hi \uD83D\uDE00");
  });
});

// ---------------------------------------------------------------------------
// Reasoning field variants
// ---------------------------------------------------------------------------

describe("reasoning field variants", () => {
  test("handles 'reasoning' field", () => {
    const chunks: ChatCompletionChunk[] = [
      {
        id: "gr",
        choices: [
          {
            index: 0,
            delta: {
              reasoning: "Thinking via reasoning",
            } as unknown as import("./types.js").ChatCompletionChunkDelta,
            finish_reason: null,
          },
        ],
      },
      {
        id: "gr",
        choices: [{ index: 0, delta: { content: "Answer" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 5, completion_tokens: 3 },
      },
    ];
    const acc = createEmptyAccumulator("test-model");
    const parser = createStreamParser(acc);
    const output = feedAll(parser, chunks);
    parser.finish();
    const thinkingDeltas = output.filter((c) => c.kind === "thinking_delta");
    expect(thinkingDeltas).toHaveLength(1);
  });

  test("handles 'reasoning_text' field (llama.cpp)", () => {
    const chunks: ChatCompletionChunk[] = [
      {
        id: "grt",
        choices: [
          {
            index: 0,
            delta: {
              reasoning_text: "llama thinking",
            } as unknown as import("./types.js").ChatCompletionChunkDelta,
            finish_reason: null,
          },
        ],
      },
      {
        id: "grt",
        choices: [{ index: 0, delta: { content: "Done" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 5, completion_tokens: 2 },
      },
    ];
    const acc = createEmptyAccumulator("test-model");
    const parser = createStreamParser(acc);
    const output = feedAll(parser, chunks);
    parser.finish();
    expect(output.filter((c) => c.kind === "thinking_delta")).toHaveLength(1);
  });

  test("deduplicates when same content in multiple fields", () => {
    const chunks: ChatCompletionChunk[] = [
      {
        id: "gd",
        choices: [
          {
            index: 0,
            delta: {
              reasoning_content: "thinking",
              reasoning: "thinking",
            } as unknown as import("./types.js").ChatCompletionChunkDelta,
            finish_reason: null,
          },
        ],
      },
      {
        id: "gd",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 5, completion_tokens: 1 },
      },
    ];
    const acc = createEmptyAccumulator("test-model");
    const parser = createStreamParser(acc);
    const output = feedAll(parser, chunks);
    parser.finish();
    // Should emit ONE thinking_delta, not two
    expect(output.filter((c) => c.kind === "thinking_delta")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Edge case 1: Empty stream
// ---------------------------------------------------------------------------

describe("edge case: empty stream", () => {
  test("yields usage and stop reason from empty choices", () => {
    const chunks = parseFixtureResults(
      `data: {"id":"gen-5","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":0}}\n\n` +
        `data: [DONE]\n\n`,
    );

    const acc = createEmptyAccumulator("test-model");
    const parser = createStreamParser(acc);
    const output = feedAll(parser, chunks);
    parser.finish();

    const usageChunk = output.find((c) => c.kind === "usage");
    expect(usageChunk).toBeDefined();
    if (usageChunk?.kind === "usage") {
      expect(usageChunk.inputTokens).toBe(5);
      expect(usageChunk.outputTokens).toBe(0);
    }

    const finalAcc = parser.getAccumulator();
    expect(finalAcc.stopReason).toBe("stop");
    expect(finalAcc.textContent).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Edge case 2: Interleaved tool calls
// ---------------------------------------------------------------------------

describe("edge case: interleaved tool calls", () => {
  test("tracks two simultaneous tool calls by index", () => {
    const chunks: ChatCompletionChunk[] = [
      {
        id: "g3",
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [{ index: 0, id: "call_a", function: { name: "search", arguments: "" } }],
            },
            finish_reason: null,
          },
        ],
      },
      {
        id: "g3",
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [{ index: 1, id: "call_b", function: { name: "read", arguments: "" } }],
            },
            finish_reason: null,
          },
        ],
      },
      {
        id: "g3",
        choices: [
          {
            index: 0,
            delta: { tool_calls: [{ index: 0, function: { arguments: '{"q":' } }] },
            finish_reason: null,
          },
        ],
      },
      {
        id: "g3",
        choices: [
          {
            index: 0,
            delta: { tool_calls: [{ index: 1, function: { arguments: '{"path":' } }] },
            finish_reason: null,
          },
        ],
      },
      {
        id: "g3",
        choices: [
          {
            index: 0,
            delta: { tool_calls: [{ index: 0, function: { arguments: '"hi"}' } }] },
            finish_reason: null,
          },
        ],
      },
      {
        id: "g3",
        choices: [
          {
            index: 0,
            delta: { tool_calls: [{ index: 1, function: { arguments: '"f.txt"}' } }] },
            finish_reason: null,
          },
        ],
      },
      {
        id: "g3",
        choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
        usage: { prompt_tokens: 20, completion_tokens: 12 },
      },
    ];

    const acc = createEmptyAccumulator("test-model");
    const parser = createStreamParser(acc);
    const output = feedAll(parser, chunks);
    const finishOutput = parser.finish();
    output.push(...finishOutput);

    // Should have two tool_call_start events
    const starts = output.filter((c) => c.kind === "tool_call_start");
    expect(starts).toHaveLength(2);

    // Should have two tool_call_end events from finish()
    const ends = output.filter((c) => c.kind === "tool_call_end");
    expect(ends).toHaveLength(2);

    // Verify accumulated tool calls
    const finalAcc = parser.getAccumulator();
    const toolCalls = finalAcc.richContent.filter((b) => b.kind === "tool_call");
    expect(toolCalls).toHaveLength(2);
    if (toolCalls[0]?.kind === "tool_call") {
      expect(toolCalls[0].name).toBe("search");
      expect(toolCalls[0].arguments).toEqual({ q: "hi" });
    }
    if (toolCalls[1]?.kind === "tool_call") {
      expect(toolCalls[1].name).toBe("read");
      expect(toolCalls[1].arguments).toEqual({ path: "f.txt" });
    }
  });
});

// ---------------------------------------------------------------------------
// Edge case 3: Tool call with empty arguments
// ---------------------------------------------------------------------------

describe("edge case: tool call with empty arguments", () => {
  test("produces empty object arguments", () => {
    const chunks: ChatCompletionChunk[] = [
      {
        id: "g6",
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [{ index: 0, id: "call_e", function: { name: "noop", arguments: "{}" } }],
            },
            finish_reason: null,
          },
        ],
      },
      {
        id: "g6",
        choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
        usage: { prompt_tokens: 5, completion_tokens: 3 },
      },
    ];

    const acc = createEmptyAccumulator("test-model");
    const parser = createStreamParser(acc);
    feedAll(parser, chunks);
    parser.finish();

    const finalAcc = parser.getAccumulator();
    const toolCalls = finalAcc.richContent.filter((b) => b.kind === "tool_call");
    expect(toolCalls).toHaveLength(1);
    if (toolCalls[0]?.kind === "tool_call") {
      expect(toolCalls[0].arguments).toEqual({});
    }
  });
});

// ---------------------------------------------------------------------------
// Adversarial fix: truncated tool arguments emit error
// ---------------------------------------------------------------------------

describe("adversarial: truncated tool arguments", () => {
  test("emits VALIDATION error for unparseable arguments", () => {
    const chunks: ChatCompletionChunk[] = [
      {
        id: "gv",
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [{ index: 0, id: "call_v", function: { name: "search", arguments: "" } }],
            },
            finish_reason: null,
          },
        ],
      },
      {
        id: "gv",
        choices: [
          {
            index: 0,
            delta: { tool_calls: [{ index: 0, function: { arguments: '{"q":"te' } }] },
            finish_reason: null,
          },
        ],
      },
      // Stream ends with truncated args — finish_reason arrives but args are incomplete
      {
        id: "gv",
        choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      },
    ];

    const acc = createEmptyAccumulator("test-model");
    const parser = createStreamParser(acc);
    const output = feedAll(parser, chunks);
    const finishOutput = parser.finish();
    output.push(...finishOutput);

    // Should have a VALIDATION error from truncated args
    const errors = output.filter((c) => c.kind === "error");
    expect(errors).toHaveLength(1);
    if (errors[0]?.kind === "error") {
      expect(errors[0].code).toBe("VALIDATION");
      expect(errors[0].message).toContain("search");
    }

    // Should NOT have tool_call_end (invalid args must not emit completion event)
    const ends = output.filter((c) => c.kind === "tool_call_end");
    expect(ends).toHaveLength(0);

    // Should NOT have a tool_call in richContent (invalid args)
    const finalAcc = parser.getAccumulator();
    const toolCalls = finalAcc.richContent.filter((b) => b.kind === "tool_call");
    expect(toolCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Adversarial fix: tool call with empty name emits error
// ---------------------------------------------------------------------------

describe("adversarial: tool call with empty function name", () => {
  test("emits VALIDATION error when tool call finishes without a name", () => {
    // Provider sends tool call ID and args but never sends function.name
    const chunks: ChatCompletionChunk[] = [
      {
        id: "gn",
        choices: [
          { index: 0, delta: { tool_calls: [{ index: 0, id: "call_n" }] }, finish_reason: null },
        ],
      },
      {
        id: "gn",
        choices: [
          {
            index: 0,
            delta: { tool_calls: [{ index: 0, function: { arguments: "{}" } }] },
            finish_reason: null,
          },
        ],
      },
      {
        id: "gn",
        choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
        usage: { prompt_tokens: 5, completion_tokens: 3 },
      },
    ];

    const acc = createEmptyAccumulator("test-model");
    const parser = createStreamParser(acc);
    const output = feedAll(parser, chunks);
    const finishOutput = parser.finish();
    output.push(...finishOutput);

    // Should have a VALIDATION error about missing name
    const errors = output.filter((c) => c.kind === "error");
    expect(errors).toHaveLength(1);
    if (errors[0]?.kind === "error") {
      expect(errors[0].code).toBe("VALIDATION");
      expect(errors[0].message).toContain("no function name");
    }

    // Should NOT have a tool_call in richContent
    const finalAcc = parser.getAccumulator();
    const toolCalls = finalAcc.richContent.filter((b) => b.kind === "tool_call");
    expect(toolCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Edge case 4: Thinking block followed by tool call
// ---------------------------------------------------------------------------

describe("edge case: thinking then tool call", () => {
  test("transitions from thinking to tool_call state", () => {
    const chunks: ChatCompletionChunk[] = [
      {
        id: "g4",
        choices: [{ index: 0, delta: { reasoning_content: "Let me think" }, finish_reason: null }],
      },
      {
        id: "g4",
        choices: [
          { index: 0, delta: { reasoning_content: " about this..." }, finish_reason: null },
        ],
      },
      {
        id: "g4",
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                { index: 0, id: "call_t", function: { name: "calc", arguments: '{"x":42}' } },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      {
        id: "g4",
        choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
        usage: { prompt_tokens: 25, completion_tokens: 15 },
      },
    ];

    const acc = createEmptyAccumulator("test-model");
    const parser = createStreamParser(acc);
    const output = feedAll(parser, chunks);
    const finishOutput = parser.finish();
    output.push(...finishOutput);

    // Should have thinking deltas
    const thinkingDeltas = output.filter((c) => c.kind === "thinking_delta");
    expect(thinkingDeltas).toHaveLength(2);

    // Should have tool_call_start
    const starts = output.filter((c) => c.kind === "tool_call_start");
    expect(starts).toHaveLength(1);

    // Should have tool_call_end from finish()
    const ends = output.filter((c) => c.kind === "tool_call_end");
    expect(ends).toHaveLength(1);

    const finalAcc = parser.getAccumulator();
    expect(finalAcc.stopReason).toBe("tool_use");

    // P2 fix: thinking must appear in richContent
    const thinkingBlocks = finalAcc.richContent.filter((b) => b.kind === "thinking");
    expect(thinkingBlocks).toHaveLength(1);
    if (thinkingBlocks[0]?.kind === "thinking") {
      expect(thinkingBlocks[0].text).toBe("Let me think about this...");
    }

    // P2 fix: richContent block order must be thinking → tool_call
    expect(finalAcc.richContent[0]?.kind).toBe("thinking");
    expect(finalAcc.richContent[1]?.kind).toBe("tool_call");
  });
});

// ---------------------------------------------------------------------------
// Edge case 5: Mid-stream abort — tested at adapter level (adapter.test.ts)
// Parser itself just stops receiving chunks.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Edge case 6: Unicode surrogates in text delta
// ---------------------------------------------------------------------------

describe("edge case: unicode surrogates in text", () => {
  test("sanitizes lone surrogates in text deltas", () => {
    const chunks: ChatCompletionChunk[] = [
      {
        id: "g7",
        choices: [{ index: 0, delta: { content: "hello\uD800world" }, finish_reason: null }],
      },
      {
        id: "g7",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 3, completion_tokens: 1 },
      },
    ];

    const acc = createEmptyAccumulator("test-model");
    const parser = createStreamParser(acc);
    const output = feedAll(parser, chunks);

    const textDelta = output.find((c) => c.kind === "text_delta");
    expect(textDelta).toBeDefined();
    if (textDelta?.kind === "text_delta") {
      expect(textDelta.delta).toBe("hello\uFFFDworld");
    }
  });
});

// ---------------------------------------------------------------------------
// Edge case 7: Usage arrives only in final chunk
// ---------------------------------------------------------------------------

describe("edge case: usage in final chunk only", () => {
  test("emits usage chunk when usage arrives at end", () => {
    const chunks: ChatCompletionChunk[] = [
      {
        id: "g8",
        choices: [{ index: 0, delta: { content: "hi" }, finish_reason: null }],
      },
      {
        id: "g8",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 50,
          prompt_tokens_details: { cached_tokens: 30 },
        },
      },
    ];

    const acc = createEmptyAccumulator("test-model");
    const parser = createStreamParser(acc);
    const output = feedAll(parser, chunks);

    const usageChunks = output.filter((c) => c.kind === "usage");
    expect(usageChunks).toHaveLength(1);

    const usage = usageChunks[0];
    if (usage?.kind === "usage") {
      // inputTokens = total prompt_tokens (not reduced by cache)
      expect(usage.inputTokens).toBe(100);
      expect(usage.outputTokens).toBe(50);
    }

    // Verify accumulator got cache info
    const finalAcc = parser.getAccumulator();
    expect(finalAcc.cacheReadTokens).toBe(30);
  });
});

// ---------------------------------------------------------------------------
// Happy path: text-only stream
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// P2 regression: text block ordering preserved across interleaved content
// ---------------------------------------------------------------------------

describe("richContent block ordering", () => {
  test("text → tool → text produces three ordered blocks", () => {
    const chunks: ChatCompletionChunk[] = [
      // Text segment 1
      {
        id: "go",
        choices: [{ index: 0, delta: { content: "Before " }, finish_reason: null }],
      },
      // Tool call
      {
        id: "go",
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [{ index: 0, id: "c1", function: { name: "search", arguments: "{}" } }],
            },
            finish_reason: null,
          },
        ],
      },
      // Text segment 2 (after tool call ends via finish)
      // Note: in real APIs, text after tool_calls is rare but possible via multi-turn
    ];

    const acc = createEmptyAccumulator("test-model");
    const parser = createStreamParser(acc);
    feedAll(parser, chunks);
    parser.finish();

    const finalAcc = parser.getAccumulator();
    // Should have: text("Before ") → tool_call
    expect(finalAcc.richContent).toHaveLength(2);
    expect(finalAcc.richContent[0]?.kind).toBe("text");
    if (finalAcc.richContent[0]?.kind === "text") {
      expect(finalAcc.richContent[0].text).toBe("Before ");
    }
    expect(finalAcc.richContent[1]?.kind).toBe("tool_call");
  });

  test("thinking → text produces ordered blocks", () => {
    const chunks: ChatCompletionChunk[] = [
      {
        id: "gp",
        choices: [{ index: 0, delta: { reasoning_content: "Hmm..." }, finish_reason: null }],
      },
      {
        id: "gp",
        choices: [{ index: 0, delta: { content: "Answer!" }, finish_reason: null }],
      },
      {
        id: "gp",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 5, completion_tokens: 2 },
      },
    ];

    const acc = createEmptyAccumulator("test-model");
    const parser = createStreamParser(acc);
    feedAll(parser, chunks);
    parser.finish();

    const finalAcc = parser.getAccumulator();
    expect(finalAcc.richContent).toHaveLength(2);
    expect(finalAcc.richContent[0]?.kind).toBe("thinking");
    if (finalAcc.richContent[0]?.kind === "thinking") {
      expect(finalAcc.richContent[0].text).toBe("Hmm...");
    }
    expect(finalAcc.richContent[1]?.kind).toBe("text");
    if (finalAcc.richContent[1]?.kind === "text") {
      expect(finalAcc.richContent[1].text).toBe("Answer!");
    }
  });
});

// ---------------------------------------------------------------------------
// Happy path: text-only stream
// ---------------------------------------------------------------------------

describe("text-only stream", () => {
  test("yields text deltas and done", () => {
    const chunks: ChatCompletionChunk[] = [
      {
        id: "gen-1",
        choices: [{ index: 0, delta: { content: "Hello" }, finish_reason: null }],
      },
      {
        id: "gen-1",
        choices: [{ index: 0, delta: { content: " world" }, finish_reason: null }],
      },
      {
        id: "gen-1",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 2 },
      },
    ];

    const acc = createEmptyAccumulator("test-model");
    const parser = createStreamParser(acc);
    const output = feedAll(parser, chunks);
    parser.finish();

    const textDeltas = output.filter((c) => c.kind === "text_delta");
    expect(textDeltas).toHaveLength(2);

    const finalAcc = parser.getAccumulator();
    expect(finalAcc.textContent).toBe("Hello world");
    expect(finalAcc.responseId).toBe("gen-1");
    expect(finalAcc.stopReason).toBe("stop");
  });
});
