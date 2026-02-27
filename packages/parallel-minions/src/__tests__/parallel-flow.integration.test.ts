/**
 * Integration test for @koi/parallel-minions.
 *
 * Exercises the full flow: parallel_task tool → spawn callback → engine adapter → output.
 * Uses @koi/engine-loop's createLoopAdapter with a mock model call to simulate
 * real subagent execution without requiring the full L1 spawn infrastructure.
 */

import { describe, expect, it } from "bun:test";
import type { EngineEvent, EngineOutput, ModelRequest, ModelResponse } from "@koi/core";
import type { AgentManifest } from "@koi/core/assembly";
import type { AttachResult, Tool } from "@koi/core/ecs";
import { isAttachResult } from "@koi/core/ecs";
import { createLoopAdapter } from "@koi/engine-loop";
import { createMockAgent } from "@koi/test-utils";
import { createParallelMinionsProvider } from "../provider.js";
import type { MinionSpawnRequest, MinionSpawnResult, ParallelMinionsConfig } from "../types.js";

function extractMap(
  result: AttachResult | ReadonlyMap<string, unknown>,
): ReadonlyMap<string, unknown> {
  return isAttachResult(result) ? result.components : result;
}

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

const WORKER_MANIFEST: AgentManifest = {
  name: "research-worker",
  version: "0.0.1",
  description: "A research worker for integration testing",
  model: { name: "mock-model" },
};

function createMockModelCall(
  responseText: string,
): (request: ModelRequest) => Promise<ModelResponse> {
  return async (_request: ModelRequest): Promise<ModelResponse> => ({
    content: responseText,
    model: "mock-model",
    usage: { inputTokens: 10, outputTokens: 20 },
  });
}

/**
 * Simulates an L3 spawn callback: creates a loop adapter, runs it,
 * and extracts output from the done event.
 */
