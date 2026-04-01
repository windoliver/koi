/**
 * E2E: Context environment variables through full createKoi + createLoopAdapter.
 *
 * Validates that KOI_* environment variables are correctly injected into
 * shell tool child processes when running through the full L1 runtime assembly
 * with real LLM calls.
 *
 * Uses a two-phase model handler:
 *   Phase 1: deterministic tool call (forces shell to echo KOI_* vars)
 *   Phase 2: real Anthropic LLM generates a final response
 *
 * Gated on ANTHROPIC_API_KEY — tests are skipped when the key is not set.
 *
 * Run:
 *   bun test tests/e2e/context-env.e2e.test.ts
 *
 * Cost: ~$0.01-0.02 per run (haiku model, minimal prompts).
 */

import { describe, expect, test } from "bun:test";
import type {
  ComponentProvider,
  EngineEvent,
  KoiMiddleware,
  ModelRequest,
  ModelResponse,
  ToolHandler,
  ToolRequest,
  ToolResponse,
} from "@koi/core";
import { toolToken } from "@koi/core/ecs";
import { createKoi } from "@koi/engine";
import { createShellTool } from "@koi/node";

// ---------------------------------------------------------------------------
// Environment gate
// ---------------------------------------------------------------------------

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY ?? "";
const HAS_KEY = ANTHROPIC_KEY.length > 0;
const describeE2E = HAS_KEY ? describe : describe.skip;

const TIMEOUT_MS = 60_000;
const MODEL_NAME = "claude-haiku-4-5-20251001";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function collectEvents(
  iterable: AsyncIterable<EngineEvent>,
): Promise<readonly EngineEvent[]> {
  const result: EngineEvent[] = []; // let justified: test accumulator
  for await (const event of iterable) {
    result.push(event);
  }
  return result;
}

// ---------------------------------------------------------------------------
// 1. Shell tool receives KOI_* env vars through full createKoi + loop adapter
// ---------------------------------------------------------------------------

