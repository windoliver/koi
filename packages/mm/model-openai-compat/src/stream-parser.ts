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
import type {
  ChatCompletionChunk,
  ChatCompletionChunkDelta,
  ChatCompletionChunkToolCall,
} from "./types.js";

// ---------------------------------------------------------------------------
// Parser state — discriminated union
// ---------------------------------------------------------------------------

type ParserState =
  | { readonly kind: "idle" }
  | { readonly kind: "text" }
  | { readonly kind: "thinking" }
  | { readonly kind: "tool_call"; readonly callId: string; argBuffer: string };

/**
 * One item in the ordered buffer used by buffered tool call mode.
 * Preserves the arrival order of text, thinking, and tool calls so that
 * the final richContent array matches the provider's chronological ordering
 * even for interleaved sequences like "tool A → text → tool B".
 */
type BufferedItem =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "thinking"; readonly text: string }
  | { readonly kind: "tool_ref"; readonly slotIdx: number };

// ---------------------------------------------------------------------------
// Unicode sanitization
// ---------------------------------------------------------------------------

// Lone surrogates (U+D800..U+DFFF) are invalid in UTF-8. Replace with U+FFFD.
const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

export function sanitizeUnicode(text: string): string {
  return text.replace(LONE_SURROGATE_RE, "\uFFFD");
}

// ---------------------------------------------------------------------------
// Reasoning field detection
// ---------------------------------------------------------------------------

/**
 * Extract reasoning/thinking content from a delta, checking multiple field names.
 * Returns the first non-empty value to avoid duplication (some providers like
 * chutes.ai send the same content in multiple fields).
 *
 * Field priority: reasoning_content > reasoning > reasoning_text
 */
