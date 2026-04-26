/**
 * Tool-recovery middleware factory — recovers structured tool calls from text
 * patterns in model responses (Hermes, Llama 3.1, optional JSON fence, custom).
 *
 * Phase: `resolve` (the default tier). Priority 180: outer onion layer.
 *
 * The middleware operates on the streaming path (`wrapModelStream`). The
 * engine's `consume-stream` reads tool calls from streamed `tool_call_start`
 * / `_delta` / `_end` chunks (NOT from `done.response.metadata.toolCalls`)
 * — so recovery synthesizes those structured chunks itself. To prevent raw
 * `<tool_call>...</tool_call>` markup from leaking into transcripts and UI,
 * `text_delta` chunks are buffered until the `done` chunk; only the cleaned
 * remainder is forwarded.
 *
 * Non-streaming `wrapModelCall` is intentionally NOT implemented: the engine
 * only consumes recovered calls from the streaming path. Adapters that lack
 * `modelStream` should be wrapped by the engine's stream-fallback so this
 * middleware still runs against the synthesized stream.
 */

import type { ToolCallId } from "@koi/core";
import { toolCallId } from "@koi/core";
import type {
  CapabilityFragment,
  KoiMiddleware,
  ModelChunk,
  ModelHandler,
  ModelRequest,
  ModelResponse,
  ModelStreamHandler,
  TurnContext,
} from "@koi/core/middleware";
import { KoiRuntimeError } from "@koi/errors";
import type { ToolRecoveryConfig } from "./config.js";
import {
  DEFAULT_MAX_TOOL_CALLS,
  DEFAULT_PATTERN_NAMES,
  validateToolRecoveryConfig,
} from "./config.js";
import { recoverToolCalls } from "./parse.js";
import { resolvePatterns } from "./patterns/registry.js";
import type { ParsedToolCall, RecoveryEvent, ToolCallPattern } from "./types.js";

/** Priority slot — outer onion layer; runs before sanitize/PII/audit. */
const TOOL_RECOVERY_PRIORITY = 180;

interface RecoveredCall {
  readonly toolName: string;
  readonly callId: ToolCallId;
  readonly input: ParsedToolCall["arguments"];
}

interface RecoveryRun {
  readonly cleanedText: string;
  readonly calls: readonly RecoveredCall[];
}

function runRecovery(
  ctx: TurnContext,
  bufferedText: string,
  tools: readonly { readonly name: string }[],
  patterns: readonly ToolCallPattern[],
  maxCalls: number,
  onEvent: ((event: RecoveryEvent) => void) | undefined,
): RecoveryRun | undefined {
  const allowed = new Set<string>(tools.map((t) => t.name));
  const result = recoverToolCalls(bufferedText, patterns, allowed, maxCalls, onEvent);
  if (result === undefined) return undefined;

  const calls: readonly RecoveredCall[] = result.toolCalls.map((call, index) => ({
    toolName: call.toolName,
    callId: toolCallId(`recovery-${ctx.turnId}-${String(index)}`),
    input: call.arguments,
  }));
  return { cleanedText: result.remainingText, calls };
}

function* synthesizeToolCallChunks(calls: readonly RecoveredCall[]): Iterable<ModelChunk> {
  for (const call of calls) {
    yield { kind: "tool_call_start", toolName: call.toolName, callId: call.callId };
    yield { kind: "tool_call_delta", callId: call.callId, delta: JSON.stringify(call.input) };
    yield { kind: "tool_call_end", callId: call.callId };
  }
}

/**
 * Creates a `KoiMiddleware` that recovers structured tool calls from text
 * patterns in model responses. See `ToolRecoveryConfig` for options.
 */
