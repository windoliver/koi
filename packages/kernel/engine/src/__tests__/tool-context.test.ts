/**
 * Tests that tool executions within an L1 agent loop have access to
 * ToolExecutionContext via AsyncLocalStorage.
 */

import { describe, expect, test } from "bun:test";
import type {
  AgentManifest,
  EngineAdapter,
  EngineEvent,
  EngineInput,
  EngineOutput,
  ModelRequest,
  ModelResponse,
  ToolResponse,
} from "@koi/core";
import { toolToken } from "@koi/core";
import { getExecutionContext, type ToolExecutionContext } from "@koi/execution-context";
import { createKoi } from "../koi.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function testManifest(): AgentManifest {
  return {
    name: "Tool Context Test Agent",
    version: "0.1.0",
    model: { name: "test-model" },
  };
}

function doneOutput(): EngineOutput {
  return {
    content: [{ kind: "text", text: "done" }],
    stopReason: "completed",
    metrics: {
      totalTokens: 100,
      inputTokens: 60,
      outputTokens: 40,
      turns: 1,
      durationMs: 100,
    },
  };
}

/**
 * Creates a cooperating adapter that calls a tool via callHandlers.toolCall().
 * The tool execution captures the execution context for assertion.
 */
function cooperatingAdapterWithToolCall(
  toolId: string,
  onToolResult?: (result: ToolResponse) => void,
): EngineAdapter {
  const rawModelCall = async (_req: ModelRequest): Promise<ModelResponse> => ({
    content: "ok",
    model: "test",
  });

  return {
    engineId: "tool-context-adapter",
    capabilities: { text: true, images: false, files: false, audio: false },
    terminals: {
      modelCall: rawModelCall,
    },
    stream: (input: EngineInput) => ({
      async *[Symbol.asyncIterator]() {
        if (input.callHandlers) {
          const result = await input.callHandlers.toolCall({
            toolId,
            input: {},
          });
          onToolResult?.(result);
        }
        yield { kind: "done" as const, output: doneOutput() };
      },
    }),
  };
}

/** Tool that captures execution context when executed. */
function contextCapturingTool(
  name: string,
  captured: ToolExecutionContext[],
): {
  readonly provider: {
    readonly name: string;
    readonly attach: () => Promise<Map<string, unknown>>;
  };
} {
  return {
    provider: {
      name: `${name}-provider`,
      attach: async () =>
        new Map([
          [
            toolToken(name) as string,
            {
              descriptor: {
                name,
                description: `Test tool: ${name}`,
                inputSchema: {},
              },
              trustTier: "verified" as const,
              execute: async (_input: unknown) => {
                const ctx = getExecutionContext();
                if (ctx !== undefined) {
                  captured.push(ctx);
                }
                return { captured: ctx !== undefined };
              },
            },
          ],
        ]),
    },
  };
}