function findReasoningContent(delta: ChatCompletionChunkDelta): string | undefined {
  const fields = [delta.reasoning_content, delta.reasoning, delta.reasoning_text];
  for (const field of fields) {
    if (field !== undefined && field !== null && field.length > 0) {
      return field;
    }
  }
  return undefined;
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
  // Cache read: prefer Anthropic-specific field, fall back to OpenAI-style
  const cacheRead =
    chunk.usage.cache_read_input_tokens ?? chunk.usage.prompt_tokens_details?.cached_tokens ?? 0;
  // Cache write: Anthropic-specific field (tokens written to cache this request)
  const cacheWrite = chunk.usage.cache_creation_input_tokens ?? 0;
  // inputTokens = total prompt tokens (not reduced by cache).
  // Cache info tracked separately for consumers that need it.
  acc.inputTokens = chunk.usage.prompt_tokens ?? 0;
  acc.outputTokens = chunk.usage.completion_tokens ?? 0;
  acc.cacheReadTokens = cacheRead;
  acc.cacheWriteTokens = cacheWrite;
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
  active: {
    readonly id: string;
    readonly name: string;
    readonly argBuffer: string;
    readonly startEmitted: boolean;
  },
  acc: MutableAccumulator,
): readonly ModelChunk[] {
  // Reject tool calls with empty function name — cannot be dispatched safely.
  // Emit a deferred tool_call_start first (if not yet emitted) so that
  // consume-stream's accumulator map has an entry for this callId, preventing
  // the "unknown" fallback when tool_call_end arrives for an untracked call.
  if (active.name === "") {
    const prefix: readonly ModelChunk[] = active.startEmitted
      ? []
      : [{ kind: "tool_call_start", toolName: "", callId: toolCallId(active.id) }];
    return [
      ...prefix,
      {
        kind: "error",
        message: `Tool call "${active.id}" has no function name — cannot dispatch`,
        code: "VALIDATION",
      },
    ];
  }

  // If tool_call_start was deferred but name arrived via a later delta
  // (startEmitted is still false here), emit it now before closing.
  const prefix: readonly ModelChunk[] = active.startEmitted
    ? []
    : [{ kind: "tool_call_start", toolName: active.name, callId: toolCallId(active.id) }];

  const result = parseToolArguments(active.argBuffer);
  if (result.ok) {
    acc.richContent.push({
      kind: "tool_call",
      id: toolCallId(active.id),
      name: active.name,
      arguments: result.args,
    });
    return [...prefix, { kind: "tool_call_end", callId: toolCallId(active.id) }];
  }
  // Invalid arguments — emit ONLY error, no tool_call_end.
  return [
    ...prefix,
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
    // Only emit delta if start was already emitted (name is known) and args are non-empty.
    // If name hasn't arrived yet, buffer args silently — no lifecycle
    // events until the tool call can be identified.
    if (active.startEmitted && tc.function.arguments.length > 0) {
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

/**
 * Accumulate a tool call delta into the ordered buffer (buffered mode only).
 *
 * Each unique (index, id) pair gets its own slot in bufferedSlots. A tool_ref
 * pointing at that slot is inserted into bufferedItems at the slot's first
 * appearance, preserving the chronological position among text/thinking items.
 *
 * Index reuse (provider sends a new call_id on the same chunk index) creates
 * a fresh slot — the displaced call's data is retained at its original slot.
 */
function bufferToolCallSlot(
  tc: ChatCompletionChunkToolCall,
  bufferedItems: BufferedItem[],
  bufferedSlots: Array<{ id: string; name: string; argBuffer: string }>,
  activeSlotByIndex: Map<number, number>,
): void {
  const idx = tc.index;
  const existingSlotIdx = activeSlotByIndex.get(idx);

  if (existingSlotIdx !== undefined) {
    const slot = bufferedSlots[existingSlotIdx];
    if (slot !== undefined && tc.id !== undefined && slot.id !== tc.id) {
      // Provider reusing chunk index for a different call — create a new slot
      const newSlotIdx = bufferedSlots.length;
      bufferedSlots.push({
        id: tc.id,
        name: tc.function?.name ?? "",
        argBuffer: tc.function?.arguments ?? "",
      });
      activeSlotByIndex.set(idx, newSlotIdx);
      bufferedItems.push({ kind: "tool_ref", slotIdx: newSlotIdx });
    } else if (slot !== undefined) {
      // Same call — accumulate name (unconditional overwrite) and args
      if (tc.function?.name !== undefined) slot.name = tc.function.name;
      if (tc.function?.arguments !== undefined) slot.argBuffer += tc.function.arguments;
    }
  } else {
    // First delta for this index — create slot and record its position
    const newSlotIdx = bufferedSlots.length;
    bufferedSlots.push({
      id: tc.id ?? `call_${idx}`,
      name: tc.function?.name ?? "",
      argBuffer: tc.function?.arguments ?? "",
    });
    activeSlotByIndex.set(idx, newSlotIdx);
    bufferedItems.push({ kind: "tool_ref", slotIdx: newSlotIdx });
  }
}

/**
 * Flush the ordered buffer to richContent and produce lifecycle chunks.
 * Processes bufferedItems in arrival order, so text/thinking/tool-calls
 * appear in richContent exactly as the provider sent them.
 */
function flushBufferedItems(
  bufferedItems: BufferedItem[],
  bufferedSlots: Array<{ id: string; name: string; argBuffer: string }>,
  acc: MutableAccumulator,
): readonly ModelChunk[] {
  const chunks: ModelChunk[] = [];
  for (const item of bufferedItems) {
    if (item.kind === "text") {
      acc.richContent.push({ kind: "text", text: item.text });
    } else if (item.kind === "thinking") {
      acc.richContent.push({ kind: "thinking", text: item.text });
    } else {
      const slot = bufferedSlots[item.slotIdx];
      if (slot === undefined) continue;
      if (slot.name === "") {
        chunks.push(
          { kind: "tool_call_start", toolName: "", callId: toolCallId(slot.id) },
          {
            kind: "error",
            message: `Tool call "${slot.id}" has no function name — cannot dispatch`,
            code: "VALIDATION",
          },
        );
        continue;
      }
      const result = parseToolArguments(slot.argBuffer);
      if (result.ok) {
        acc.richContent.push({
          kind: "tool_call",
          id: toolCallId(slot.id),
          name: slot.name,
          arguments: result.args,
        });
        chunks.push({ kind: "tool_call_start", toolName: slot.name, callId: toolCallId(slot.id) });
        if (slot.argBuffer.length > 0) {
          chunks.push({
            kind: "tool_call_delta",
            callId: toolCallId(slot.id),
            delta: slot.argBuffer,
          });
        }
        chunks.push({ kind: "tool_call_end", callId: toolCallId(slot.id) });
      } else {
        chunks.push(
          { kind: "tool_call_start", toolName: slot.name, callId: toolCallId(slot.id) },
          {
            kind: "error",
            message: `Invalid tool call arguments for "${slot.name}": ${result.raw}`,
            code: "VALIDATION",
          },
        );
      }
    }
  }
  bufferedItems.length = 0;
  return chunks;
}

// ---------------------------------------------------------------------------
// Stream parser internals
// ---------------------------------------------------------------------------

interface ParserContext {
  state: ParserState;
  acc: MutableAccumulator;
  readonly bufferToolCalls: boolean;
  /** True once any tool_calls delta has been seen in the raw stream (even if buffered). */
  sawToolCallDelta: boolean;
  /** Active tool calls (non-buffered streaming path only). */
  activeToolCalls: Map<
    number,
    { id: string; name: string; argBuffer: string; startEmitted: boolean }
  >;
  /** Ordered content items for buffered mode — preserves arrival order across text/thinking/tools. */
  bufferedItems: BufferedItem[];
  /** Resolved tool call data by slot index (buffered mode only). */
  bufferedSlots: Array<{ id: string; name: string; argBuffer: string }>;
  /** Maps chunk index → bufferedSlots index (buffered mode only). */
  activeSlotByIndex: Map<number, number>;
}

function flushCurrentSegment(ctx: ParserContext): void {
  if (ctx.state.kind === "text" && ctx.acc.currentTextSegment.length > 0) {
    const text = ctx.acc.currentTextSegment;
    // In buffered mode all content goes through bufferedItems to preserve
    // arrival order across interleaved text/thinking/tool sequences.
    if (ctx.bufferToolCalls) {
      ctx.bufferedItems.push({ kind: "text", text });
    } else {
      ctx.acc.richContent.push({ kind: "text", text });
    }
    ctx.acc.currentTextSegment = "";
  }
  if (ctx.state.kind === "thinking" && ctx.acc.currentThinkingSegment.length > 0) {
    const text = ctx.acc.currentThinkingSegment;
    if (ctx.bufferToolCalls) {
      ctx.bufferedItems.push({ kind: "thinking", text });
    } else {
      ctx.acc.richContent.push({ kind: "thinking", text });
    }
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

  // Check multiple reasoning field names — providers use different fields:
  // reasoning_content (Anthropic via OpenRouter), reasoning (some compat), reasoning_text (llama.cpp)
  // Use first non-empty to avoid duplication (some providers send same content in multiple fields)
  const reasoningContent = findReasoningContent(delta);
  if (reasoningContent !== undefined) {
    const r = processThinkingDelta(reasoningContent, ctx.state, ctx.acc, () => resetState(ctx));
    output.push(...r.chunks);
    ctx.state = r.newState;
  }

  if (delta.tool_calls !== undefined) {
    if (ctx.state.kind === "text" || ctx.state.kind === "thinking") {
      flushCurrentSegment(ctx);
      ctx.state = { kind: "idle" };
    }
    if (ctx.bufferToolCalls) {
      ctx.sawToolCallDelta = true;
      for (const tc of delta.tool_calls) {
        bufferToolCallSlot(tc, ctx.bufferedItems, ctx.bufferedSlots, ctx.activeSlotByIndex);
      }
    } else {
      for (const tc of delta.tool_calls) {
        output.push(...processToolCallDelta(tc, ctx.activeToolCalls, ctx.acc));
      }
      const lastEntry = [...ctx.activeToolCalls.values()].at(-1);
      if (lastEntry !== undefined) {
        ctx.state = { kind: "tool_call", callId: lastEntry.id, argBuffer: lastEntry.argBuffer };
      }
    }
  }

  return output;
}

function finishParsing(ctx: ParserContext): readonly ModelChunk[] {
  flushCurrentSegment(ctx);
  if (ctx.bufferToolCalls) {
    const output = [...flushBufferedItems(ctx.bufferedItems, ctx.bufferedSlots, ctx.acc)];
    ctx.state = { kind: "idle" };
    return output;
  }
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
export function createStreamParser(
  initialAccumulator: AccumulatedResponse,
  options?: { readonly supportsToolStreaming?: boolean },
): {
  feed: (chunk: ChatCompletionChunk) => readonly ModelChunk[];
  finish: () => readonly ModelChunk[];
  getAccumulator: () => AccumulatedResponse;
  hasSeenToolCallDelta: () => boolean;
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
    bufferToolCalls: !(options?.supportsToolStreaming ?? true),
    sawToolCallDelta: false,
    activeToolCalls: new Map(),
    bufferedItems: [],
    bufferedSlots: [],
    activeSlotByIndex: new Map(),
  };

  return {
    feed: (chunk) => feedChunk(ctx, chunk),
    finish: () => finishParsing(ctx),
    getAccumulator: () => ctx.acc,
    hasSeenToolCallDelta: () => ctx.sawToolCallDelta,
  };
}