describeE2E("e2e: context env vars through createKoi + createLoopAdapter", () => {
  test(
    "shell tool child process sees KOI_AGENT_ID, KOI_SESSION_ID, KOI_USER_ID, KOI_CHANNEL via real runtime",
    async () => {
      let shellToolResult: ToolResponse | undefined; // let justified: captures tool result for assertion
      let modelCallCount = 0; // let justified: tracks model call phases

      // Shell tool registered on the agent entity
      const shellTool = createShellTool();
      const toolProvider: ComponentProvider = {
        name: "e2e-shell-provider",
        attach: async () => {
          const components = new Map<string, unknown>();
          components.set(toolToken("shell"), shellTool);
          return components;
        },
      };

      // wrapToolCall middleware observer — captures the tool response
      const toolObserver: KoiMiddleware = {
        name: "e2e-context-env-observer",
        wrapToolCall: async (
          _ctx,
          request: ToolRequest,
          next: ToolHandler,
        ): Promise<ToolResponse> => {
          const result = await next(request);
          if (request.toolId === "shell") {
            shellToolResult = result;
          }
          return result;
        },
      };

      // Two-phase model handler:
      // Call 1: deterministic — force shell tool call to echo KOI_* env vars
      // Call 2: real Anthropic LLM generates final response
      const modelCall = async (request: ModelRequest): Promise<ModelResponse> => {
        modelCallCount++;
        if (modelCallCount === 1) {
          // Phase 1: force a shell tool call deterministically
          return {
            content: "Let me check the environment variables.",
            model: MODEL_NAME,
            usage: { inputTokens: 10, outputTokens: 15 },
            metadata: {
              toolCalls: [
                {
                  toolName: "shell",
                  callId: "call-env-1",
                  input: {
                    command:
                      "echo KOI_AGENT_ID=$KOI_AGENT_ID KOI_SESSION_ID=$KOI_SESSION_ID KOI_RUN_ID=$KOI_RUN_ID KOI_USER_ID=$KOI_USER_ID KOI_CHANNEL=$KOI_CHANNEL KOI_TURN_INDEX=$KOI_TURN_INDEX",
                  },
                },
              ],
            },
          };
        }
        // Phase 2: real LLM call — model sees the tool result in context
        const { createAnthropicAdapter } = await import("@koi/model-router");
        const anthropic = createAnthropicAdapter({ apiKey: ANTHROPIC_KEY });
        return anthropic.complete({ ...request, model: MODEL_NAME, maxTokens: 100 });
      };

      const { createLoopAdapter } = await import("@koi/engine-loop");
      const adapter = createLoopAdapter({ modelCall, maxTurns: 5 });

      const runtime = await createKoi({
        manifest: {
          name: "e2e-context-env-agent",
          version: "0.0.1",
          model: { name: MODEL_NAME },
        },
        adapter,
        middleware: [toolObserver],
        providers: [toolProvider],
        userId: "e2e-user-42",
        channelId: "@koi/channel-test",
      });

      try {
        const events = await collectEvents(
          runtime.run({ kind: "text", text: "Show me the KOI environment variables." }),
        );

        // Agent completed successfully
        const doneEvent = events.find((e) => e.kind === "done");
        expect(doneEvent).toBeDefined();
        if (doneEvent?.kind === "done") {
          expect(doneEvent.output.stopReason).toBe("completed");
        }

        // Shell tool was executed and returned output
        expect(shellToolResult).toBeDefined();
        const output = shellToolResult?.output as { stdout: string; exitCode: number };
        expect(output.exitCode).toBe(0);

        const stdout = output.stdout.trim();

        // KOI_AGENT_ID is the runtime agent ID (UUID format)
        expect(stdout).toContain("KOI_AGENT_ID=");
        // Extract the agent ID value — should match the runtime agent
        const agentIdMatch = /KOI_AGENT_ID=(\S+)/.exec(stdout);
        expect(agentIdMatch?.[1]).toBe(runtime.agent.pid.id);

        // KOI_SESSION_ID contains the agent prefix
        expect(stdout).toContain("KOI_SESSION_ID=");
        const sessionIdMatch = /KOI_SESSION_ID=(\S+)/.exec(stdout);
        expect(sessionIdMatch?.[1]).toContain("agent:");

        // KOI_RUN_ID is non-empty
        expect(stdout).toContain("KOI_RUN_ID=");
        const runIdMatch = /KOI_RUN_ID=(\S+)/.exec(stdout);
        expect(runIdMatch?.[1]?.length).toBeGreaterThan(0);

        // KOI_USER_ID matches what we passed in CreateKoiOptions
        expect(stdout).toContain("KOI_USER_ID=e2e-user-42");

        // KOI_CHANNEL matches what we passed in CreateKoiOptions
        expect(stdout).toContain("KOI_CHANNEL=@koi/channel-test");

        // KOI_TURN_INDEX is 0 (first turn)
        expect(stdout).toContain("KOI_TURN_INDEX=0");

        // Real LLM was called for the final response (phase 2)
        expect(modelCallCount).toBeGreaterThanOrEqual(2);
      } finally {
        await runtime.dispose?.();
      }
    },
    TIMEOUT_MS,
  );

  test(
    "KOI_USER_ID and KOI_CHANNEL are absent when not provided in CreateKoiOptions",
    async () => {
      let shellToolResult: ToolResponse | undefined; // let justified: captures tool result for assertion
      let modelCallCount = 0; // let justified: tracks model call phases

      const shellTool = createShellTool();
      const toolProvider: ComponentProvider = {
        name: "e2e-shell-no-user-provider",
        attach: async () => {
          const components = new Map<string, unknown>();
          components.set(toolToken("shell"), shellTool);
          return components;
        },
      };

      const toolObserver: KoiMiddleware = {
        name: "e2e-context-env-no-user-observer",
        wrapToolCall: async (
          _ctx,
          request: ToolRequest,
          next: ToolHandler,
        ): Promise<ToolResponse> => {
          const result = await next(request);
          if (request.toolId === "shell") {
            shellToolResult = result;
          }
          return result;
        },
      };

      const modelCall = async (request: ModelRequest): Promise<ModelResponse> => {
        modelCallCount++;
        if (modelCallCount === 1) {
          return {
            content: "Checking env vars.",
            model: MODEL_NAME,
            usage: { inputTokens: 10, outputTokens: 15 },
            metadata: {
              toolCalls: [
                {
                  toolName: "shell",
                  callId: "call-env-2",
                  input: { command: "env | grep KOI_ || true" },
                },
              ],
            },
          };
        }
        const { createAnthropicAdapter } = await import("@koi/model-router");
        const anthropic = createAnthropicAdapter({ apiKey: ANTHROPIC_KEY });
        return anthropic.complete({ ...request, model: MODEL_NAME, maxTokens: 100 });
      };

      const { createLoopAdapter } = await import("@koi/engine-loop");
      const adapter = createLoopAdapter({ modelCall, maxTurns: 5 });

      // No userId or channelId provided
      const runtime = await createKoi({
        manifest: {
          name: "e2e-context-env-no-user",
          version: "0.0.1",
          model: { name: MODEL_NAME },
        },
        adapter,
        middleware: [toolObserver],
        providers: [toolProvider],
      });

      try {
        const events = await collectEvents(
          runtime.run({ kind: "text", text: "Check environment" }),
        );

        const doneEvent = events.find((e) => e.kind === "done");
        expect(doneEvent).toBeDefined();

        expect(shellToolResult).toBeDefined();
        const output = shellToolResult?.output as { stdout: string; exitCode: number };
        expect(output.exitCode).toBe(0);

        const stdout = output.stdout;

        // Core KOI_* vars should still be present
        expect(stdout).toContain("KOI_AGENT_ID=");
        expect(stdout).toContain("KOI_SESSION_ID=");
        expect(stdout).toContain("KOI_RUN_ID=");
        expect(stdout).toContain("KOI_TURN_INDEX=");

        // KOI_USER_ID and KOI_CHANNEL should NOT be present
        expect(stdout).not.toContain("KOI_USER_ID=");
        expect(stdout).not.toContain("KOI_CHANNEL=");
      } finally {
        await runtime.dispose?.();
      }
    },
    TIMEOUT_MS,
  );
});
