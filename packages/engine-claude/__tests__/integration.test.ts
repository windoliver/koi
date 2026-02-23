/**
 * Integration tests for @koi/engine-claude.
 *
 * These tests require a real Claude Agent SDK and API key.
 * They are gated behind the KOI_CLAUDE_INTEGRATION environment variable.
 *
 * Usage:
 *   KOI_CLAUDE_INTEGRATION=true ANTHROPIC_API_KEY=sk-... bun test packages/engine-claude/__tests__/integration.test.ts
 */

import { describe, expect, test } from "bun:test";
import type { EngineEvent, EngineOutput } from "@koi/core";

const INTEGRATION_ENABLED = process.env.KOI_CLAUDE_INTEGRATION === "true";

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

describe.skipIf(!INTEGRATION_ENABLED)("@koi/engine-claude integration", () => {
  test("real SDK query with simple prompt", async () => {
    // Dynamic import to avoid failures when SDK is not fully configured
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    const { createClaudeAdapter } = await import("../src/adapter.js");

    const adapter = createClaudeAdapter(
      {
        model: "claude-sonnet-4-5-20250929",
        maxTurns: 1,
        permissionMode: "bypassPermissions",
      },
      { query },
    );

    const events = await collectEvents(
      adapter.stream({ kind: "text", text: "Reply with exactly: Hello Koi" }),
    );

    const output = findDoneOutput(events);
    expect(output).toBeDefined();
    expect(output?.stopReason).toBe("completed");
    expect(output?.metrics.inputTokens).toBeGreaterThan(0);
    expect(output?.metrics.outputTokens).toBeGreaterThan(0);
  }, 60_000);

  test("session resume works", async () => {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    const { createClaudeAdapter } = await import("../src/adapter.js");

    const adapter = createClaudeAdapter(
      {
        model: "claude-sonnet-4-5-20250929",
        maxTurns: 1,
        permissionMode: "bypassPermissions",
      },
      { query },
    );

    // First query
    await collectEvents(adapter.stream({ kind: "text", text: "Remember the word: pineapple" }));

    const state = await adapter.saveState?.();
    expect(state).toBeDefined();
    if (state === undefined) return;

    // Resume
    const events2 = await collectEvents(
      adapter.stream({
        kind: "resume",
        state,
      }),
    );

    const output = findDoneOutput(events2);
    expect(output).toBeDefined();
  }, 120_000);

  test("metrics populated from real API response", async () => {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    const { createClaudeAdapter } = await import("../src/adapter.js");

    const adapter = createClaudeAdapter(
      {
        model: "claude-sonnet-4-5-20250929",
        maxTurns: 1,
        permissionMode: "bypassPermissions",
      },
      { query },
    );

    const events = await collectEvents(adapter.stream({ kind: "text", text: "Say hello" }));

    const output = findDoneOutput(events);
    expect(output).toBeDefined();
    expect(output?.metrics.totalTokens).toBeGreaterThan(0);
    expect(output?.metrics.durationMs).toBeGreaterThan(0);
    expect(output?.metrics.turns).toBeGreaterThanOrEqual(1);
  }, 60_000);
});
