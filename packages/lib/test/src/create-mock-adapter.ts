/**
 * Mock ModelAdapter that replays pre-scripted responses.
 *
 * ## Design
 *
 * Callers provide a list of `MockCall` specs, one per expected model call.
 * Each spec is tagged with its mode (`complete` or `stream`). The adapter
 * advances the call index each time a handler is invoked:
 *
 *  - `complete()` advances immediately on call and returns the response.
 *    Throws if the current call is tagged `stream` — no silent coercion.
 *  - `stream()` returns an async generator that advances the call index
 *    **on first pull**, not at construction. A stream that is created but
 *    never iterated does NOT burn a response. This matches how real model
 *    adapters behave and prevents tests from silently masking bugs.
 *
 * On exhaustion, the default `onExhausted: "throw"` surfaces runaway loops.
 * Pass `"repeat-last"` to replay the final call indefinitely.
 */

import type {
  ModelAdapter,
  ModelCapabilities,
  ModelChunk,
  ModelRequest,
  ModelResponse,
} from "@koi/core";

export type MockCall =
  | { readonly mode: "complete"; readonly response: ModelResponse }
  | { readonly mode: "stream"; readonly chunks: readonly ModelChunk[] };

export type ExhaustionPolicy = "throw" | "repeat-last";

export interface MockAdapterConfig {
  readonly calls: readonly MockCall[];
  readonly id?: string;
  readonly provider?: string;
  readonly capabilities?: Partial<ModelCapabilities>;
  /** Default: "throw". "repeat-last" replays the final call on every extra invocation. */
  readonly onExhausted?: ExhaustionPolicy;
}

export interface RecordedModelCall {
  readonly request: ModelRequest;
  readonly mode: "complete" | "stream";
  readonly timestamp: number;
}

export interface MockAdapterResult {
  readonly adapter: ModelAdapter;
  readonly calls: readonly RecordedModelCall[];
  readonly callCount: () => number;
  readonly reset: () => void;
}

const DEFAULT_CAPABILITIES: ModelCapabilities = {
  streaming: true,
  functionCalling: true,
  vision: false,
  jsonMode: false,
  maxContextTokens: 200_000,
  maxOutputTokens: 8192,
};

export function createMockAdapter(config: MockAdapterConfig): MockAdapterResult {
  const scripted = config.calls;
  const onExhausted: ExhaustionPolicy = config.onExhausted ?? "throw";
  const recorded: RecordedModelCall[] = [];
  let index = 0;

  function nextCall(callerMode: "complete" | "stream"): MockCall {
    if (index >= scripted.length) {
      if (onExhausted === "repeat-last") {
        const last = scripted[scripted.length - 1];
        if (last === undefined) {
          throw new Error(
            `createMockAdapter: no scripted calls configured (onExhausted=repeat-last needs at least one call)`,
          );
        }
        if (last.mode !== callerMode) {
          throw new Error(
            `createMockAdapter: repeat-last call at index ${index} has mode=${last.mode}, but ${callerMode}() was invoked`,
          );
        }
        return last;
      }
      throw new Error(
        `createMockAdapter: scripted calls exhausted (index ${index}, total ${scripted.length}); ${callerMode}() called after the last scripted response`,
      );
    }
    const call = scripted[index];
    if (call === undefined) {
      throw new Error(`createMockAdapter: scripted call at index ${index} is undefined`);
    }
    if (call.mode !== callerMode) {
      throw new Error(
        `createMockAdapter: expected ${call.mode} call at index ${index}, but ${callerMode}() was invoked`,
      );
    }
    index += 1;
    return call;
  }

  function record(request: ModelRequest, mode: "complete" | "stream"): void {
    recorded.push({ request, mode, timestamp: Date.now() });
  }

  const adapter: ModelAdapter = {
    id: config.id ?? "mock-adapter",
    provider: config.provider ?? "mock",
    capabilities: { ...DEFAULT_CAPABILITIES, ...config.capabilities },

    async complete(request: ModelRequest): Promise<ModelResponse> {
      record(request, "complete");
      const call = nextCall("complete");
      // Type-narrow: nextCall throws on mode mismatch
      if (call.mode !== "complete") {
        throw new Error("unreachable: nextCall should have thrown on mode mismatch");
      }
      return call.response;
    },

    stream(request: ModelRequest): AsyncIterable<ModelChunk> {
      // Record eagerly at stream() call-time because real adapters
      // perform observable work before iteration begins — the
      // openai-compat adapter, for example, fires `lazyPrewarm()`
      // (an authenticated HEAD request) inside `stream()` before the
      // consumer ever pulls. The mock mirrors that: `calls[]` captures
      // every `stream()` invocation so tests can catch leaked-stream
      // bugs that would have side-effected in production.
      //
      // Scripted-response consumption stays lazy — the call index
      // advances on first pull — so an un-iterated stream does not
      // burn a scripted response. This is the deliberate split:
      //   - calls[]          → observable side effects (eager)
      //   - callCount() / index → scripted response consumption (lazy)
      record(request, "stream");
      return {
        [Symbol.asyncIterator](): AsyncIterator<ModelChunk> {
          let started = false;
          let chunks: readonly ModelChunk[] = [];
          let chunkIndex = 0;
          return {
            next(): Promise<IteratorResult<ModelChunk>> {
              if (!started) {
                const call = nextCall("stream");
                if (call.mode !== "stream") {
                  return Promise.reject(
                    new Error("unreachable: nextCall should have thrown on mode mismatch"),
                  );
                }
                chunks = call.chunks;
                started = true;
              }
              if (chunkIndex >= chunks.length) {
                return Promise.resolve({ value: undefined, done: true });
              }
              const chunk = chunks[chunkIndex];
              chunkIndex += 1;
              if (chunk === undefined) {
                return Promise.resolve({ value: undefined, done: true });
              }
              return Promise.resolve({ value: chunk, done: false });
            },
          };
        },
      };
    },
  };

  return {
    adapter,
    calls: recorded,
    callCount: (): number => index,
    reset: (): void => {
      index = 0;
      recorded.length = 0;
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers for constructing common call shapes
// ---------------------------------------------------------------------------

/** Build a minimal ModelResponse from a text string. */
export function textResponse(text: string, opts?: { readonly model?: string }): ModelResponse {
  return {
    content: text,
    model: opts?.model ?? "mock-model",
    stopReason: "stop",
  };
}

/** Build a minimal ModelChunk sequence that streams text then terminates. */
export function streamTextChunks(text: string): readonly ModelChunk[] {
  return [
    { kind: "text_delta", delta: text },
    {
      kind: "done",
      response: textResponse(text),
    },
  ];
}