export function createToolRecoveryMiddleware(config?: ToolRecoveryConfig): KoiMiddleware {
  const validated = validateToolRecoveryConfig(config);
  if (!validated.ok) {
    throw KoiRuntimeError.from(validated.error.code, validated.error.message);
  }

  const cfg = validated.value;
  const patternEntries = cfg.patterns ?? DEFAULT_PATTERN_NAMES;
  const patterns: readonly ToolCallPattern[] = resolvePatterns(patternEntries);
  const maxCalls = cfg.maxToolCallsPerResponse ?? DEFAULT_MAX_TOOL_CALLS;
  const onEvent = cfg.onRecoveryEvent;

  const patternNames = patterns.map((p) => p.name).join(", ");
  const capabilityFragment: CapabilityFragment = {
    label: "tool-recovery",
    description: `Text tool-call recovery: ${patternNames}`,
  };

  // Markers known up front let the streaming wrapper decide per-chunk
  // whether to flush eagerly (no marker yet → preserve incremental UX) or
  // start buffering for end-of-stream parsing (marker seen → swallow until
  // done so we can emit synthesized tool_call chunks). Patterns without a
  // marker force buffering for any tool-enabled turn.
  const markers: readonly string[] = patterns
    .map((p) => p.marker)
    .filter((m): m is string => typeof m === "string" && m.length > 0);
  const allPatternsHaveMarkers = markers.length === patterns.length;
  const longestMarkerLen = markers.reduce((max, m) => Math.max(max, m.length), 0);

  function bufferedTextContainsAnyMarker(text: string): boolean {
    for (const m of markers) {
      if (text.includes(m)) return true;
    }
    return false;
  }

  async function* wrapModelStreamImpl(
    ctx: TurnContext,
    request: ModelRequest,
    next: ModelStreamHandler,
  ): AsyncIterable<ModelChunk> {
    // Cheap pre-check — skip recovery when there are no tools to recover into.
    const tools = request.tools;
    if (tools === undefined || tools.length === 0) {
      yield* next(request);
      return;
    }

    // let: chunks held back once we've decided this stream may contain
    // tool-call markup. Empty in passthrough mode.
    let pending: ModelChunk[] = [];
    // let: full assistant text seen so far. Used at done to parse, AND to
    // detect markers that may straddle delta boundaries.
    let bufferedText = "";
    // let: byte index in bufferedText up to which text has already been
    // forwarded as text_delta chunks. Anything past this is unflushed.
    let flushedTextIndex = 0;
    // let: switches to "buffer" mode the first time any pattern marker is
    // detected. Once active, all subsequent chunks are held until `done`.
    let mode: "passthrough" | "buffer" = allPatternsHaveMarkers ? "passthrough" : "buffer";
    // let: flips true if the adapter emits a native tool call — recovery is
    // disabled and remaining chunks pass through unmodified.
    let bypass = false;
    // let: tracks whether the upstream stream completed normally or threw
    // before emitting `done`. Used by the finally block to flush pending
    // chunks on partial-failure paths so degraded output isn't lost.
    let completed = false;

    try {
      for await (const chunk of next(request)) {
        if (bypass) {
          yield chunk;
          continue;
        }

        if (chunk.kind === "tool_call_start") {
          bypass = true;
          for (const buf of pending) yield buf;
          pending = [];
          yield chunk;
          continue;
        }

        if (chunk.kind === "done") {
          // Process below.
        } else if (chunk.kind === "text_delta") {
          bufferedText += chunk.delta;
          if (mode === "passthrough") {
            // Switch to buffer mode if a complete marker has appeared anywhere
            // in the assistant text so far.
            if (bufferedTextContainsAnyMarker(bufferedText)) {
              mode = "buffer";
              // Stash the unflushed text portion as a synthetic text_delta in
              // pending so the buffer flush replay sees full content even if
              // we change our mind later (currently we don't).
              const unflushed = bufferedText.slice(flushedTextIndex);
              if (unflushed.length > 0) {
                pending.push({ kind: "text_delta", delta: unflushed });
              }
              continue;
            }
            // No marker yet. Flush all but the trailing window that could
            // still be the prefix of a marker straddling the next chunk.
            const safeEnd = Math.max(0, bufferedText.length - longestMarkerLen);
            if (safeEnd > flushedTextIndex) {
              const safeText = bufferedText.slice(flushedTextIndex, safeEnd);
              flushedTextIndex = safeEnd;
              if (safeText.length > 0) yield { kind: "text_delta", delta: safeText };
            }
            continue;
          }
          // mode === "buffer"
          pending.push(chunk);
          continue;
        } else {
          // thinking_delta / usage / error / tool_call_delta / tool_call_end
          if (mode === "passthrough") {
            yield chunk;
          } else {
            pending.push(chunk);
          }
          continue;
        }

        // Done chunk: in passthrough mode, the upstream content is plain
        // text. Flush any remaining tail and pass done through. In buffer
        // mode, attempt recovery on the accumulated text.
        completed = true;

        if (mode === "passthrough") {
          const tail = bufferedText.slice(flushedTextIndex);
          if (tail.length > 0) yield { kind: "text_delta", delta: tail };
          yield chunk;
          return;
        }

        const recovered = runRecovery(ctx, bufferedText, tools, patterns, maxCalls, onEvent);

        if (recovered === undefined) {
          for (const buf of pending) yield buf;
          yield chunk;
          return;
        }

        // Replay non-text chunks first (thinking_delta, usage), drop raw text.
        for (const buf of pending) {
          if (buf.kind !== "text_delta") yield buf;
        }
        if (recovered.cleanedText.length > 0) {
          yield { kind: "text_delta", delta: recovered.cleanedText };
        }
        yield* synthesizeToolCallChunks(recovered.calls);
        const rewrittenResponse: ModelResponse = {
          ...chunk.response,
          content: recovered.cleanedText,
        };
        yield { kind: "done", response: rewrittenResponse };
        return;
      }
    } finally {
      if (!completed) {
        if (mode === "passthrough") {
          const tail = bufferedText.slice(flushedTextIndex);
          if (tail.length > 0) yield { kind: "text_delta", delta: tail };
        } else if (pending.length > 0) {
          for (const buf of pending) yield buf;
        }
      }
    }
  }

  async function wrapModelCallImpl(
    ctx: TurnContext,
    request: ModelRequest,
    next: ModelHandler,
  ): Promise<ModelResponse> {
    const tools = request.tools;
    if (tools === undefined || tools.length === 0) return next(request);

    const response = await next(request);
    // Skip recovery if the adapter already supplied native tool calls.
    if (response.metadata?.toolCalls !== undefined) return response;

    const recovered = runRecovery(ctx, response.content, tools, patterns, maxCalls, onEvent);
    if (recovered === undefined) return response;

    return {
      ...response,
      content: recovered.cleanedText,
      // Engine's synthesizeStream fallback (turn-runner) reads this shape and
      // emits structured tool_call_* chunks so non-streaming adapters get
      // executable tool calls.
      metadata: {
        ...response.metadata,
        toolCalls: recovered.calls.map((c) => ({
          toolName: c.toolName,
          callId: c.callId,
          input: c.input,
        })),
      },
    };
  }

  return {
    name: "koi:tool-recovery",
    priority: TOOL_RECOVERY_PRIORITY,
    phase: "resolve",
    describeCapabilities: (_ctx: TurnContext): CapabilityFragment => capabilityFragment,
    wrapModelCall: wrapModelCallImpl,
    wrapModelStream: wrapModelStreamImpl,
  };
}
