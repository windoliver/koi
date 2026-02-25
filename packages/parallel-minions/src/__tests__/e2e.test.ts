/**
 * E2E test for @koi/parallel-minions through the full L1 runtime (createKoi).
 *
 * Validates the complete path:
 *   Parent agent (createKoi + parallel_task tool provider)
 *     → parallel_task tool invoked with multiple tasks
 *     → SpawnFn creates child agents (createKoi + createLoopAdapter / createPiAdapter)
 *     → Children run with real LLM calls
 *     → Output aggregated and returned as tool result
 *     → Per-lane concurrency enforced across agent types
 *
 * Gated on ANTHROPIC_API_KEY — tests are skipped when the key is not set.
 *
 * Run:
 *   ANTHROPIC_API_KEY=sk-ant-... bun test src/__tests__/e2e.test.ts
 */

import { describe, expect, test } from "bun:test";
import type {
  AgentManifest,
  EngineEvent,
  EngineOutput,
  ModelRequest,
  ModelResponse,
  SubsystemToken,
  Tool,
} from "@koi/core";
import { createInMemorySpawnLedger, createKoi } from "@koi/engine";
import { createLoopAdapter } from "@koi/engine-loop";
import { createPiAdapter } from "@koi/engine-pi";
import { createAnthropicAdapter } from "@koi/model-router";
import { createParallelMinionsProvider } from "../provider.js";
import type { MinionSpawnRequest, MinionSpawnResult, ParallelMinionsConfig } from "../types.js";

// ---------------------------------------------------------------------------
// Environment gate
// ---------------------------------------------------------------------------

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY ?? "";
const HAS_KEY = ANTHROPIC_KEY.length > 0;
const describeE2E = HAS_KEY ? describe : describe.skip;

const TIMEOUT_MS = 120_000;
const MODEL = "claude-haiku-4-5-20251001";

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

function extractTextFromOutput(output: EngineOutput): string {
  const textBlocks = output.content.filter(
    (b): b is { readonly kind: "text"; readonly text: string } => b.kind === "text",
  );
  return textBlocks.map((b) => b.text).join("\n");
}

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const llmAdapter = createAnthropicAdapter({ apiKey: ANTHROPIC_KEY });
const modelCall = (request: ModelRequest): Promise<ModelResponse> =>
  llmAdapter.complete({ ...request, model: MODEL });

const RESEARCHER_MANIFEST: AgentManifest = {
  name: "research-worker",
  version: "0.0.1",
  description: "Researches topics concisely",
  model: { name: MODEL },
};

const CODER_MANIFEST: AgentManifest = {
  name: "coder-worker",
  version: "0.0.1",
  description: "Writes code concisely",
  model: { name: MODEL },
};

// ---------------------------------------------------------------------------
// Test 1: Full L1 runtime via createLoopAdapter
// ---------------------------------------------------------------------------

