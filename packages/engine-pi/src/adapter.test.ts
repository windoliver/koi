import { describe, expect, test } from "bun:test";
import type { ComposedCallHandlers, EngineEvent, EngineInput } from "@koi/core/engine";
import type {
  ModelChunk,
  ModelRequest,
  ModelResponse,
  ToolRequest,
  ToolResponse,
} from "@koi/core/middleware";
import { createPiAdapter } from "./adapter.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create mock callHandlers that simulate L1's composed middleware chain.
 * modelStream yields simple text + done, toolCall returns a mock result.
 */
function createMockCallHandlers(opts?: {
  readonly modelStreamChunks?: readonly ModelChunk[];
  readonly toolCallResult?: ToolResponse;
}): ComposedCallHandlers {
  const chunks: readonly ModelChunk[] = opts?.modelStreamChunks ?? [
    { kind: "text_delta", delta: "Hello from pi!" },
    { kind: "usage", inputTokens: 10, outputTokens: 5 },
    {
      kind: "done",
      response: {
        content: "Hello from pi!",
        model: "test",
        usage: { inputTokens: 10, outputTokens: 5 },
      },
    },
  ];

  return {
    modelCall: async (_request: ModelRequest): Promise<ModelResponse> => {
      return {
        content: "Hello from pi!",
        model: "test",
        usage: { inputTokens: 10, outputTokens: 5 },
      };
    },
    modelStream: async function* (_request: ModelRequest): AsyncIterable<ModelChunk> {
      for (const chunk of chunks) {
        yield chunk;
      }
    },
    toolCall: async (_request: ToolRequest): Promise<ToolResponse> => {
      return opts?.toolCallResult ?? { output: "tool result" };
    },
  };
}

function _makeTextInput(text: string, handlers?: ComposedCallHandlers): EngineInput {
  return {
    kind: "text",
    text,
    callHandlers: handlers ?? createMockCallHandlers(),
  };
}

async function _collectEvents(
  iterable: AsyncIterable<EngineEvent>,
): Promise<readonly EngineEvent[]> {
  const events: EngineEvent[] = [];
  for await (const event of iterable) {
    events.push(event);
  }
  return events;
}

// ---------------------------------------------------------------------------
// createPiAdapter — config parsing
// ---------------------------------------------------------------------------

describe("createPiAdapter", () => {
  test("throws on invalid model string format", () => {
    expect(() => createPiAdapter({ model: "invalid-no-colon" })).toThrow(
      'Invalid model string "invalid-no-colon"',
    );
  });

  test("creates adapter with valid config", () => {
    const adapter = createPiAdapter({
      model: "anthropic:claude-sonnet-4-5-20250929",
      systemPrompt: "You are helpful.",
    });

    expect(adapter.engineId).toBe("pi-agent-core");
    expect(adapter.terminals).toBeDefined();
    expect(adapter.terminals?.modelCall).toBeDefined();
    expect(adapter.terminals?.modelStream).toBeDefined();
    expect(typeof adapter.stream).toBe("function");
    expect(typeof adapter.steer).toBe("function");
    expect(typeof adapter.followUp).toBe("function");
    expect(typeof adapter.abort).toBe("function");
    expect(typeof adapter.dispose).toBe("function");
  });

  test("throws when stream() called without callHandlers", () => {
    const adapter = createPiAdapter({ model: "anthropic:claude-sonnet-4-5-20250929" });
    const input: EngineInput = { kind: "text", text: "hello" };

    expect(() => adapter.stream(input)).toThrow("requires callHandlers");
  });

  test("throws when callHandlers lacks modelStream", () => {
    const adapter = createPiAdapter({ model: "anthropic:claude-sonnet-4-5-20250929" });
    const input: EngineInput = {
      kind: "text",
      text: "hello",
      callHandlers: {
        modelCall: async () => ({ content: "", model: "m" }),
        toolCall: async () => ({ output: "ok" }),
      },
    };

    expect(() => adapter.stream(input)).toThrow("requires callHandlers.modelStream");
  });
});

// ---------------------------------------------------------------------------
// steer / followUp / abort — no-op when no active agent
// ---------------------------------------------------------------------------

describe("PiEngineAdapter lifecycle controls", () => {
  test("steer does not throw when no active agent", () => {
    const adapter = createPiAdapter({ model: "anthropic:claude-sonnet-4-5-20250929" });
    expect(() => adapter.steer("redirect")).not.toThrow();
  });

  test("followUp does not throw when no active agent", () => {
    const adapter = createPiAdapter({ model: "anthropic:claude-sonnet-4-5-20250929" });
    expect(() => adapter.followUp("continue")).not.toThrow();
  });

  test("abort does not throw when no active agent", () => {
    const adapter = createPiAdapter({ model: "anthropic:claude-sonnet-4-5-20250929" });
    expect(() => adapter.abort()).not.toThrow();
  });

  test("dispose cleans up", async () => {
    const adapter = createPiAdapter({ model: "anthropic:claude-sonnet-4-5-20250929" });
    await expect(adapter.dispose?.()).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Configuration options
// ---------------------------------------------------------------------------

describe("PiAdapterConfig options", () => {
  test("accepts systemPrompt", () => {
    const adapter = createPiAdapter({
      model: "anthropic:claude-sonnet-4-5-20250929",
      systemPrompt: "Custom system prompt",
    });
    expect(adapter.engineId).toBe("pi-agent-core");
  });

  test("accepts thinkingLevel", () => {
    const adapter = createPiAdapter({
      model: "anthropic:claude-sonnet-4-5-20250929",
      thinkingLevel: "high",
    });
    expect(adapter.engineId).toBe("pi-agent-core");
  });

  test("accepts steeringMode", () => {
    const adapter = createPiAdapter({
      model: "anthropic:claude-sonnet-4-5-20250929",
      steeringMode: "one-at-a-time",
    });
    expect(adapter.engineId).toBe("pi-agent-core");
  });

  test("accepts getApiKey", () => {
    const adapter = createPiAdapter({
      model: "anthropic:claude-sonnet-4-5-20250929",
      getApiKey: async (provider) => `key-for-${provider}`,
    });
    expect(adapter.engineId).toBe("pi-agent-core");
  });

  test("accepts transformContext", () => {
    const adapter = createPiAdapter({
      model: "anthropic:claude-sonnet-4-5-20250929",
      transformContext: async (messages) => messages,
    });
    expect(adapter.engineId).toBe("pi-agent-core");
  });
});

// ---------------------------------------------------------------------------
// parseModelString edge cases
// ---------------------------------------------------------------------------

describe("model string parsing", () => {
  test("handles model id with colons", () => {
    // e.g., "openai:gpt-4:latest" — should split on first colon only
    const adapter = createPiAdapter({ model: "anthropic:claude-sonnet-4-5-20250929" });
    expect(adapter.engineId).toBe("pi-agent-core");
  });
});
