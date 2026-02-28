/**
 * E2E tests for Change 3: Copilot routing in the task tool.
 *
 * Validates:
 * - Routes to live copilot when findLive returns an AgentId
 * - Falls through to spawn when findLive returns undefined
 * - Falls through to spawn when message fn is absent
 *
 * Gated on E2E_TESTS=1 + ANTHROPIC_API_KEY.
 *
 * Run:
 *   E2E_TESTS=1 bun test src/__tests__/e2e-copilot.test.ts
 */

import { describe, expect, test } from "bun:test";
import type { SubsystemToken } from "@koi/core";
import type { Tool } from "@koi/core/ecs";
import { agentId } from "@koi/core/ecs";
import { createKoi } from "@koi/engine";
import { createLoopAdapter } from "@koi/engine-loop";
import { createTaskSpawnProvider } from "../provider.js";
import type {
  AgentResolver,
  MessageFn,
  TaskSpawnConfig,
  TaskSpawnRequest,
  TaskSpawnResult,
} from "../types.js";
import {
  COPILOT_MANIFEST,
  E2E_GATE,
  MODEL,
  modelCall,
  realSpawn,
  requireTool,
  TIMEOUT_MS,
  WORKER_MANIFEST,
} from "./e2e-helpers.js";

const describeE2E = E2E_GATE ? describe : describe.skip;

