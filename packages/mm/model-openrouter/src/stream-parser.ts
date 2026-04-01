/**
 * Explicit state machine for parsing OpenAI Chat Completions SSE stream
 * into Koi ModelChunk events.
 *
 * Edge case matrix (each has a dedicated test):
 *  1. Empty stream — 200 OK, zero choices
 *  2. Interleaved tool calls — multiple tools streaming simultaneously
 *  3. Tool call with empty arguments
 *  4. Thinking followed by tool call — state transition
 *  5. Mid-stream abort — stream terminates cleanly
 *  6. Unicode surrogates — sanitized to valid UTF-8
 *  7. Usage in final chunk only
 */

import type { ModelChunk } from "@koi/core";
import { toolCallId } from "@koi/core";
import type { AccumulatedResponse } from "./response-mapper.js";
import { mapFinishReason, parseToolArguments } from "./response-mapper.js";
import type { ChatCompletionChunk, ChatCompletionChunkToolCall } from "./types.js";

// ---------------------------------------------------------------------------
// Parser state — discriminated union
// ---------------------------------------------------------------------------

type ParserState =
  | { readonly kind: "idle" }
  | { readonly kind: "text" }
  | { readonly kind: "thinking" }
  | { readonly kind: "tool_call"; readonly callId: string; argBuffer: string };

// ---------------------------------------------------------------------------
// Unicode sanitization
// ---------------------------------------------------------------------------

// Lone surrogates (U+D800..U+DFFF) are invalid in UTF-8. Replace with U+FFFD.
const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

export function sanitizeUnicode(text: string): string {
  return text.replace(LONE_SURROGATE_RE, "\uFFFD");
}

// ---------------------------------------------------------------------------
// SSE line parser
// ---------------------------------------------------------------------------

export type SSEParseResult =
  | { readonly ok: true; readonly chunk: ChatCompletionChunk }
  | { readonly ok: false; readonly raw: string };

/**
 * Parse SSE text into event payloads, spec-compliant for multi-line `data:` events.
 *
 * Per the SSE spec, one event can have multiple `data:` lines. They are joined
 * with `\n` before parsing. Events are delimited by blank lines.
 * Malformed JSON payloads are yielded as errors so callers can fail closed.
 */