function createTestSpawnFn(): {
  readonly spawn: (request: MinionSpawnRequest) => Promise<MinionSpawnResult>;
  readonly spawnCalls: MinionSpawnRequest[];
} {
  const spawnCalls: MinionSpawnRequest[] = [];

  const spawn = async (request: MinionSpawnRequest): Promise<MinionSpawnResult> => {
    spawnCalls.push(request);

    const adapter = createLoopAdapter({
      modelCall: createMockModelCall(`Answer for: ${request.description}`),
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

describe("@koi/parallel-minions integration", () => {
  it("full parallel flow: provider → parallel_task tool → 3 engines → aggregated output", async () => {
    const { spawn, spawnCalls } = createTestSpawnFn();

    const config: ParallelMinionsConfig = {
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

    const provider = createParallelMinionsProvider(config);
    const agent = createMockAgent();
    const components = extractMap(await provider.attach(agent));
    const tool = components.get("tool:parallel_task") as Tool;

    expect(tool).toBeDefined();
    expect(tool.descriptor.name).toBe("parallel_task");

    const result = await tool.execute({
      tasks: [
        { description: "What is quantum computing?" },
        { description: "Explain machine learning." },
        { description: "Describe blockchain." },
      ],
    });

    const output = result as string;

    // Verify all 3 tasks were spawned
    expect(spawnCalls).toHaveLength(3);

    // Verify spawn requests are correct
    expect(spawnCalls[0]?.description).toBe("What is quantum computing?");
    expect(spawnCalls[1]?.description).toBe("Explain machine learning.");
    expect(spawnCalls[2]?.description).toBe("Describe blockchain.");

    // All should use the default researcher agent
    for (const call of spawnCalls) {
      expect(call.agentName).toBe("research-worker");
      expect(call.manifest).toBe(WORKER_MANIFEST);
    }

    // Verify aggregated output
    expect(output).toContain("3/3 succeeded");
    expect(output).toContain("quantum computing");
    expect(output).toContain("machine learning");
    expect(output).toContain("blockchain");
  });

  it("handles one failing task without losing other results (best-effort)", async () => {
    // let justified: mutable counter tracking call count
    let callCount = 0;

    const spawn = async (request: MinionSpawnRequest): Promise<MinionSpawnResult> => {
      callCount += 1;
      if (request.taskIndex === 1) {
        return { ok: false, error: "engine adapter failed to initialize" };
      }

      const adapter = createLoopAdapter({
        modelCall: createMockModelCall(`Result for: ${request.description}`),
        maxTurns: 3,
      });

      try {
        const events = await collectEvents(
          adapter.stream({ kind: "text", text: request.description }),
        );
        const output = findDoneOutput(events);
        if (output === undefined) {
          return { ok: false, error: "No done event" };
        }
        const textBlocks = output.content.filter(
          (b): b is { readonly kind: "text"; readonly text: string } => b.kind === "text",
        );
        return { ok: true, output: textBlocks.map((b) => b.text).join("\n") };
      } finally {
        await adapter.dispose?.();
      }
    };

    const config: ParallelMinionsConfig = {
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

    const provider = createParallelMinionsProvider(config);
    const agent = createMockAgent();
    const components = extractMap(await provider.attach(agent));
    const tool = components.get("tool:parallel_task") as Tool;

    const result = await tool.execute({
      tasks: [
        { description: "Task A" },
        { description: "Task B (will fail)" },
        { description: "Task C" },
      ],
    });

    const output = result as string;

    expect(callCount).toBe(3);
    expect(output).toContain("2/3 succeeded");
    expect(output).toContain("[SUCCESS]");
    expect(output).toContain("[FAILED]");
    expect(output).toContain("engine adapter failed to initialize");
  });

  it("specific agent_type routes to correct manifest", async () => {
    const secondManifest: AgentManifest = {
      name: "coder",
      version: "0.0.1",
      model: { name: "code-model" },
    };

    const usedManifests: AgentManifest[] = [];

    const spawn = async (request: MinionSpawnRequest): Promise<MinionSpawnResult> => {
      usedManifests.push(request.manifest);
      return { ok: true, output: `done by ${request.agentName}` };
    };

    const config: ParallelMinionsConfig = {
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

    const provider = createParallelMinionsProvider(config);
    const agent = createMockAgent();
    const components = extractMap(await provider.attach(agent));
    const tool = components.get("tool:parallel_task") as Tool;

    const result = await tool.execute({
      tasks: [
        { description: "Research AI", agent_type: "researcher" },
        { description: "Write a function", agent_type: "coder" },
      ],
    });

    const output = result as string;
    expect(output).toContain("2/2 succeeded");
    expect(usedManifests[0]).toBe(WORKER_MANIFEST);
    expect(usedManifests[1]).toBe(secondManifest);
  });

  it("per-lane concurrency limits researcher tasks while coders run freely", async () => {
    // let justified: mutable counters tracking per-lane peak concurrency
    let researcherConcurrent = 0;
    let researcherPeak = 0;
    let coderConcurrent = 0;
    let coderPeak = 0;

    const secondManifest: AgentManifest = {
      name: "coder",
      version: "0.0.1",
      model: { name: "code-model" },
    };

    const spawn = async (request: MinionSpawnRequest): Promise<MinionSpawnResult> => {
      if (request.agentName === "research-worker") {
        researcherConcurrent += 1;
        if (researcherConcurrent > researcherPeak) researcherPeak = researcherConcurrent;
        await new Promise((resolve) => setTimeout(resolve, 20));
        researcherConcurrent -= 1;
      } else {
        coderConcurrent += 1;
        if (coderConcurrent > coderPeak) coderPeak = coderConcurrent;
        await new Promise((resolve) => setTimeout(resolve, 5));
        coderConcurrent -= 1;
      }
      return { ok: true, output: `done-${request.taskIndex}` };
    };

    const config: ParallelMinionsConfig = {
      agents: new Map([
        [
          "researcher",
          {
            name: "research-worker",
            description: "Researches topics",
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
      maxConcurrency: 10,
      laneConcurrency: new Map([
        ["researcher", 2],
        ["coder", 4],
      ]),
    };

    const provider = createParallelMinionsProvider(config);
    const agent = createMockAgent();
    const components = extractMap(await provider.attach(agent));
    const tool = components.get("tool:parallel_task") as Tool;

    const result = await tool.execute({
      tasks: [
        { description: "Research 1", agent_type: "researcher" },
        { description: "Research 2", agent_type: "researcher" },
        { description: "Research 3", agent_type: "researcher" },
        { description: "Research 4", agent_type: "researcher" },
        { description: "Code 1", agent_type: "coder" },
        { description: "Code 2", agent_type: "coder" },
        { description: "Code 3", agent_type: "coder" },
        { description: "Code 4", agent_type: "coder" },
      ],
    });

    const output = result as string;
    expect(output).toContain("8/8 succeeded");
    expect(researcherPeak).toBeLessThanOrEqual(2);
    expect(coderPeak).toBeLessThanOrEqual(4);
  });

  it("verifies concurrent execution via spawn timing", async () => {
    // let justified: mutable peak concurrency tracker
    let concurrent = 0;
    let peak = 0;

    const spawn = async (request: MinionSpawnRequest): Promise<MinionSpawnResult> => {
      concurrent += 1;
      if (concurrent > peak) peak = concurrent;
      // Simulate async work
      await new Promise((resolve) => setTimeout(resolve, 20));
      concurrent -= 1;
      return { ok: true, output: `done-${request.taskIndex}` };
    };

    const config: ParallelMinionsConfig = {
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
      maxConcurrency: 3,
    };

    const provider = createParallelMinionsProvider(config);
    const agent = createMockAgent();
    const components = extractMap(await provider.attach(agent));
    const tool = components.get("tool:parallel_task") as Tool;

    await tool.execute({
      tasks: Array.from({ length: 6 }, (_, i) => ({
        description: `task-${i}`,
      })),
    });

    // With maxConcurrency=3 and 6 tasks with delays, peak should be 3
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThanOrEqual(2); // At least some concurrency
  });
});