describeE2E("Change 3: Copilot routing through full L1 runtime", () => {
  test(
    "routes to live copilot when findLive returns an AgentId",
    async () => {
      const liveAgentId = agentId("copilot-live-001");
      // let: track whether message was called
      let messageCalled = false;
      // let: track the received request
      let receivedAgentId: string | undefined;
      // let: track the received description
      let receivedDescription: string | undefined;

      const messageFn: MessageFn = async (request) => {
        messageCalled = true;
        receivedAgentId = request.agentId;
        receivedDescription = request.description;
        return { ok: true, output: "COPILOT_RESPONSE: handled by live agent" };
      };

      const resolver: AgentResolver = {
        resolve(agentType) {
          if (agentType === "assistant") {
            return {
              name: "assistant-copilot",
              description: "A live copilot",
              manifest: COPILOT_MANIFEST,
            };
          }
          return undefined;
        },
        list() {
          return [
            {
              key: "assistant",
              name: "assistant-copilot",
              description: "A live copilot",
            },
          ];
        },
        findLive(agentType) {
          if (agentType === "assistant") return liveAgentId;
          return undefined;
        },
      };

      const config: TaskSpawnConfig = {
        agentResolver: resolver,
        spawn: realSpawn,
        message: messageFn,
        defaultAgent: "assistant",
        maxDurationMs: 60_000,
      };

      const provider = createTaskSpawnProvider(config);
      const adapter = createLoopAdapter({ modelCall, maxTurns: 1 });

      const runtime = await createKoi({
        manifest: {
          name: "parent-copilot-route",
          version: "0.0.1",
          model: { name: MODEL },
        },
        adapter,
        providers: [provider],
        loopDetection: false,
        limits: { maxTurns: 1, maxDurationMs: 60_000, maxTokens: 50_000 },
      });

      try {
        const taskTool = requireTool(
          runtime.agent.component<Tool>("tool:task" as SubsystemToken<Tool>),
          "task",
        );

        const result = await taskTool.execute({
          description: "Help me with this task",
          agent_type: "assistant",
        });

        expect(messageCalled).toBe(true);
        expect(receivedAgentId).toBe(liveAgentId);
        expect(receivedDescription).toBe("Help me with this task");
        expect(typeof result).toBe("string");
        expect(String(result)).toContain("COPILOT_RESPONSE");
      } finally {
        await runtime.dispose();
      }
    },
    TIMEOUT_MS,
  );

  test(
    "falls through to spawn when findLive returns undefined",
    async () => {
      // let: track calls
      let messageCalled = false;
      // let: track spawn calls
      let spawnCalled = false;

      const messageFn: MessageFn = async () => {
        messageCalled = true;
        return { ok: true, output: "should not happen" };
      };

      const resolver: AgentResolver = {
        resolve(agentType) {
          if (agentType === "worker") {
            return {
              name: "fallback-worker",
              description: "A worker agent",
              manifest: WORKER_MANIFEST,
            };
          }
          return undefined;
        },
        list() {
          return [
            {
              key: "worker",
              name: "fallback-worker",
              description: "A worker agent",
            },
          ];
        },
        findLive() {
          return undefined;
        },
      };

      const spawnWithTracking = async (request: TaskSpawnRequest): Promise<TaskSpawnResult> => {
        spawnCalled = true;
        return realSpawn(request);
      };

      const config: TaskSpawnConfig = {
        agentResolver: resolver,
        spawn: spawnWithTracking,
        message: messageFn,
        defaultAgent: "worker",
        maxDurationMs: 60_000,
      };

      const provider = createTaskSpawnProvider(config);
      const adapter = createLoopAdapter({ modelCall, maxTurns: 1 });

      const runtime = await createKoi({
        manifest: {
          name: "parent-copilot-fallthrough",
          version: "0.0.1",
          model: { name: MODEL },
        },
        adapter,
        providers: [provider],
        loopDetection: false,
        limits: { maxTurns: 1, maxDurationMs: 60_000, maxTokens: 50_000 },
      });

      try {
        const taskTool = requireTool(
          runtime.agent.component<Tool>("tool:task" as SubsystemToken<Tool>),
          "task",
        );

        const result = await taskTool.execute({
          description: "Reply with exactly: SPAWNED",
          agent_type: "worker",
        });

        expect(messageCalled).toBe(false);
        expect(spawnCalled).toBe(true);
        expect(typeof result).toBe("string");
        expect(String(result).toLowerCase()).toContain("spawned");
      } finally {
        await runtime.dispose();
      }
    },
    TIMEOUT_MS,
  );

  test(
    "falls through to spawn when message fn is absent",
    async () => {
      // let: track spawn calls
      let spawnCalled = false;

      const resolver: AgentResolver = {
        resolve(agentType) {
          if (agentType === "worker") {
            return {
              name: "no-message-worker",
              description: "Worker without message",
              manifest: WORKER_MANIFEST,
            };
          }
          return undefined;
        },
        list() {
          return [
            {
              key: "worker",
              name: "no-message-worker",
              description: "Worker without message",
            },
          ];
        },
        findLive() {
          return agentId("live-agent-123");
        },
      };

      const spawnWithTracking = async (request: TaskSpawnRequest): Promise<TaskSpawnResult> => {
        spawnCalled = true;
        return realSpawn(request);
      };

      const config: TaskSpawnConfig = {
        agentResolver: resolver,
        spawn: spawnWithTracking,
        defaultAgent: "worker",
        maxDurationMs: 60_000,
      };

      const provider = createTaskSpawnProvider(config);
      const adapter = createLoopAdapter({ modelCall, maxTurns: 1 });

      const runtime = await createKoi({
        manifest: {
          name: "parent-no-message",
          version: "0.0.1",
          model: { name: MODEL },
        },
        adapter,
        providers: [provider],
        loopDetection: false,
        limits: { maxTurns: 1, maxDurationMs: 60_000, maxTokens: 50_000 },
      });

      try {
        const taskTool = requireTool(
          runtime.agent.component<Tool>("tool:task" as SubsystemToken<Tool>),
          "task",
        );

        const result = await taskTool.execute({
          description: "Reply with exactly: FALLBACK",
          agent_type: "worker",
        });

        expect(spawnCalled).toBe(true);
        expect(typeof result).toBe("string");
        expect(String(result).toLowerCase()).toContain("fallback");
      } finally {
        await runtime.dispose();
      }
    },
    TIMEOUT_MS,
  );
});