export function* parseSSELines(text: string): Generator<SSEParseResult> {
  // Normalize CRLF → LF for SSE spec compliance (servers may use \r\n)
  const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const dataLines: string[] = [];

  for (const line of lines) {
    if (line.startsWith("data: ")) {
      dataLines.push(line.slice(6));
    } else if (line.startsWith("data:")) {
      // "data:" with no space — value is the rest of the line
      dataLines.push(line.slice(5));
    } else if (line === "" && dataLines.length > 0) {
      // Blank line = event boundary — flush accumulated data lines
      const payload = dataLines.join("\n").trim();
      dataLines.length = 0;
      if (payload === "[DONE]" || payload === "") continue;
      try {
        yield { ok: true, chunk: JSON.parse(payload) as ChatCompletionChunk };
      } catch {
        yield { ok: false, raw: payload };
      }
    }
  }

  // Flush any remaining data lines (stream may not end with blank line)
  if (dataLines.length > 0) {
    const payload = dataLines.join("\n").trim();
    if (payload !== "[DONE]" && payload !== "") {
      try {
        yield { ok: true, chunk: JSON.parse(payload) as ChatCompletionChunk };
      } catch {
        yield { ok: false, raw: payload };
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Mutable accumulator for parser state
// ---------------------------------------------------------------------------

interface MutableAccumulator {
  responseId: string;
  model: string;
  textContent: string;
  /** Buffer for the current text segment (flushed on state transition). */
  currentTextSegment: string;
  /** Buffer for the current thinking segment (flushed on state transition). */
  currentThinkingSegment: string;
  richContent: Array<import("@koi/core").ModelContentBlock>;
  stopReason: import("@koi/core").ModelStopReason;
  /** Whether a finish_reason was received from the provider. */
  receivedFinishReason: boolean;
  /** Whether any usage data was received from the provider. */
  receivedUsage: boolean;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

// ---------------------------------------------------------------------------
// Helper: process usage from chunk
// ---------------------------------------------------------------------------

function processUsage(chunk: ChatCompletionChunk, acc: MutableAccumulator): ModelChunk | undefined {
  if (chunk.usage === undefined) return undefined;
  const cachedTokens = chunk.usage.prompt_tokens_details?.cached_tokens ?? 0;
  // inputTokens = total prompt tokens (not reduced by cache).
  // Cache info tracked separately in cacheReadTokens for consumers that need it.
  // This ensures governance/accounting sees the full token count.
  acc.inputTokens = chunk.usage.prompt_tokens ?? 0;
  acc.outputTokens = chunk.usage.completion_tokens ?? 0;
  acc.cacheReadTokens = cachedTokens;
  acc.receivedUsage = true;
  return { kind: "usage", inputTokens: acc.inputTokens, outputTokens: acc.outputTokens };
}

// ---------------------------------------------------------------------------
// Helper: process text delta
// ---------------------------------------------------------------------------

function processTextDelta(
  content: string,
  state: ParserState,
  acc: MutableAccumulator,
  finishBlock: () => readonly ModelChunk[],
): { chunks: readonly ModelChunk[]; newState: ParserState } {
  const chunks: ModelChunk[] = [];
  let newState = state;
  if (state.kind !== "text") {
    chunks.push(...finishBlock());
    newState = { kind: "text" };
    acc.currentTextSegment = "";
  }
  const sanitized = sanitizeUnicode(content);
  acc.textContent += sanitized;
  acc.currentTextSegment += sanitized;
  chunks.push({ kind: "text_delta", delta: sanitized });
  return { chunks, newState };
}

// ---------------------------------------------------------------------------
// Helper: process thinking delta
// ---------------------------------------------------------------------------

function processThinkingDelta(
  content: string,
  state: ParserState,
  acc: MutableAccumulator,
  finishBlock: () => readonly ModelChunk[],
): { chunks: readonly ModelChunk[]; newState: ParserState } {
  const chunks: ModelChunk[] = [];
  let newState = state;
  if (state.kind !== "thinking") {
    chunks.push(...finishBlock());
    newState = { kind: "thinking" };
    acc.currentThinkingSegment = "";
  }
  const sanitized = sanitizeUnicode(content);
  acc.currentThinkingSegment += sanitized;
  chunks.push({ kind: "thinking_delta", delta: sanitized });
  return { chunks, newState };
}

// ---------------------------------------------------------------------------
// Helper: process tool call deltas
// ---------------------------------------------------------------------------

function closeOneToolCall(
  active: { readonly id: string; readonly name: string; readonly argBuffer: string },
  acc: MutableAccumulator,
): readonly ModelChunk[] {
  // Reject tool calls with empty function name — cannot be dispatched safely
  if (active.name === "") {
    return [
      {
        kind: "error",
        message: `Tool call "${active.id}" has no function name — cannot dispatch`,
        code: "VALIDATION",
      },
    ];
  }

  const result = parseToolArguments(active.argBuffer);
  if (result.ok) {
    acc.richContent.push({
      kind: "tool_call",
      id: toolCallId(active.id),
      name: active.name,
      arguments: result.args,
    });
    return [{ kind: "tool_call_end", callId: toolCallId(active.id) }];
  }
  // Invalid arguments — emit ONLY error, no tool_call_end.
  return [
    {
      kind: "error",
      message: `Invalid tool call arguments for "${active.name}": ${result.raw}`,
      code: "VALIDATION",
    },
  ];
}

function processToolCallDelta(
  tc: ChatCompletionChunkToolCall,
  activeToolCalls: Map<
    number,
    { id: string; name: string; argBuffer: string; startEmitted: boolean }
  >,
  acc: MutableAccumulator,
): readonly ModelChunk[] {
  const chunks: ModelChunk[] = [];
  const idx = tc.index;
  let active = activeToolCalls.get(idx);

  if (active === undefined || (tc.id !== undefined && active.id !== tc.id)) {
    if (active !== undefined) {
      chunks.push(...closeOneToolCall(active, acc));
    }
    const callId = tc.id ?? `call_${idx}`;
    const name = tc.function?.name ?? "";
    active = { id: callId, name, argBuffer: "", startEmitted: false };
    activeToolCalls.set(idx, active);
    // Defer tool_call_start until we have a non-empty name
    if (name.length > 0) {
      chunks.push({ kind: "tool_call_start", toolName: name, callId: toolCallId(callId) });
      active.startEmitted = true;
    }
  }

  if (tc.function?.name !== undefined) {
    active.name = tc.function.name;
    // Emit deferred tool_call_start now that we have the name
    if (!active.startEmitted && active.name.length > 0) {
      chunks.push({
        kind: "tool_call_start",
        toolName: active.name,
        callId: toolCallId(active.id),
      });
      active.startEmitted = true;
    }
  }

  if (tc.function?.arguments !== undefined) {
    active.argBuffer += tc.function.arguments;
    // Only emit delta if start was already emitted (name is known).
    // If name hasn't arrived yet, buffer args silently — no lifecycle
    // events until the tool call can be identified.
    if (active.startEmitted) {
      chunks.push({
        kind: "tool_call_delta",
        callId: toolCallId(active.id),
        delta: tc.function.arguments,
      });
    }
  }
  return chunks;
}

// ---------------------------------------------------------------------------
// Helper: close all active tool calls
// ---------------------------------------------------------------------------

function closeActiveToolCalls(
  activeToolCalls: Map<
    number,
    { id: string; name: string; argBuffer: string; startEmitted: boolean }
  >,
  acc: MutableAccumulator,
): readonly ModelChunk[] {
  const chunks: ModelChunk[] = [];
  for (const [, active] of activeToolCalls) {
    chunks.push(...closeOneToolCall(active, acc));
  }
  activeToolCalls.clear();
  return chunks;
}

// ---------------------------------------------------------------------------
// Stream parser internals
// ---------------------------------------------------------------------------

interface ParserContext {
  state: ParserState;
  acc: MutableAccumulator;
  activeToolCalls: Map<
    number,
    { id: string; name: string; argBuffer: string; startEmitted: boolean }
  >;
}

function flushCurrentSegment(ctx: ParserContext): void {
  if (ctx.state.kind === "text" && ctx.acc.currentTextSegment.length > 0) {
    ctx.acc.richContent.push({ kind: "text", text: ctx.acc.currentTextSegment });
    ctx.acc.currentTextSegment = "";
  }
  if (ctx.state.kind === "thinking" && ctx.acc.currentThinkingSegment.length > 0) {
    ctx.acc.richContent.push({ kind: "thinking", text: ctx.acc.currentThinkingSegment });
    ctx.acc.currentThinkingSegment = "";
  }
}

function resetState(ctx: ParserContext): readonly ModelChunk[] {
  flushCurrentSegment(ctx);
  ctx.state = { kind: "idle" };
  return [];
}

function feedChunk(ctx: ParserContext, chunk: ChatCompletionChunk): readonly ModelChunk[] {
  const output: ModelChunk[] = [];
  if (chunk.id && ctx.acc.responseId === "") ctx.acc.responseId = chunk.id;

  const usageChunk = processUsage(chunk, ctx.acc);
  if (usageChunk !== undefined) output.push(usageChunk);

  const choice = chunk.choices[0];
  if (choice === undefined) return output;
  if (choice.finish_reason !== null) {
    ctx.acc.stopReason = mapFinishReason(choice.finish_reason);
    ctx.acc.receivedFinishReason = true;
  }

  const delta = choice.delta;

  if (delta.content !== undefined && delta.content !== null && delta.content.length > 0) {
    const r = processTextDelta(delta.content, ctx.state, ctx.acc, () => resetState(ctx));
    output.push(...r.chunks);
    ctx.state = r.newState;
  }

  if (
    delta.reasoning_content !== undefined &&
    delta.reasoning_content !== null &&
    delta.reasoning_content.length > 0
  ) {
    const r = processThinkingDelta(delta.reasoning_content, ctx.state, ctx.acc, () =>
      resetState(ctx),
    );
    output.push(...r.chunks);
    ctx.state = r.newState;
  }

  if (delta.tool_calls !== undefined) {
    // Flush any in-progress text/thinking segment before processing tool calls
    if (ctx.state.kind === "text" || ctx.state.kind === "thinking") {
      flushCurrentSegment(ctx);
      ctx.state = { kind: "idle" };
    }
    for (const tc of delta.tool_calls) {
      output.push(...processToolCallDelta(tc, ctx.activeToolCalls, ctx.acc));
    }
    const lastEntry = [...ctx.activeToolCalls.values()].at(-1);
    if (lastEntry !== undefined) {
      ctx.state = { kind: "tool_call", callId: lastEntry.id, argBuffer: lastEntry.argBuffer };
    }
  }

  return output;
}

function finishParsing(ctx: ParserContext): readonly ModelChunk[] {
  // Flush any in-progress text/thinking segment before closing tool calls
  flushCurrentSegment(ctx);
  const output = [...closeActiveToolCalls(ctx.activeToolCalls, ctx.acc)];
  ctx.state = { kind: "idle" };
  return output;
}

// ---------------------------------------------------------------------------
// Stream parser factory
// ---------------------------------------------------------------------------

/**
 * Stateful stream parser. Feed it SSE chunks one at a time; it emits
 * ModelChunk events and updates the accumulator.
 */
export function createStreamParser(initialAccumulator: AccumulatedResponse): {
  feed: (chunk: ChatCompletionChunk) => readonly ModelChunk[];
  finish: () => readonly ModelChunk[];
  getAccumulator: () => AccumulatedResponse;
} {
  const ctx: ParserContext = {
    state: { kind: "idle" },
    acc: {
      ...initialAccumulator,
      richContent: [...initialAccumulator.richContent],
      currentTextSegment: "",
      currentThinkingSegment: "",
      receivedFinishReason: false,
      receivedUsage: false,
    },
    activeToolCalls: new Map(),
  };

  return {
    feed: (chunk) => feedChunk(ctx, chunk),
    finish: () => finishParsing(ctx),
    getAccumulator: () => ctx.acc,
  };
}
