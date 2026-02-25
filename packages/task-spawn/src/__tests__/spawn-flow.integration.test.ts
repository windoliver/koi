/**
 * Integration test for @koi/task-spawn.
 *
 * Exercises the full flow: task tool → spawn callback → engine adapter → output.
 * Uses @koi/engine-loop's createLoopAdapter with a mock model call to simulate
 * a real subagent execution without requiring the full L1 spawn infrastructure.
 */

import { describe, expect, it } from "bun:test";
import type { EngineEvent, EngineOutput, ModelRequest, ModelResponse } from "@koi/core";
import type { AgentManifest } from "@koi/core/assembly";
import type { Tool } from "@koi/core/ecs";
import { createLoopAdapter } from "@koi/engine-loop";
import { createMockAgent } from "@koi/test-utils";
import { createTaskSpawnProvider } from "../provider.js";
import type { TaskSpawnConfig, TaskSpawnRequest, TaskSpawnResult } from "../types.js";

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

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const EXPECTED_OUTPUT = "The answer to your research question is 42.";

const WORKER_MANIFEST: AgentManifest = {
  name: "research-worker",
  version: "0.0.1",
  description: "A research worker for integration testing",
  model: { name: "mock-model" },
};

function createMockModelCall(): (request: ModelRequest) => Promise<ModelResponse> {
  return async (_request: ModelRequest): Promise<ModelResponse> => ({
    content: EXPECTED_OUTPUT,
    model: "mock-model",
    usage: { inputTokens: 10, outputTokens: 20 },
  });
}

/**
 * Simulates what an L3 consumer would provide as the spawn callback:
 * creates a loop adapter, runs it, and extracts output from the done event.
 */
function createTestSpawnFn(): {
  readonly spawn: (request: TaskSpawnRequest) => Promise<TaskSpawnResult>;
  readonly spawnCalls: readonly TaskSpawnRequest[];
} {
  const spawnCalls: TaskSpawnRequest[] = [];

  const spawn = async (request: TaskSpawnRequest): Promise<TaskSpawnResult> => {
    spawnCalls.push(request);

    const adapter = createLoopAdapter({
      modelCall: createMockModelCall(),
      maxTurns: 3,
    });

    try {
      const events = await collectEvents(
        adapter.stream({ kind: "text", text: request.description }),
      );
      const output = findDoneOutput(events);

      if (output === undefined) {
        return { ok: false, error: "No done event received from engine" };
      }

      const textBlocks = output.content.filter(
        (b): b is { readonly kind: "text"; readonly text: string } => b.kind === "text",
      );
      const text = textBlocks.map((b) => b.text).join("\n");

      return { ok: true, output: text };
    } finally {
      await adapter.dispose?.();
    }
  };

  return { spawn, spawnCalls };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("@koi/task-spawn integration", () => {
  it("full spawn flow: provider → task tool → engine → output", async () => {
    const { spawn, spawnCalls } = createTestSpawnFn();

    const config: TaskSpawnConfig = {
      agents: new Map([
        [
          "researcher",
          {
            name: "research-worker",
            description: "Researches topics",
            manifest: WORKER_MANIFEST,
          },
        ],
      ]),
      spawn,
      defaultAgent: "researcher",
    };

    const provider = createTaskSpawnProvider(config);
    const agent = createMockAgent();
    const components = await provider.attach(agent);
    const tool = components.get("tool:task") as Tool;

    expect(tool).toBeDefined();
    expect(tool.descriptor.name).toBe("task");

    const result = await tool.execute({
      description: "What is the meaning of life?",
    });

    expect(result).toBe(EXPECTED_OUTPUT);
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]?.description).toBe("What is the meaning of life?");
    expect(spawnCalls[0]?.agentName).toBe("research-worker");
    expect(spawnCalls[0]?.manifest).toBe(WORKER_MANIFEST);
  });

  it("handles engine failure gracefully", async () => {
    const spawn = async (_request: TaskSpawnRequest): Promise<TaskSpawnResult> => {
      return { ok: false, error: "engine adapter failed to initialize" };
    };

    const config: TaskSpawnConfig = {
      agents: new Map([
        [
          "worker",
          {
            name: "worker",
            description: "A worker",
            manifest: WORKER_MANIFEST,
          },
        ],
      ]),
      spawn,
      defaultAgent: "worker",
    };

    const provider = createTaskSpawnProvider(config);
    const agent = createMockAgent();
    const components = await provider.attach(agent);
    const tool = components.get("tool:task") as Tool;

    const result = await tool.execute({
      description: "This will fail",
    });

    expect(result).toBe("Task failed: engine adapter failed to initialize");
  });

  it("specific agent_type routes to correct manifest", async () => {
    const secondManifest: AgentManifest = {
      name: "coder",
      version: "0.0.1",
      model: { name: "code-model" },
    };

    // let justified: track which manifest was used
    let usedManifest: AgentManifest | undefined;

    const spawn = async (request: TaskSpawnRequest): Promise<TaskSpawnResult> => {
      usedManifest = request.manifest;
      return { ok: true, output: "coded" };
    };

    const config: TaskSpawnConfig = {
      agents: new Map([
        [
          "researcher",
          {
            name: "research-worker",
            description: "Researches",
            manifest: WORKER_MANIFEST,
          },
        ],
        [
          "coder",
          {
            name: "coder",
            description: "Writes code",
            manifest: secondManifest,
          },
        ],
      ]),
      spawn,
      defaultAgent: "researcher",
    };

    const provider = createTaskSpawnProvider(config);
    const agent = createMockAgent();
    const components = await provider.attach(agent);
    const tool = components.get("tool:task") as Tool;

    const result = await tool.execute({
      description: "Write a function",
      agent_type: "coder",
    });

    expect(result).toBe("coded");
    expect(usedManifest).toBe(secondManifest);
  });
});
