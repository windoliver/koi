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

    // let: buffer of every chunk seen before `done`. Held back so recovered
    // markup never reaches transcripts/UI.
    let pending: ModelChunk[] = [];
    // let: text accumulator used by the recovery parser at flush time.
    let bufferedText = "";
    // let: flips true if the adapter emits a native tool call — recovery is
    // disabled and the buffered chunks are flushed unmodified.
    let bypass = false;

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

      if (chunk.kind !== "done") {
        if (chunk.kind === "text_delta") bufferedText += chunk.delta;
        pending.push(chunk);
        continue;
      }

      // Done chunk: try recovery on the buffered text.
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
      // Emit the cleaned remainder as a single text_delta so transcripts
      // capture the visible assistant content without the recovered markup.
      if (recovered.cleanedText.length > 0) {
        yield { kind: "text_delta", delta: recovered.cleanedText };
      }
      // Synthesize structured tool-call chunks the engine can execute.
      yield* synthesizeToolCallChunks(recovered.calls);

      // Rewrite the embedded ModelResponse so observers that DO read it see
      // the cleaned content (transcript fallbacks, debug logs).
      const rewrittenResponse: ModelResponse = {
        ...chunk.response,
        content: recovered.cleanedText,
      };
      yield { kind: "done", response: rewrittenResponse };
      return;
    }
  }

  return {
    name: "koi:tool-recovery",
    priority: TOOL_RECOVERY_PRIORITY,
    phase: "resolve",
    describeCapabilities: (_ctx: TurnContext): CapabilityFragment => capabilityFragment,
    wrapModelStream: wrapModelStreamImpl,
  };
}
