/**
 * Cross-layer integration test: execution context → shell tool KOI_* env vars.
 *
 * Boots a full Koi session with userId and channelId, executes the shell tool
 * to echo KOI_* vars, and verifies the output contains the expected values.
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
import { createKoi } from "@koi/engine";
import { createShellTool } from "@koi/node";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function testManifest(): AgentManifest {
  return {
    name: "Context Env Integration Agent",
    version: "0.1.0",
    model: { name: "test-model" },
  };
}

function doneOutput(): EngineOutput {
  return {
    content: [{ kind: "text", text: "done" }],
    stopReason: "completed",
    metrics: {
      totalTokens: 10,
      inputTokens: 5,
      outputTokens: 5,
      turns: 1,
      durationMs: 50,
    },
  };
}

/** Shell tool provider that registers createShellTool(). */
function shellToolProvider() {
  const tool = createShellTool();
  return {
    name: "shell-provider",
    attach: async () => new Map([[toolToken("shell") as string, tool]]),
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
// Integration test
// ---------------------------------------------------------------------------

describe("execution context → shell tool KOI_* env vars", () => {
  test("shell tool child process sees KOI_AGENT_ID, KOI_SESSION_ID, KOI_USER_ID", async () => {
    // let justified: capture tool result from adapter
    let shellOutput: ToolResponse | undefined;

    const rawModelCall = async (_req: ModelRequest): Promise<ModelResponse> => ({
      content: "ok",
      model: "test",
    });

    const adapter: EngineAdapter = {
      engineId: "context-env-adapter",
      terminals: { modelCall: rawModelCall },
      stream: (input: EngineInput) => ({
        async *[Symbol.asyncIterator]() {
          if (input.callHandlers) {
            shellOutput = await input.callHandlers.toolCall({
              toolId: "shell",
              input: { command: "echo $KOI_AGENT_ID $KOI_SESSION_ID $KOI_USER_ID" },
            });
          }
          yield { kind: "done" as const, output: doneOutput() };
        },
      }),
    };

    const runtime = await createKoi({
      manifest: testManifest(),
      adapter,
      providers: [shellToolProvider()],
      userId: "integration-user",
      channelId: "@koi/channel-test",
      loopDetection: false,
    });

    await collectEvents(runtime.run({ kind: "text", text: "test" }));

    expect(shellOutput).toBeDefined();
    const output = shellOutput?.output as { stdout: string; exitCode: number };
    expect(output.exitCode).toBe(0);

    const parts = output.stdout.trim().split(" ");
    // Agent ID is a UUID — just verify it's non-empty
    expect(parts[0]?.length).toBeGreaterThan(0);
    // Session ID has format "agent:{agentId}:{uuid}"
    expect(parts[1]).toContain("agent:");
    // User ID matches what we passed
    expect(parts[2]).toBe("integration-user");
  });

  test("KOI_CHANNEL is set when channelId is provided", async () => {
    // let justified: capture tool result from adapter
    let shellOutput: ToolResponse | undefined;

    const rawModelCall = async (_req: ModelRequest): Promise<ModelResponse> => ({
      content: "ok",
      model: "test",
    });

    const adapter: EngineAdapter = {
      engineId: "context-env-channel-adapter",
      terminals: { modelCall: rawModelCall },
      stream: (input: EngineInput) => ({
        async *[Symbol.asyncIterator]() {
          if (input.callHandlers) {
            shellOutput = await input.callHandlers.toolCall({
              toolId: "shell",
              input: { command: "echo $KOI_CHANNEL" },
            });
          }
          yield { kind: "done" as const, output: doneOutput() };
        },
      }),
    };

    const runtime = await createKoi({
      manifest: testManifest(),
      adapter,
      providers: [shellToolProvider()],
      channelId: "@koi/channel-discord",
      loopDetection: false,
    });

    await collectEvents(runtime.run({ kind: "text", text: "test" }));

    expect(shellOutput).toBeDefined();
    const output = shellOutput?.output as { stdout: string; exitCode: number };
    expect(output.exitCode).toBe(0);
    expect(output.stdout.trim()).toBe("@koi/channel-discord");
  });
});
