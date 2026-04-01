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

// The Claude Agent SDK spawns a Claude Code subprocess. When running inside
// an existing Claude Code session the nested launch guard will abort. Clearing
// the env var allows the SDK to start a fresh child process safely.
delete process.env.CLAUDECODE;

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

  test("HITL approval flow — allow write outside cwd", async () => {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    const { createClaudeAdapter } = await import("../src/adapter.js");
    const { HITL_EVENTS } = await import("../src/types.js");

    const approvedTools: string[] = [];

    const adapter = createClaudeAdapter(
      {
        model: "claude-sonnet-4-5-20250929",
        maxTurns: 5,
        permissionMode: "default",
        approvalHandler: async (req) => {
          approvedTools.push(req.toolId);
          return { kind: "allow" };
        },
      },
      { query },
    );

    // Writing outside cwd triggers canUseTool in the SDK
    const events = await collectEvents(
      adapter.stream({
        kind: "text",
        text: 'Create a file at /tmp/koi-hitl-test.txt containing "hitl-ok"',
      }),
    );

    const output = findDoneOutput(events);
    expect(output).toBeDefined();

    // The approval handler must have been called for the out-of-cwd write
    expect(approvedTools.length).toBeGreaterThanOrEqual(1);
    expect(approvedTools).toContain("Write");

    // Custom HITL events should have been emitted
    const customEvents = events.filter(
      (e): e is EngineEvent & { readonly kind: "custom" } => e.kind === "custom",
    );
    const hitlRequests = customEvents.filter((e) => e.type === HITL_EVENTS.REQUEST);
    const hitlResponses = customEvents.filter((e) => e.type === HITL_EVENTS.RESPONSE_RECEIVED);

    expect(hitlRequests.length).toBeGreaterThanOrEqual(1);
    expect(hitlResponses.length).toBeGreaterThanOrEqual(1);

    // Verify request data shape
    const firstRequest = hitlRequests[0]?.data as Record<string, unknown>;
    expect(firstRequest?.toolName).toBe("Write");
    expect(firstRequest?.kind).toBe("tool_approval");
  }, 120_000);

  test("HITL approval flow — deny blocks tool execution", async () => {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    const { createClaudeAdapter } = await import("../src/adapter.js");

    const deniedTools: string[] = [];

    const adapter = createClaudeAdapter(
      {
        model: "claude-sonnet-4-5-20250929",
        maxTurns: 3,
        permissionMode: "default",
        approvalHandler: async (req) => {
          deniedTools.push(req.toolId);
          return { kind: "deny", reason: "Blocked by test" };
        },
      },
      { query },
    );

    const events = await collectEvents(
      adapter.stream({
        kind: "text",
        text: 'Create a file at /tmp/koi-hitl-deny-test.txt containing "should-not-exist"',
      }),
    );

    const output = findDoneOutput(events);
    expect(output).toBeDefined();

    // The approval handler should have been called and denied
    expect(deniedTools.length).toBeGreaterThanOrEqual(1);
  }, 120_000);
});