async function collectEvents(iter: AsyncIterable<EngineEvent>): Promise<readonly EngineEvent[]> {
  const events: EngineEvent[] = [];
  for await (const event of iter) {
    events.push(event);
  }
  return events;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("tool execution context in L1", () => {
  test("tool execution has execution context available", async () => {
    const captured: ToolExecutionContext[] = [];
    const { provider } = contextCapturingTool("ctx-tool", captured);

    const runtime = await createKoi({
      manifest: testManifest(),
      adapter: cooperatingAdapterWithToolCall("ctx-tool"),
      providers: [provider],
      loopDetection: false,
    });

    await collectEvents(runtime.run({ kind: "text", text: "test" }));

    expect(captured).toHaveLength(1);
    expect(captured[0]?.session.agentId).toBeDefined();
    expect(captured[0]?.session.sessionId).toBeDefined();
    expect(captured[0]?.session.runId).toBeDefined();
  });

  test("context contains correct agentId, sessionId, runId", async () => {
    const captured: ToolExecutionContext[] = [];
    const { provider } = contextCapturingTool("id-tool", captured);

    const runtime = await createKoi({
      manifest: testManifest(),
      adapter: cooperatingAdapterWithToolCall("id-tool"),
      providers: [provider],
      loopDetection: false,
    });

    await collectEvents(runtime.run({ kind: "text", text: "test" }));

    expect(captured).toHaveLength(1);
    const ctx = captured[0];
    // agentId matches the runtime agent
    expect(ctx?.session.agentId).toBe(runtime.agent.pid.id);
    // sessionId and runId are non-empty strings
    expect(typeof ctx?.session.sessionId).toBe("string");
    expect(ctx?.session.sessionId.length).toBeGreaterThan(0);
    expect(typeof ctx?.session.runId).toBe("string");
    expect(ctx?.session.runId.length).toBeGreaterThan(0);
  });

  test("userId is present when provided in CreateKoiOptions", async () => {
    const captured: ToolExecutionContext[] = [];
    const { provider } = contextCapturingTool("user-tool", captured);

    const runtime = await createKoi({
      manifest: testManifest(),
      adapter: cooperatingAdapterWithToolCall("user-tool"),
      providers: [provider],
      userId: "user-42",
      loopDetection: false,
    });

    await collectEvents(runtime.run({ kind: "text", text: "test" }));

    expect(captured).toHaveLength(1);
    expect(captured[0]?.session.userId).toBe("user-42");
  });

  test("userId is undefined when not provided in CreateKoiOptions", async () => {
    const captured: ToolExecutionContext[] = [];
    const { provider } = contextCapturingTool("no-user-tool", captured);

    const runtime = await createKoi({
      manifest: testManifest(),
      adapter: cooperatingAdapterWithToolCall("no-user-tool"),
      providers: [provider],
      loopDetection: false,
    });

    await collectEvents(runtime.run({ kind: "text", text: "test" }));

    expect(captured).toHaveLength(1);
    expect(captured[0]?.session.userId).toBeUndefined();
  });

  test("channelId is present when provided in CreateKoiOptions", async () => {
    const captured: ToolExecutionContext[] = [];
    const { provider } = contextCapturingTool("chan-tool", captured);

    const runtime = await createKoi({
      manifest: testManifest(),
      adapter: cooperatingAdapterWithToolCall("chan-tool"),
      providers: [provider],
      channelId: "@koi/channel-telegram",
      loopDetection: false,
    });

    await collectEvents(runtime.run({ kind: "text", text: "test" }));

    expect(captured).toHaveLength(1);
    expect(captured[0]?.session.channelId).toBe("@koi/channel-telegram");
  });

  test("turnIndex reflects current turn", async () => {
    const captured: ToolExecutionContext[] = [];
    const { provider } = contextCapturingTool("turn-tool", captured);

    // Adapter that calls tool on turn 0, then turn 1
    const rawModelCall = async (): Promise<ModelResponse> => ({
      content: "ok",
      model: "test",
    });

    const adapter: EngineAdapter = {
      engineId: "multi-turn-tool-adapter",
      capabilities: { text: true, images: false, files: false, audio: false },
      terminals: { modelCall: rawModelCall },
      stream: (input: EngineInput) => ({
        async *[Symbol.asyncIterator]() {
          if (input.callHandlers) {
            // Turn 0 tool call
            await input.callHandlers.toolCall({ toolId: "turn-tool", input: {} });
            yield { kind: "turn_end" as const, turnIndex: 0 };
            // Turn 1 tool call
            await input.callHandlers.toolCall({ toolId: "turn-tool", input: {} });
            yield { kind: "turn_end" as const, turnIndex: 1 };
          }
          yield { kind: "done" as const, output: doneOutput() };
        },
      }),
    };

    const runtime = await createKoi({
      manifest: testManifest(),
      adapter,
      providers: [provider],
      loopDetection: false,
    });

    await collectEvents(runtime.run({ kind: "text", text: "test" }));

    expect(captured).toHaveLength(2);
    expect(captured[0]?.turnIndex).toBe(0);
    expect(captured[1]?.turnIndex).toBe(1);
  });
});
