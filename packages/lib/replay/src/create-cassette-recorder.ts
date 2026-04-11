import type {
  EngineAdapter,
  EngineCapabilities,
  EngineEvent,
  EngineInput,
  ModelChunk,
  ModelResponse,
} from "@koi/core";
import type { Cassette } from "./types.js";
import { CASSETTE_SCHEMA_VERSION } from "./types.js";

/**
 * Strips volatile fields from a `done` chunk's response that change on every
 * recording run and would cause false diffs in replay/diff mode.
 *
 * Stripped: responseId, metadata.promptPrefixFingerprint (and all metadata).
 * Preserved: content, model, stopReason, richContent, usage.
 */
function normalizeChunk(chunk: ModelChunk): ModelChunk {
  if (chunk.kind !== "done") return chunk;
  // Strip volatile fields that change on every recording run.
  // Destructure to exclude them rather than delete (readonly type).
  const {
    responseId: _rid,
    metadata: _meta,
    ...stableResponse
  } = chunk.response as ModelResponse & {
    responseId?: unknown;
    metadata?: unknown;
  };
  return { kind: "done", response: stableResponse as ModelResponse };
}

/**
 * Handle returned by createCassetteRecorder.
 *
 * - adapter: drop-in replacement for any EngineAdapter; records chunks as it streams.
 * - flush(): returns the recorded Cassette (call after streaming completes).
 */
export interface CassetteRecorderHandle {
  readonly adapter: EngineAdapter;
  readonly flush: (name: string, model: string) => Cassette;
}

/**
 * Wraps an EngineAdapter to record its ModelChunk output.
 *
 * Usage:
 *   const { adapter, flush } = createCassetteRecorder(liveAdapter);
 *   await runTurn({ adapter, ... }); // live run recorded transparently
 *   const cassette = flush("my-query", "google/gemini-2.0-flash-001");
 *   await Bun.write("fixtures/my-query.cassette.json", JSON.stringify(cassette, null, 2));
 *   loadCassette("fixtures/my-query.cassette.json"); // self-verify
 */
export function createCassetteRecorder(wrapped: EngineAdapter): CassetteRecorderHandle {
  const recorded: ModelChunk[] = [];

  const adapter: EngineAdapter = {
    engineId: wrapped.engineId,
    capabilities: wrapped.capabilities as EngineCapabilities,
    stream(input: EngineInput): AsyncIterable<EngineEvent> {
      return recordStream(wrapped.stream(input), recorded);
    },
  };

  return {
    adapter,
    flush(name: string, model: string): Cassette {
      return {
        schemaVersion: CASSETTE_SCHEMA_VERSION,
        name,
        model,
        recordedAt: Date.now(),
        chunks: recorded.map(normalizeChunk),
      };
    },
  };
}

async function* recordStream(
  source: AsyncIterable<EngineEvent>,
  recorded: ModelChunk[],
): AsyncIterable<EngineEvent> {
  for await (const event of source) {
    // Map EngineEvents back to ModelChunks for recording.
    // Only record the chunk-level events that cassettes store.
    const chunk = engineEventToModelChunk(event);
    if (chunk !== null) recorded.push(chunk);
    yield event;
  }
}

/**
 * Converts a subset of EngineEvents back to ModelChunks for cassette recording.
 * Events with no ModelChunk equivalent (tool_result, turn_start, etc.) return null.
 */
function engineEventToModelChunk(event: EngineEvent): ModelChunk | null {
  switch (event.kind) {
    case "text_delta":
      return { kind: "text_delta", delta: event.delta };
    case "thinking_delta":
      return { kind: "thinking_delta", delta: event.delta };
    case "tool_call_delta":
      return { kind: "tool_call_delta", callId: event.callId, delta: event.delta };
    case "tool_call_end":
      // tool_call_end EngineEvent carries an AccumulatedToolCall in `result`.
      // We don't record it — the cassette replays tool_call_start + deltas + end.
      return { kind: "tool_call_end", callId: event.callId };
    case "custom":
      if (event.type === "usage") {
        const d = event.data as { inputTokens: number; outputTokens: number };
        return { kind: "usage", inputTokens: d.inputTokens, outputTokens: d.outputTokens };
      }
      return null;
    default:
      return null;
  }
}
