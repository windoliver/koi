/**
 * E2E regression test for #1070: multi-turn conversations with assistant
 * messages that use agentId as senderId (not literal "assistant").
 *
 * Reproduces the exact bug: conversation middleware reloads history with
 * senderId=agentId + originalRole metadata. Without the fix, assistant
 * messages are misclassified as UserMessages with string content, causing
 * pi-ai's convertMessages to crash with "flatMap is not a function".
 *
 * Run:
 *   E2E_TESTS=1 bun test src/__tests__/e2e-multi-turn-history.test.ts
 *
 * Uses OPENROUTER_API_KEY (loaded from .env) or ANTHROPIC_API_KEY.
 */

import { describe, expect, test } from "bun:test";
import type { ToolDescriptor } from "@koi/core/ecs";
import type { ComposedCallHandlers, EngineEvent, EngineOutput } from "@koi/core/engine";
import type { InboundMessage } from "@koi/core/message";
import { createPiAdapter } from "../adapter.js";
import { createModelCallTerminal, createModelStreamTerminal } from "../model-terminal.js";

// ---------------------------------------------------------------------------
// Environment gate
// ---------------------------------------------------------------------------

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY ?? "";
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY ?? "";
const HAS_KEY = ANTHROPIC_KEY.length > 0 || OPENROUTER_KEY.length > 0;
const E2E_ENABLED = HAS_KEY && process.env.E2E_TESTS === "1";
const describeE2E = E2E_ENABLED ? describe : describe.skip;

// Use OpenRouter if available, else direct Anthropic
// OpenRouter uses simplified model names (e.g., "anthropic/claude-haiku-4.5")
const MODEL =
  OPENROUTER_KEY.length > 0
    ? "openrouter:anthropic/claude-haiku-4.5"
    : "anthropic:claude-haiku-4-5-20251001";
const API_KEY = OPENROUTER_KEY.length > 0 ? OPENROUTER_KEY : ANTHROPIC_KEY;

const TIMEOUT_MS = 120_000;

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

function extractText(events: readonly EngineEvent[]): string {
  return events
    .filter((e): e is EngineEvent & { readonly kind: "text_delta" } => e.kind === "text_delta")
    .map((e) => e.delta)
    .join("");
}

function buildDirectHandlers(tools: readonly ToolDescriptor[] = []): ComposedCallHandlers {
  const modelStreamTerminal = createModelStreamTerminal();
  const modelCallTerminal = createModelCallTerminal(modelStreamTerminal);
  return {
    modelCall: modelCallTerminal,
    modelStream: modelStreamTerminal,
    toolCall: async () => ({ output: "ok" }),
    tools,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describeE2E("e2e: multi-turn history with agentId senderId (#1070)", () => {
  /**
   * Regression test for #1070.
   *
   * Simulates what the conversation middleware produces when reloading
   * history: assistant messages have senderId=agentId (e.g., "koi-demo")
   * instead of literal "assistant", with metadata.originalRole="assistant".
   *
   * Before the fix: crashes with "assistantMsg.content.flatMap is not a function"
   * After the fix: correctly detects assistant role via metadata, returns response.
   */
  test(
    "handles assistant messages with agentId senderId and originalRole metadata",
    async () => {
      const adapter = createPiAdapter({
        model: MODEL,
        systemPrompt: "You are a concise assistant. Reply in one sentence.",
        getApiKey: async (_provider) => API_KEY,
      });

      // Simulate conversation middleware history reload:
      // - User message from previous session
      // - Assistant response with senderId=agentId (not "assistant")
      // - New user message (current prompt)
      const messages: readonly InboundMessage[] = [
        {
          content: [{ kind: "text", text: "What is 2+2?" }],
          senderId: "user",
          timestamp: Date.now() - 2000,
          metadata: { fromHistory: true, originalRole: "user", agentId: "koi-demo" },
        },
        {
          content: [{ kind: "text", text: "2+2 equals 4." }],
          senderId: "koi-demo", // agentId, NOT "assistant" — this is the bug trigger
          timestamp: Date.now() - 1000,
          metadata: { fromHistory: true, originalRole: "assistant", agentId: "koi-demo" },
        },
        {
          content: [{ kind: "text", text: "And what is 3+3?" }],
          senderId: "user",
          timestamp: Date.now(),
        },
      ];

      const events = await collectEvents(
        adapter.stream({
          kind: "messages",
          messages,
          callHandlers: buildDirectHandlers(),
        }),
      );

      const output = findDoneOutput(events);
      expect(output).toBeDefined();
      expect(output?.stopReason).toBe("completed");
      expect(output?.metrics.outputTokens).toBeGreaterThan(0);

      const text = extractText(events);
      // Model should reference 6 (3+3) — proves it understood the multi-turn context
      expect(text).toContain("6");
    },
    TIMEOUT_MS,
  );

  /**
   * Same scenario but with metadata.role instead of metadata.originalRole —
   * tests the expandLabeledBlocks path from boot-runtime.
   */
  test(
    "handles assistant messages with metadata.role signal",
    async () => {
      const adapter = createPiAdapter({
        model: MODEL,
        systemPrompt: "You are a concise assistant. Reply in one sentence.",
        getApiKey: async (_provider) => API_KEY,
      });

      const messages: readonly InboundMessage[] = [
        {
          content: [{ kind: "text", text: "What color is the sky?" }],
          senderId: "chat-user",
          timestamp: Date.now() - 2000,
        },
        {
          content: [{ kind: "text", text: "The sky is blue." }],
          senderId: "my-agent",
          timestamp: Date.now() - 1000,
          metadata: { role: "assistant" }, // expandLabeledBlocks style
        },
        {
          content: [{ kind: "text", text: "And what color is grass?" }],
          senderId: "chat-user",
          timestamp: Date.now(),
        },
      ];

      const events = await collectEvents(
        adapter.stream({
          kind: "messages",
          messages,
          callHandlers: buildDirectHandlers(),
        }),
      );

      const output = findDoneOutput(events);
      expect(output).toBeDefined();
      expect(output?.stopReason).toBe("completed");

      const text = extractText(events).toLowerCase();
      expect(text).toContain("green");
    },
    TIMEOUT_MS,
  );
});
