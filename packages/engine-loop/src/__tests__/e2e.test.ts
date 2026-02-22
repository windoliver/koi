/**
 * End-to-end tests for @koi/engine-loop with real LLM API calls.
 *
 * Gated on the OPENROUTER_API_KEY environment variable — tests are skipped
 * when the key is not set.
 *
 * Run:
 *   OPENROUTER_API_KEY=... bun test src/__tests__/e2e.test.ts
 */

import { describe, expect, test } from "bun:test";
import type { EngineEvent, EngineOutput, ModelRequest } from "@koi/core";
import { createOpenRouterAdapter } from "@koi/model-router";
import { createLoopAdapter } from "../loop-adapter.js";

// ---------------------------------------------------------------------------
// Environment gate
// ---------------------------------------------------------------------------

const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY ?? "";
const HAS_KEY = OPENROUTER_KEY.length > 0;
const describeE2E = HAS_KEY ? describe : describe.skip;

const TIMEOUT_MS = 60_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function collectEvents(
  iterable: AsyncIterable<EngineEvent>,
): Promise<readonly EngineEvent[]> {
  const events: EngineEvent[] = [];
  for await (const event of iterable) {
    events.push(event);
  }
  return events;
}

function findDoneOutput(events: readonly EngineEvent[]): EngineOutput | undefined {
  const done = events.find((e): e is EngineEvent & { readonly kind: "done" } => e.kind === "done");
  return done?.output;
}

function extractTextFromEvents(events: readonly EngineEvent[]): string {
  return events
    .filter((e): e is EngineEvent & { readonly kind: "text_delta" } => e.kind === "text_delta")
    .map((e) => e.delta)
    .join("");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describeE2E("e2e: engine-loop with OpenRouter", () => {
  const openRouterAdapter = createOpenRouterAdapter({
    apiKey: OPENROUTER_KEY,
    appName: "koi-engine-loop-e2e",
  });

  // Use ProviderAdapter.complete as the ModelHandler — signatures match exactly:
  // ModelHandler = (request: ModelRequest) => Promise<ModelResponse>
  // ProviderAdapter.complete = (request: ModelRequest) => Promise<ModelResponse>
  const modelCall = (request: ModelRequest) =>
    openRouterAdapter.complete({ ...request, model: "openai/gpt-4o-mini" });

  test(
    "single-turn text response through the ReAct loop",
    async () => {
      const adapter = createLoopAdapter({ modelCall, maxTurns: 3 });

      const events = await collectEvents(
        adapter.stream({ kind: "text", text: "Reply with exactly one word: hello" }),
      );

      const output = findDoneOutput(events);
      expect(output).toBeDefined();
      if (output === undefined) return;

      // Should complete (not max_turns — no tool calls)
      expect(output.stopReason).toBe("completed");

      // Should have consumed some tokens
      expect(output.metrics.inputTokens).toBeGreaterThan(0);
      expect(output.metrics.outputTokens).toBeGreaterThan(0);
      expect(output.metrics.totalTokens).toBeGreaterThan(0);

      // Should have exactly 1 turn (no tool calls)
      expect(output.metrics.turns).toBe(1);
      expect(output.metrics.durationMs).toBeGreaterThan(0);

      // Text content should be non-empty
      const text = extractTextFromEvents(events);
      expect(text.length).toBeGreaterThan(0);

      // The model should respond with something containing "hello"
      expect(text.toLowerCase()).toContain("hello");
    },
    TIMEOUT_MS,
  );

  test(
    "text response content appears in final output content blocks",
    async () => {
      const adapter = createLoopAdapter({ modelCall, maxTurns: 3 });

      const events = await collectEvents(
        adapter.stream({ kind: "text", text: "What is 1 + 1? Reply with just the number." }),
      );

      const output = findDoneOutput(events);
      expect(output).toBeDefined();
      if (output === undefined) return;

      // Content blocks should be populated
      expect(output.content.length).toBeGreaterThan(0);

      const firstBlock = output.content[0];
      expect(firstBlock).toBeDefined();
      if (firstBlock !== undefined && firstBlock.kind === "text") {
        expect(firstBlock.text).toContain("2");
      }
    },
    TIMEOUT_MS,
  );

  test(
    "messages input kind works with real model",
    async () => {
      const adapter = createLoopAdapter({ modelCall, maxTurns: 3 });

      const events = await collectEvents(
        adapter.stream({
          kind: "messages",
          messages: [
            {
              content: [{ kind: "text" as const, text: "Say the word 'banana' and nothing else." }],
              senderId: "e2e-user",
              timestamp: Date.now(),
            },
          ],
        }),
      );

      const output = findDoneOutput(events);
      expect(output).toBeDefined();
      expect(output?.stopReason).toBe("completed");

      const text = extractTextFromEvents(events);
      expect(text.toLowerCase()).toContain("banana");
    },
    TIMEOUT_MS,
  );

  test(
    "turn_end events are emitted correctly",
    async () => {
      const adapter = createLoopAdapter({ modelCall, maxTurns: 3 });

      const events = await collectEvents(adapter.stream({ kind: "text", text: "Reply with: OK" }));

      const turnEnds = events.filter(
        (e): e is EngineEvent & { readonly kind: "turn_end" } => e.kind === "turn_end",
      );
      expect(turnEnds.length).toBe(1);
      expect(turnEnds[0]?.turnIndex).toBe(0);
    },
    TIMEOUT_MS,
  );

  test(
    "saveState persists conversation after a real run",
    async () => {
      const adapter = createLoopAdapter({ modelCall, maxTurns: 3 });

      await collectEvents(
        adapter.stream({ kind: "text", text: "Remember: the magic word is 'pineapple'." }),
      );

      const state = await adapter.saveState?.();
      expect(state).toBeDefined();
      expect(state?.engineId).toBe("koi-loop");

      // State should contain at least the user message + assistant response
      if (state !== undefined && typeof state.data === "object" && state.data !== null) {
        const data = state.data as Record<string, unknown>;
        expect(Array.isArray(data.messages)).toBe(true);
        if (Array.isArray(data.messages)) {
          expect(data.messages.length).toBeGreaterThanOrEqual(2);
        }
      }
    },
    TIMEOUT_MS,
  );

  test(
    "dispose prevents further runs",
    async () => {
      const adapter = createLoopAdapter({ modelCall, maxTurns: 3 });

      await adapter.dispose?.();

      // After dispose, stream should yield an interrupted result without making API calls
      const events = await collectEvents(
        adapter.stream({ kind: "text", text: "This should not hit the API" }),
      );

      const output = findDoneOutput(events);
      expect(output).toBeDefined();
      expect(output?.stopReason).toBe("interrupted");

      // No API call — no tokens consumed
      expect(output?.metrics.inputTokens).toBe(0);
      expect(output?.metrics.outputTokens).toBe(0);
    },
    TIMEOUT_MS,
  );
});
