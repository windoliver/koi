/**
 * E2E tests for Change 2: Dynamic AgentResolver + dynamic descriptor.
 *
 * Validates:
 * - Custom async AgentResolver resolves agents and builds dynamic enum
 * - createMapAgentResolver backward compat through full runtime
 * - createTaskToolDescriptor generates correct enum from summaries
 *
 * Gated on E2E_TESTS=1 + ANTHROPIC_API_KEY.
 *
 * Run:
 *   E2E_TESTS=1 bun test src/__tests__/e2e-resolver.test.ts
 */

import { describe, expect, test } from "bun:test";
import type { SubsystemToken } from "@koi/core";
import type { Tool } from "@koi/core/ecs";
import { createKoi } from "@koi/engine";
import { createLoopAdapter } from "@koi/engine-loop";
import { createTaskSpawnProvider } from "../provider.js";
import type { AgentResolver, TaskSpawnConfig } from "../types.js";
import { createMapAgentResolver, createTaskToolDescriptor } from "../types.js";
import {
  E2E_GATE,
  getSchemaProperty,
  MODEL,
  modelCall,
  realSpawn,
  requireTool,
  TIMEOUT_MS,
  WORKER_MANIFEST,
} from "./e2e-helpers.js";

const describeE2E = E2E_GATE ? describe : describe.skip;

describeE2E("Change 2: Dynamic AgentResolver through full L1 runtime", () => {
  test(
    "custom async AgentResolver resolves agents and builds dynamic enum",
    async () => {
      const resolver: AgentResolver = {
        async resolve(agentType) {
          await Promise.resolve();
          if (agentType === "researcher") {
            return {
              name: "research-worker",
              description: "Researches topics thoroughly",
              manifest: WORKER_MANIFEST,
            };
          }
          if (agentType === "summarizer") {
            return {
              name: "summary-worker",
              description: "Summarizes text concisely",
              manifest: WORKER_MANIFEST,
            };
          }
          return undefined;
        },
        async list() {
          return [
            {
              key: "researcher",
              name: "research-worker",
              description: "Researches topics thoroughly",
            },
            {
              key: "summarizer",
              name: "summary-worker",
              description: "Summarizes text concisely",
            },
          ];
        },
      };

      const config: TaskSpawnConfig = {
        agentResolver: resolver,
        spawn: realSpawn,
        defaultAgent: "researcher",
        maxDurationMs: 60_000,
      };

      const provider = createTaskSpawnProvider(config);
      const adapter = createLoopAdapter({ modelCall, maxTurns: 1 });

      const runtime = await createKoi({
        manifest: {
          name: "parent-dynamic-resolver",
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

        const agentTypeProp = getSchemaProperty(taskTool.descriptor.inputSchema, "agent_type");
        expect(agentTypeProp).toBeDefined();
        expect(agentTypeProp?.enum).toEqual(["researcher", "summarizer"]);

        const result = await taskTool.execute({
          description: "Reply with exactly: PONG",
          agent_type: "researcher",
        });

        expect(typeof result).toBe("string");
        const text = String(result);
        expect(text.toLowerCase()).toContain("pong");
      } finally {
        await runtime.dispose();
      }
    },
    TIMEOUT_MS,
  );

  test(
    "createMapAgentResolver backward compat works through full runtime",
    async () => {
      const agents = new Map([
        [
          "worker",
          {
            name: "basic-worker",
            description: "Does basic work",
            manifest: WORKER_MANIFEST,
          },
        ],
      ]);

      const resolver = createMapAgentResolver(agents);

      const config: TaskSpawnConfig = {
        agentResolver: resolver,
        spawn: realSpawn,
        defaultAgent: "worker",
        maxDurationMs: 60_000,
      };

      const provider = createTaskSpawnProvider(config);
      const adapter = createLoopAdapter({ modelCall, maxTurns: 1 });

      const runtime = await createKoi({
        manifest: {
          name: "parent-map-resolver",
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

        const agentTypeProp = getSchemaProperty(taskTool.descriptor.inputSchema, "agent_type");
        expect(agentTypeProp?.enum).toEqual(["worker"]);

        const result = await taskTool.execute({
          description: "What is 2 + 2? Reply with just the number.",
        });

        expect(typeof result).toBe("string");
        expect(String(result)).toContain("4");
      } finally {
        await runtime.dispose();
      }
    },
    TIMEOUT_MS,
  );

  test("createTaskToolDescriptor generates correct enum from summaries", () => {
    const summaries = [
      { key: "alpha", name: "Alpha Agent", description: "Does alpha things" },
      { key: "beta", name: "Beta Agent", description: "Does beta things" },
    ];

    const descriptor = createTaskToolDescriptor(summaries);

    expect(descriptor.name).toBe("task");
    const agentTypeProp = getSchemaProperty(descriptor.inputSchema, "agent_type");
    expect(agentTypeProp).toBeDefined();
    expect(agentTypeProp?.enum).toEqual(["alpha", "beta"]);
    expect(agentTypeProp?.type).toBe("string");
    expect(String(agentTypeProp?.description)).toContain("alpha: Does alpha things");
    expect(String(agentTypeProp?.description)).toContain("beta: Does beta things");
  });
});
