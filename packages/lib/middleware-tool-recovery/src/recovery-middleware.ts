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
  invocationNonce: string,
  bufferedText: string,
  tools: readonly { readonly name: string }[],
  patterns: readonly ToolCallPattern[],
  maxCalls: number,
  onEvent: ((event: RecoveryEvent) => void) | undefined,
): RecoveryRun | undefined {
  const allowed = new Set<string>(tools.map((t) => t.name));
  const result = recoverToolCalls(bufferedText, patterns, allowed, maxCalls, onEvent);
  if (result === undefined) return undefined;

  // Seed callIds with a per-invocation nonce so multiple recovered
  // model invocations within the same turn don't collide on
  // `recovery-<turnId>-<index>`. Collisions overwrote earlier
  // selector bindings keyed by callId and corrupted any other
  // callId-keyed correlation (transcript, result pairing).
  // #review-round21-F3.
  const calls: readonly RecoveredCall[] = result.toolCalls.map((call, index) => ({
    toolName: call.toolName,
    callId: toolCallId(`recovery-${ctx.turnId}-${invocationNonce}-${String(index)}`),
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
  const recoverOnStreamError = cfg.recoverOnStreamError ?? false;
  const defaultModel = cfg.defaultModel;
  // Wrap the user-supplied telemetry sink so a throwing observer cannot
  // abort recoverToolCalls and turn an otherwise valid recovered tool
  // call into a user-visible model-stream failure (worse: in the catch
  // path of wrapModelStreamImpl recovery is retried with the same
  // unguarded callback, compounding the failure). Telemetry is
  // best-effort; failures route nowhere because this middleware does not
  // own an onError sink. #review-round25-F2.
  const rawOnEvent = cfg.onRecoveryEvent;
  const onEvent: ((event: RecoveryEvent) => void) | undefined =
    rawOnEvent === undefined
      ? undefined
      : (event): void => {
          try {
            rawOnEvent(event);
          } catch {
            // best-effort telemetry; intentionally swallowed
          }
        };

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
    // Cheap pre-check — skip recovery when there are no tools to recover
    // into, or when no patterns were configured (the safe default).
    const tools = request.tools;
    if (tools === undefined || tools.length === 0 || patterns.length === 0) {
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
    // let: text that has already been yielded to the consumer in passthrough
    // mode and trimmed off bufferedText to bound memory on long generations
    // (#review-round38-F2). Reconstructs the full response.content if the
    // stream later switches to buffer mode and recovery rewrites the done.
    let streamedPrefix = "";
    // let: switches to "buffer" mode the first time any pattern marker is
    // detected. Once active, all subsequent chunks are held until `done`.
    let mode: "passthrough" | "buffer" = allPatternsHaveMarkers ? "passthrough" : "buffer";
    // let: flips true if the adapter emits a native tool call — recovery is
    // disabled and remaining chunks pass through unmodified.
    let bypass = false;
    // Per-invocation nonce so recovered callIds don't collide across
    // multiple model invocations within the same turn
    // (#review-round21-F3). Random hex segment + monotonic clock.
    const invocationNonce = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    // let: most recent usage observed on the upstream stream. Captured
    // from `usage` chunks AND from any `usage` field on a terminal
    // `error` chunk. Used to preserve token accounting on synthesized
    // recovery `done` responses so downstream cost / budget middleware
    // does not record recovered turns as zero-spend
    // (#review-round40-F1).
    let lastUsage: ModelResponse["usage"] | undefined;

    try {
      for await (const chunk of next(request)) {
        if (chunk.kind === "usage") {
          lastUsage = { inputTokens: chunk.inputTokens, outputTokens: chunk.outputTokens };
        } else if (chunk.kind === "error" && chunk.usage !== undefined) {
          lastUsage = {
            inputTokens: chunk.usage.inputTokens,
            outputTokens: chunk.usage.outputTokens,
          };
        }
        if (bypass) {
          yield chunk;
          continue;
        }

        if (chunk.kind === "tool_call_start") {
          bypass = true;
          // In passthrough mode we deliberately withhold the trailing
          // marker-prefix window from text_delta forwarding (so a marker
          // split across chunks can still be detected). When the adapter
          // emits a native tool_call_start we hand control back unchanged
          // — but the withheld tail must still reach the consumer or
          // assistant text immediately preceding the tool call gets
          // silently truncated. #review-round12-F2.
          if (mode === "passthrough" && bufferedText.length > flushedTextIndex) {
            const tail = bufferedText.slice(flushedTextIndex);
            flushedTextIndex = bufferedText.length;
            yield { kind: "text_delta", delta: tail };
          }
          for (const buf of pending) yield buf;
          pending = [];
          yield chunk;
          continue;
        }

        if (chunk.kind === "done") {
          // Some adapters emit no text_delta and surface assistant text
          // only via the terminal done.response.content chunk. Without
          // this fallback, recovery would skip those streams entirely
          // (mode never leaves passthrough → bufferedText stays empty)
          // and tool-call markup in `done.response.content` would never
          // be parsed (#review-round18-F1). Treat the done payload as
          // a synthetic terminal text_delta when nothing was streamed
          // and the response carries content with a candidate marker.
          if (
            mode === "passthrough" &&
            bufferedText.length === 0 &&
            chunk.response.content.length > 0 &&
            (markers.length === 0 || bufferedTextContainsAnyMarker(chunk.response.content))
          ) {
            bufferedText = chunk.response.content;
            mode = "buffer";
            // Stash a synthetic text_delta in `pending` so the buffer
            // path's "non-text replay, drop raw text" semantics see a
            // delta to drop. (We never replay it as text — the synth
            // exists only to mirror the streamed-buffer code path.)
            pending.push({ kind: "text_delta", delta: chunk.response.content });
          }
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
            // Trim flushed prefix so bufferedText stays a rolling marker
            // window rather than the entire response. Without this, long
            // plain-text generations grow memory linearly AND each
            // marker check rescans the full history (#review-round38-F2).
            if (flushedTextIndex > 0) {
              streamedPrefix += bufferedText.slice(0, flushedTextIndex);
              bufferedText = bufferedText.slice(flushedTextIndex);
              flushedTextIndex = 0;
            }
            continue;
          }
          // mode === "buffer"
          pending.push(chunk);
          continue;
        } else if (chunk.kind === "error") {
          // ModelChunk.error is a terminal chunk (consumeModelStream surfaces
          // it the same as a thrown stream). In passthrough mode, pass it
          // through untouched. In buffer mode, this is the only signal the
          // consumer will see — without explicit handling the loop falls off
          // after the upstream iterator ends and we'd emit nothing, dropping
          // both the recovered tool call AND the underlying provider/hook
          // failure (#review-round26-F1). Mirror the catch-path's recover-
          // and-synth-done logic; if recovery fails, replay pending and
          // surface the error.
          if (mode === "passthrough") {
            // Flush the withheld marker-prefix tail before surfacing the
            // terminal error — otherwise the last `longestMarkerLen`
            // characters of assistant text are silently dropped, which
            // can erase the entire response on short outputs
            // (#review-round32-F2).
            const tail = bufferedText.slice(flushedTextIndex);
            if (tail.length > 0) yield { kind: "text_delta", delta: tail };
            yield chunk;
            return;
          }
          if (!bypass && recoverOnStreamError) {
            const recovered = runRecovery(
              ctx,
              invocationNonce,
              bufferedText,
              tools,
              patterns,
              maxCalls,
              onEvent,
            );
            if (recovered !== undefined && recovered.calls.length > 0) {
              for (const buf of pending) {
                if (buf.kind !== "text_delta") yield buf;
              }
              if (recovered.cleanedText.length > 0) {
                yield { kind: "text_delta", delta: recovered.cleanedText };
              }
              yield* synthesizeToolCallChunks(recovered.calls);
              // Preserve provider model + accumulated usage so downstream
              // cost / budget / reporting middleware records recovered
              // turns against the real provider, not as zero-spend
              // anonymous calls (#review-round40-F1).
              const syntheticResponse: ModelResponse = {
                content: streamedPrefix + recovered.cleanedText,
                model: request.model ?? defaultModel ?? "unknown",
                ...(lastUsage !== undefined ? { usage: lastUsage } : {}),
                metadata: { recoveryError: chunk.message, recovered: true },
              };
              yield { kind: "done", response: syntheticResponse };
              return;
            }
          }
          for (const buf of pending) yield buf;
          yield chunk;
          return;
        } else {
          // thinking_delta / usage / tool_call_delta / tool_call_end
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
        if (mode === "passthrough") {
          const tail = bufferedText.slice(flushedTextIndex);
          if (tail.length > 0) yield { kind: "text_delta", delta: tail };
          yield chunk;
          return;
        }

        const recovered = runRecovery(
          ctx,
          invocationNonce,
          bufferedText,
          tools,
          patterns,
          maxCalls,
          onEvent,
        );

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
        // Preserve any passthrough-streamed prefix that was trimmed off
        // bufferedText for memory bounding (#review-round38-F2). The
        // user-visible streamed transcript already saw the prefix; this
        // restores it in response.content for downstream middleware that
        // reads the full done payload.
        const rewrittenResponse: ModelResponse = {
          ...chunk.response,
          content: streamedPrefix + recovered.cleanedText,
        };
        yield { kind: "done", response: rewrittenResponse };
        return;
      }
    } catch (upstreamError: unknown) {
      // Stream errored before emitting `done`. If we entered buffer mode
      // and recovery produces executable calls, synthesize a terminal
      // done chunk so the engine actually runs those calls — emitting
      // recovered tool_call_* chunks alone is not enough because the
      // runner aborts the turn on any thrown stream. We surface the
      // original error via response.metadata so callers can still
      // observe the underlying failure. #review-round12-F3.
      if (!bypass && mode === "buffer" && recoverOnStreamError) {
        const recovered = runRecovery(
          ctx,
          invocationNonce,
          bufferedText,
          tools,
          patterns,
          maxCalls,
          onEvent,
        );
        if (recovered !== undefined && recovered.calls.length > 0) {
          for (const buf of pending) {
            if (buf.kind !== "text_delta") yield buf;
          }
          if (recovered.cleanedText.length > 0) {
            yield { kind: "text_delta", delta: recovered.cleanedText };
          }
          yield* synthesizeToolCallChunks(recovered.calls);
          const errorMessage =
            upstreamError instanceof Error ? upstreamError.message : String(upstreamError);
          // Preserve provider model + accumulated usage so downstream
          // cost / budget / reporting middleware records recovered turns
          // against the real provider, not as zero-spend anonymous calls
          // (#review-round40-F1).
          const syntheticResponse: ModelResponse = {
            content: streamedPrefix + recovered.cleanedText,
            model: request.model ?? defaultModel ?? "unknown",
            ...(lastUsage !== undefined ? { usage: lastUsage } : {}),
            metadata: { recoveryError: errorMessage, recovered: true },
          };
          yield { kind: "done", response: syntheticResponse };
          return;
        }
      }
      // No recovery possible — preserve any pending output, then rethrow.
      if (mode === "passthrough") {
        const tail = bufferedText.slice(flushedTextIndex);
        if (tail.length > 0) yield { kind: "text_delta", delta: tail };
      } else if (pending.length > 0) {
        for (const buf of pending) yield buf;
      }
      throw upstreamError;
    }
  }

  return {
    name: "koi:tool-recovery",
    priority: TOOL_RECOVERY_PRIORITY,
    phase: "resolve",
    describeCapabilities: (_ctx: TurnContext): CapabilityFragment => capabilityFragment,
    // Streaming-only: the engine consumes tool calls from `tool_call_end`
    // events on the model stream. The wrapModelCall hook is intentionally
    // absent — execution from generic `ModelResponse.metadata` would be a
    // forge-able trust channel (any middleware/adapter could synthesize
    // recovered calls). Adapters that lack a native modelStream must be
    // wrapped by the engine's stream fallback for recovery to apply.
    wrapModelStream: wrapModelStreamImpl,
  };
}
