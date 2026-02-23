/**
 * Shared test helpers for Claude adapter tests.
 */
import type { EngineEvent, EngineOutput } from "@koi/core";
import type { SdkFunctions, SdkInputMessage } from "./adapter.js";
import type { SdkMessage } from "./event-map.js";

// ---------------------------------------------------------------------------
// Event collection
// ---------------------------------------------------------------------------

export async function collectEvents(
  iterable: AsyncIterable<EngineEvent>,
): Promise<readonly EngineEvent[]> {
  const events: EngineEvent[] = [];
  for await (const event of iterable) {
    events.push(event);
  }
  return events;
}

export function findDoneOutput(events: readonly EngineEvent[]): EngineOutput | undefined {
  const done = events.find((e): e is EngineEvent & { readonly kind: "done" } => e.kind === "done");
  return done?.output;
}

// ---------------------------------------------------------------------------
// Mock SDK
// ---------------------------------------------------------------------------

/**
 * Create a mock SDK that yields the given messages.
 */
export function createMockSdk(messages: readonly SdkMessage[]): SdkFunctions {
  return {
    query: async function* (_params: {
      readonly prompt: string | AsyncIterable<SdkInputMessage>;
      readonly options?: Record<string, unknown>;
    }) {
      for (const msg of messages) {
        yield msg;
      }
    },
  };
}

/**
 * Create a mock SDK that captures the prompt (queue) and options.
 */
export function createHitlMockSdk(messages: readonly SdkMessage[]): {
  readonly sdk: SdkFunctions;
  readonly getCapturedPrompt: () => string | AsyncIterable<SdkInputMessage> | undefined;
  readonly getCapturedOptions: () => Record<string, unknown> | undefined;
} {
  let capturedPrompt: string | AsyncIterable<SdkInputMessage> | undefined;
  let capturedOptions: Record<string, unknown> | undefined;

  const sdk: SdkFunctions = {
    query: async function* (params: {
      readonly prompt: string | AsyncIterable<SdkInputMessage>;
      readonly options?: Record<string, unknown>;
    }) {
      capturedPrompt = params.prompt;
      capturedOptions = params.options as Record<string, unknown> | undefined;
      for (const msg of messages) {
        yield msg;
      }
    },
  };

  return {
    sdk,
    getCapturedPrompt: () => capturedPrompt,
    getCapturedOptions: () => capturedOptions,
  };
}

// ---------------------------------------------------------------------------
// Message builders
// ---------------------------------------------------------------------------

export function initMessage(sessionId: string): SdkMessage {
  return { type: "system", subtype: "init", session_id: sessionId };
}

export function resultMessage(
  subtype: string,
  overrides?: Partial<{
    result: string;
    session_id: string;
    num_turns: number;
    duration_ms: number;
    usage: { input_tokens: number; output_tokens: number };
  }>,
): SdkMessage {
  return {
    type: "result",
    subtype,
    result: overrides?.result ?? "Done",
    session_id: overrides?.session_id ?? "sess-1",
    num_turns: overrides?.num_turns ?? 1,
    duration_ms: overrides?.duration_ms ?? 100,
    usage: overrides?.usage ?? { input_tokens: 10, output_tokens: 5 },
  };
}

export function assistantMessage(
  content: readonly {
    type: string;
    text?: string;
    id?: string;
    name?: string;
    input?: Record<string, unknown>;
  }[],
): SdkMessage {
  return {
    type: "assistant",
    message: { content },
  };
}