describeE2E("@koi/parallel-minions E2E with real LLM", () => {
  test(
    "parallel_task tool executes 3 children through createKoi + createLoopAdapter",
    async () => {
      const spawnCalls: string[] = [];

      const spawn = async (request: MinionSpawnRequest): Promise<MinionSpawnResult> => {
        spawnCalls.push(request.agentName);
        const childAdapter = createLoopAdapter({ modelCall, maxTurns: 1 });

        try {
          const events = await collectEvents(
            childAdapter.stream({ kind: "text", text: request.description }),
          );
          const output = findDoneOutput(events);

          if (output === undefined) {
            return { ok: false, error: "No done event from child engine" };
          }

          const text = extractTextFromOutput(output);
          return { ok: true, output: text.length > 0 ? text : "(empty)" };
        } finally {
          await childAdapter.dispose?.();
        }
      };

      const config: ParallelMinionsConfig = {
        agents: new Map([
          [
            "researcher",
            { name: "research-worker", description: "Researches", manifest: RESEARCHER_MANIFEST },
          ],
          ["coder", { name: "coder-worker", description: "Codes", manifest: CODER_MANIFEST }],
        ]),
        spawn,
        defaultAgent: "researcher",
        maxConcurrency: 3,
      };

      const provider = createParallelMinionsProvider(config);

      const parentAdapter = createLoopAdapter({ modelCall, maxTurns: 1 });
      const parentRuntime = await createKoi({
        manifest: {
          name: "parent-agent",
          version: "0.0.1",
          description: "Parent with parallel_task tool",
          model: { name: MODEL },
        },
        adapter: parentAdapter,
        providers: [provider],
        loopDetection: false,
        limits: { maxTurns: 1, maxDurationMs: 90_000, maxTokens: 50_000 },
      });

      // Verify tool was attached
      const tool = parentRuntime.agent.component<Tool>(
        "tool:parallel_task" as SubsystemToken<Tool>,
      );
      expect(tool).toBeDefined();
      expect(tool?.descriptor.name).toBe("parallel_task");

      if (tool === undefined) throw new Error("parallel_task tool not attached");

      // Direct invocation — bypasses model deciding to call, tests the tool → spawn → LLM path
      const result = await tool.execute({
        tasks: [
          { description: "Reply with exactly one word: ALPHA" },
          { description: "Reply with exactly one word: BRAVO", agent_type: "coder" },
          { description: "Reply with exactly one word: CHARLIE" },
        ],
      });

      const output = result as string;
      console.log("\n--- parallel_task output (createLoopAdapter) ---");
      console.log(output);
      console.log("---\n");

      // All 3 tasks should have spawned
      expect(spawnCalls).toHaveLength(3);
      expect(spawnCalls[0]).toBe("research-worker");
      expect(spawnCalls[1]).toBe("coder-worker");
      expect(spawnCalls[2]).toBe("research-worker");

      // Aggregated output should report 3/3 succeeded
      expect(output).toContain("3/3 succeeded");

      await parentRuntime.dispose();
    },
    TIMEOUT_MS,
  );

  // -------------------------------------------------------------------------
  // Test 2: Per-lane concurrency enforcement with real LLM calls
  // -------------------------------------------------------------------------
  test(
    "per-lane concurrency limits researcher to 1 while coder runs freely",
    async () => {
      // let justified: mutable counters tracking per-lane peak concurrency
      let researcherConcurrent = 0;
      let researcherPeak = 0;
      let coderConcurrent = 0;
      let coderPeak = 0;

      const spawn = async (request: MinionSpawnRequest): Promise<MinionSpawnResult> => {
        const isResearcher = request.agentName === "research-worker";

        if (isResearcher) {
          researcherConcurrent += 1;
          if (researcherConcurrent > researcherPeak) researcherPeak = researcherConcurrent;
        } else {
          coderConcurrent += 1;
          if (coderConcurrent > coderPeak) coderPeak = coderConcurrent;
        }

        const childAdapter = createLoopAdapter({ modelCall, maxTurns: 1 });
        try {
          const events = await collectEvents(
            childAdapter.stream({ kind: "text", text: request.description }),
          );
          const output = findDoneOutput(events);
          if (output === undefined) return { ok: false, error: "No done event" };
          return { ok: true, output: extractTextFromOutput(output) || "(empty)" };
        } finally {
          if (isResearcher) {
            researcherConcurrent -= 1;
          } else {
            coderConcurrent -= 1;
          }
          await childAdapter.dispose?.();
        }
      };

      const config: ParallelMinionsConfig = {
        agents: new Map([
          [
            "researcher",
            { name: "research-worker", description: "Researches", manifest: RESEARCHER_MANIFEST },
          ],
          ["coder", { name: "coder-worker", description: "Codes", manifest: CODER_MANIFEST }],
        ]),
        spawn,
        defaultAgent: "researcher",
        maxConcurrency: 5,
        laneConcurrency: new Map([
          ["researcher", 1],
          ["coder", 3],
        ]),
      };

      const provider = createParallelMinionsProvider(config);
      const parentAdapter = createLoopAdapter({ modelCall, maxTurns: 1 });
      const parentRuntime = await createKoi({
        manifest: { name: "parent", version: "0.0.1", model: { name: MODEL } },
        adapter: parentAdapter,
        providers: [provider],
        loopDetection: false,
        limits: { maxTurns: 1, maxDurationMs: 90_000, maxTokens: 50_000 },
      });

      const tool = parentRuntime.agent.component<Tool>(
        "tool:parallel_task" as SubsystemToken<Tool>,
      );
      if (tool === undefined) throw new Error("tool not attached");

      const result = await tool.execute({
        tasks: [
          { description: "Reply: R1", agent_type: "researcher" },
          { description: "Reply: R2", agent_type: "researcher" },
          { description: "Reply: R3", agent_type: "researcher" },
          { description: "Reply: C1", agent_type: "coder" },
          { description: "Reply: C2", agent_type: "coder" },
          { description: "Reply: C3", agent_type: "coder" },
        ],
      });

      const output = result as string;
      console.log("\n--- per-lane concurrency output ---");
      console.log(output);
      console.log(`Researcher peak: ${String(researcherPeak)}, Coder peak: ${String(coderPeak)}`);
      console.log("---\n");

      expect(output).toContain("6/6 succeeded");
      expect(researcherPeak).toBeLessThanOrEqual(1);
      expect(coderPeak).toBeLessThanOrEqual(3);

      await parentRuntime.dispose();
    },
    TIMEOUT_MS,
  );

  // -------------------------------------------------------------------------
  // Test 3: Full path via createPiAdapter (alternative engine)
  // -------------------------------------------------------------------------
  test(
    "parallel_task tool with createPiAdapter engine",
    async () => {
      const spawn = async (request: MinionSpawnRequest): Promise<MinionSpawnResult> => {
        const childPiAdapter = createPiAdapter({
          model: `anthropic:${MODEL}`,
          systemPrompt: "Reply concisely in one sentence or less.",
          getApiKey: async () => ANTHROPIC_KEY,
        });

        const childRuntime = await createKoi({
          manifest: request.manifest,
          adapter: childPiAdapter,
          loopDetection: false,
          limits: { maxTurns: 1, maxDurationMs: 30_000, maxTokens: 5_000 },
        });

        try {
          const events = await collectEvents(
            childRuntime.run({ kind: "text", text: request.description }),
          );
          const output = findDoneOutput(events);
          if (output === undefined) return { ok: false, error: "No done event" };
          return { ok: true, output: extractTextFromOutput(output) || "(empty)" };
        } finally {
          await childRuntime.dispose();
        }
      };

      const config: ParallelMinionsConfig = {
        agents: new Map([
          [
            "worker",
            { name: "pi-worker", description: "Pi-powered worker", manifest: RESEARCHER_MANIFEST },
          ],
        ]),
        spawn,
        defaultAgent: "worker",
        maxConcurrency: 2,
      };

      const provider = createParallelMinionsProvider(config);

      // Parent also uses Pi adapter
      const parentPiAdapter = createPiAdapter({
        model: `anthropic:${MODEL}`,
        systemPrompt: "You are a coordinator.",
        getApiKey: async () => ANTHROPIC_KEY,
      });

      const parentRuntime = await createKoi({
        manifest: { name: "parent-pi", version: "0.0.1", model: { name: MODEL } },
        adapter: parentPiAdapter,
        providers: [provider],
        loopDetection: false,
        limits: { maxTurns: 1, maxDurationMs: 60_000, maxTokens: 20_000 },
      });

      const tool = parentRuntime.agent.component<Tool>(
        "tool:parallel_task" as SubsystemToken<Tool>,
      );
      if (tool === undefined) throw new Error("tool not attached");

      const result = await tool.execute({
        tasks: [
          { description: "What is 2+2? Reply with just the number." },
          { description: "What is 3+3? Reply with just the number." },
        ],
      });

      const output = result as string;
      console.log("\n--- parallel_task output (createPiAdapter) ---");
      console.log(output);
      console.log("---\n");

      expect(output).toContain("2/2 succeeded");

      await parentRuntime.dispose();
    },
    TIMEOUT_MS,
  );

  // -------------------------------------------------------------------------
  // Test 4: SpawnLedger integration — tree-wide process tracking
  // -------------------------------------------------------------------------
  test(
    "parallel_task with spawnLedger tracks child count correctly",
    async () => {
      const ledger = createInMemorySpawnLedger(10);
      expect(ledger.activeCount()).toBe(0);

      const spawn = async (request: MinionSpawnRequest): Promise<MinionSpawnResult> => {
        const childAdapter = createLoopAdapter({ modelCall, maxTurns: 1 });
        const childRuntime = await createKoi({
          manifest: request.manifest,
          adapter: childAdapter,
          spawnLedger: ledger,
          agentType: "worker",
          loopDetection: false,
          limits: { maxTurns: 1, maxDurationMs: 30_000, maxTokens: 10_000 },
        });

        try {
          const events = await collectEvents(
            childRuntime.run({ kind: "text", text: request.description }),
          );
          const output = findDoneOutput(events);
          if (output === undefined) return { ok: false, error: "No done event" };
          return { ok: true, output: extractTextFromOutput(output) || "(empty)" };
        } finally {
          await childRuntime.dispose();
        }
      };

      const config: ParallelMinionsConfig = {
        agents: new Map([
          ["worker", { name: "worker", description: "Worker", manifest: RESEARCHER_MANIFEST }],
        ]),
        spawn,
        defaultAgent: "worker",
        maxConcurrency: 3,
      };

      const provider = createParallelMinionsProvider(config);
      const parentAdapter = createLoopAdapter({ modelCall, maxTurns: 1 });
      const parentRuntime = await createKoi({
        manifest: { name: "parent", version: "0.0.1", model: { name: MODEL } },
        adapter: parentAdapter,
        providers: [provider],
        spawnLedger: ledger,
        loopDetection: false,
        limits: { maxTurns: 1, maxDurationMs: 90_000, maxTokens: 50_000 },
      });

      const tool = parentRuntime.agent.component<Tool>(
        "tool:parallel_task" as SubsystemToken<Tool>,
      );
      if (tool === undefined) throw new Error("tool not attached");

      const result = await tool.execute({
        tasks: [{ description: "Reply: PING" }, { description: "Reply: PONG" }],
      });

      const output = result as string;
      console.log("\n--- spawnLedger integration output ---");
      console.log(output);
      console.log("---\n");

      expect(output).toContain("2/2 succeeded");

      await parentRuntime.dispose();
    },
    TIMEOUT_MS,
  );
});
