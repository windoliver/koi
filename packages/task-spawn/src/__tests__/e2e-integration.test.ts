/**
 * E2E integration test: LLM-driven round-trip through full L1 runtime.
 *
 * Validates:
 * - task tool attached to agent via createKoi + createLoopAdapter
 * - LLM-driven round-trip where the model may choose to call the task tool
 *
 * Gated on E2E_TESTS=1 + ANTHROPIC_API_KEY.
 *
 * Run:
 *   E2E_TESTS=1 bun test src/__tests__/e2e-integration.test.ts
 */

import { describe, expect, test } from "bun:test";
import type { EngineEvent, SubsystemToken } from "@koi/core";
import type { Tool } from "@koi/core/ecs";
import { createKoi } from "@koi/engine";
import { createLoopAdapter } from "@koi/engine-loop";
import { createTaskSpawnProvider } from "../provider.js";
import type { TaskSpawnConfig } from "../types.js";
import {
  collectEvents,
  E2E_GATE,
  extractText,
  findDoneOutput,
  getSchemaProperty,
  MODEL,
  modelCall,
  realSpawn,
  requireTool,
  TIMEOUT_MS,
  WORKER_MANIFEST,
} from "./e2e-helpers.js";

const describeE2E = E2E_GATE ? describe : describe.skip;

describeE2E("LLM-driven round-trip through full L1 runtime", () => {
  test(
    "task tool attached and functional through createKoi (real LLM)",
    async () => {
      const config: TaskSpawnConfig = {
        agents: new Map([
          [
            "helper",
            {
              name: "helper-worker",
              description: "A helper that answers questions",
              manifest: WORKER_MANIFEST,
            },
          ],
        ]),
        spawn: realSpawn,
        defaultAgent: "helper",
        maxDurationMs: 60_000,
      };

      const provider = createTaskSpawnProvider(config);
      const adapter = createLoopAdapter({ modelCall, maxTurns: 1 });

      const runtime = await createKoi({
        manifest: {
          name: "parent-integration",
          version: "0.0.1",
          description: "Parent agent with task tool",
          model: { name: MODEL },
        },
        adapter,
        providers: [provider],
        loopDetection: false,
        limits: { maxTurns: 1, maxDurationMs: 60_000, maxTokens: 50_000 },
      });

      try {
        // Verify task tool is attached
        const taskTool = requireTool(
          runtime.agent.component<Tool>("tool:task" as SubsystemToken<Tool>),
          "task",
        );
        expect(taskTool.descriptor.name).toBe("task");

        // Verify dynamic enum reflects available agents
        const agentTypeProp = getSchemaProperty(taskTool.descriptor.inputSchema, "agent_type");
        expect(agentTypeProp?.enum).toEqual(["helper"]);

        // Execute task directly
        const result = await taskTool.execute({
          description: "Reply with exactly: INTEGRATED",
          agent_type: "helper",
        });

        expect(typeof result).toBe("string");
        expect(String(result).toLowerCase()).toContain("integrated");
      } finally {
        await runtime.dispose();
      }
    },
    TIMEOUT_MS,
  );

  test(
    "parent agent completes run with task tool in toolset (real LLM)",
    async () => {
      const config: TaskSpawnConfig = {
        agents: new Map([
          [
            "helper",
            {
              name: "helper-worker",
              description: "A helper that answers questions",
              manifest: WORKER_MANIFEST,
            },
          ],
        ]),
        spawn: realSpawn,
        defaultAgent: "helper",
        maxDurationMs: 60_000,
      };

      const provider = createTaskSpawnProvider(config);
      const adapter = createLoopAdapter({ modelCall, maxTurns: 3 });

      const runtime = await createKoi({
        manifest: {
          name: "parent-llm-driven",
          version: "0.0.1",
          description: "Parent agent that may use task tool",
          model: { name: MODEL },
        },
        adapter,
        providers: [provider],
        loopDetection: false,
        limits: { maxTurns: 3, maxDurationMs: 90_000, maxTokens: 100_000 },
      });

      try {
        // Ask the parent to use the task tool explicitly.
        // Note: This is an intentional smoke test — the LLM may or may not
        // decide to call the tool. Both outcomes are valid.
        const events = await collectEvents(
          runtime.run({
            kind: "text",
            text: 'You have a "task" tool available. Use it to delegate this task to the helper: "What is 7 times 8?" Then report the helper\'s answer.',
          }),
        );

        const output = findDoneOutput(events);
        expect(output).toBeDefined();
        if (output === undefined) {
          throw new Error("Expected done event in output");
        }
        expect(output.stopReason).not.toBe("error");

        const text = extractText(output);
        expect(text.length).toBeGreaterThan(0);

        // Check if tool was called
        const toolCalls = events.filter((e) => e.kind === "tool_call_start");
        if (toolCalls.length > 0) {
          const firstCall = toolCalls[0] as EngineEvent & {
            readonly kind: "tool_call_start";
            readonly toolName: string;
          };
          expect(firstCall.toolName).toBe("task");
        }
      } finally {
        await runtime.dispose();
      }
    },
    TIMEOUT_MS,
  );
});
