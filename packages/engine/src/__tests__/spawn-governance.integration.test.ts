/**
 * Spawn governance integration tests — exercises the full createKoi → runtime.run()
 * pipeline with cooperating adapters that trigger spawn tool calls via callHandlers.
 *
 * Verifies that SpawnGuard (L1 guard) is correctly wired into the middleware chain
 * and that spawn options (depth, governance, fan-out, warnings) propagate end-to-end.
 */

import { describe, expect, mock, test } from "bun:test";
import type {
  AgentManifest,
  EngineAdapter,
  EngineEvent,
  EngineInput,
  EngineOutput,
  ToolResponse,
} from "@koi/core";
import { createKoi } from "../koi.js";
import type { SpawnWarningInfo } from "../types.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function testManifest(): AgentManifest {
  return {
    name: "Spawn Gov Test Agent",
    version: "0.1.0",
    model: { name: "test-model" },
  };
}

function doneOutput(overrides?: Partial<EngineOutput>): EngineOutput {
  return {
    content: [{ kind: "text", text: "done" }],
    stopReason: "completed",
    metrics: {
      totalTokens: 10,
      inputTokens: 5,
      outputTokens: 5,
      turns: 1,
      durationMs: 100,
    },
    ...overrides,
  };
}

async function collectEvents(iter: AsyncIterable<EngineEvent>): Promise<readonly EngineEvent[]> {
  const events: EngineEvent[] = [];
  for await (const event of iter) {
    events.push(event);
  }
  return events;
}

/**
 * Cooperating adapter that calls `callHandlers.toolCall()` for each request.
 * Collects results and errors for assertion.
 */
function spawnTestAdapter(
  toolCalls: readonly {
    readonly toolId: string;
    readonly input: Readonly<Record<string, unknown>>;
  }[],
  results: string[],
): EngineAdapter {
  const rawToolCall = mock(
    async (req: { readonly toolId: string }): Promise<ToolResponse> => ({
      output: `spawned:${req.toolId}`,
    }),
  );
  return {
    engineId: "spawn-test",
    terminals: {
      modelCall: async () => ({ content: "ok", model: "test" }),
      toolCall: rawToolCall,
    },
    stream: (input: EngineInput) => ({
      async *[Symbol.asyncIterator]() {
        if (!input.callHandlers) {
          yield { kind: "done" as const, output: doneOutput() };
          return;
        }
        for (const call of toolCalls) {
          try {
            const res = await input.callHandlers.toolCall({
              toolId: call.toolId,
              input: call.input,
            });
            results.push(`ok:${String(res.output)}`);
          } catch (e: unknown) {
            results.push(`error:${(e as Error).message}`);
          }
        }
        yield { kind: "done" as const, output: doneOutput() };
      },
    }),
    _rawToolCall: rawToolCall,
  } as EngineAdapter & { readonly _rawToolCall: ReturnType<typeof mock> };
}

/**
 * Cooperating adapter that makes concurrent tool calls (all started before any awaited).
 * Used for testing fan-out limits under concurrency.
 */
function concurrentSpawnAdapter(count: number, results: string[]): EngineAdapter {
  return {
    engineId: "concurrent-spawn-test",
    terminals: {
      modelCall: async () => ({ content: "ok", model: "test" }),
      toolCall: async () => ({ output: "spawned" }),
    },
    stream: (input: EngineInput) => ({
      async *[Symbol.asyncIterator]() {
        if (!input.callHandlers) {
          yield { kind: "done" as const, output: doneOutput() };
          return;
        }
        // Fire all tool calls concurrently
        const handlers = input.callHandlers;
        const promises = Array.from({ length: count }, (_, i) =>
          handlers
            .toolCall({ toolId: "forge_agent", input: { task: `job-${i}` } })
            .then((res) => results.push(`ok:${String(res.output)}`))
            .catch((e: unknown) => results.push(`error:${(e as Error).message}`)),
        );
        await Promise.all(promises);
        yield { kind: "done" as const, output: doneOutput() };
      },
    }),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("spawn governance integration", () => {
  test("allows forge_agent calls under default limits", async () => {
    const results: string[] = [];
    const adapter = spawnTestAdapter([{ toolId: "forge_agent", input: { task: "go" } }], results);

    const runtime = await createKoi({
      manifest: testManifest(),
      adapter,
      loopDetection: false,
    });

    await collectEvents(runtime.run({ kind: "text", text: "test" }));

    expect(results).toEqual(["ok:spawned:forge_agent"]);
  });

  test("non-spawn tool calls are unaffected by spawn governance", async () => {
    const results: string[] = [];
    const adapter = spawnTestAdapter(
      [
        { toolId: "calculator", input: { expr: "1+1" } },
        { toolId: "search", input: { q: "hello" } },
      ],
      results,
    );

    const runtime = await createKoi({
      manifest: testManifest(),
      adapter,
      spawn: { maxDepth: 0 }, // Would block forge_agent, but not these
      loopDetection: false,
    });

    await collectEvents(runtime.run({ kind: "text", text: "test" }));

    // Both calls succeed — spawn guard ignores non-spawn tool IDs
    expect(results).toEqual(["ok:spawned:calculator", "ok:spawned:search"]);
  });

  test("blocks forge_agent when maxDepth is 0", async () => {
    const results: string[] = [];
    const adapter = spawnTestAdapter([{ toolId: "forge_agent", input: {} }], results);

    const runtime = await createKoi({
      manifest: testManifest(),
      adapter,
      spawn: { maxDepth: 0 },
      loopDetection: false,
    });

    await collectEvents(runtime.run({ kind: "text", text: "test" }));

    // Root agent is at depth 0; child would be depth 1 > maxDepth 0
    expect(results).toHaveLength(1);
    expect(results[0]).toContain("error:");
    expect(results[0]).toContain("Max spawn depth exceeded");
  });

  test("enforces fan-out on concurrent spawns", async () => {
    const results: string[] = [];
    // Fire 5 concurrent spawns with maxFanOut of 3
    const adapter = concurrentSpawnAdapter(5, results);

    const runtime = await createKoi({
      manifest: testManifest(),
      adapter,
      spawn: { maxFanOut: 3 },
      loopDetection: false,
    });

    await collectEvents(runtime.run({ kind: "text", text: "test" }));

    const successes = results.filter((r) => r.startsWith("ok:"));
    const errors = results.filter((r) => r.startsWith("error:"));

    // At most 3 should succeed (concurrent fan-out limit)
    expect(successes.length).toBeLessThanOrEqual(3);
    expect(errors.length).toBeGreaterThanOrEqual(2);
    expect(errors.every((e) => e.includes("Max fan-out exceeded"))).toBe(true);
  });

  test("warning callback fires through createKoi spawn options", async () => {
    const warnings: SpawnWarningInfo[] = [];

    const results: string[] = [];
    // 3 concurrent spawns with fanOutWarningAt: 2
    const adapter = concurrentSpawnAdapter(3, results);

    const runtime = await createKoi({
      manifest: testManifest(),
      adapter,
      spawn: {
        maxFanOut: 5,
        fanOutWarningAt: 2,
        onWarning: (info: SpawnWarningInfo) => warnings.push(info),
      },
      loopDetection: false,
    });

    await collectEvents(runtime.run({ kind: "text", text: "test" }));

    // Warning should have fired when concurrent children reached 2
    expect(warnings.length).toBeGreaterThanOrEqual(1);
    expect(warnings[0]?.kind).toBe("fan_out");
    expect(warnings[0]?.warningAt).toBe(2);
  });

  test("depth limit is enforced", async () => {
    const results: string[] = [];
    const adapter = spawnTestAdapter([{ toolId: "forge_agent", input: {} }], results);

    const runtime = await createKoi({
      manifest: testManifest(),
      adapter,
      spawn: { maxDepth: 0 },
      loopDetection: false,
    });

    await collectEvents(runtime.run({ kind: "text", text: "test" }));

    expect(results[0]).toContain("Max spawn depth exceeded");
  });

  test("raw tool terminal receives request only when guard allows spawn", async () => {
    const rawToolCallSpy = mock(
      async (): Promise<ToolResponse> => ({
        output: "child-result",
      }),
    );

    const results: string[] = [];
    const adapter: EngineAdapter = {
      engineId: "spy-terminal",
      terminals: {
        modelCall: async () => ({ content: "ok", model: "test" }),
        toolCall: rawToolCallSpy,
      },
      stream: (input: EngineInput) => ({
        async *[Symbol.asyncIterator]() {
          if (!input.callHandlers) {
            yield { kind: "done" as const, output: doneOutput() };
            return;
          }
          // First call: blocked by depth
          try {
            await input.callHandlers.toolCall({ toolId: "forge_agent", input: {} });
            results.push("ok");
          } catch (e: unknown) {
            results.push(`error:${(e as Error).message}`);
          }
          // Second call: non-spawn tool, passes through
          try {
            await input.callHandlers.toolCall({ toolId: "calculator", input: { x: 1 } });
            results.push("ok");
          } catch (e: unknown) {
            results.push(`error:${(e as Error).message}`);
          }
          yield { kind: "done" as const, output: doneOutput() };
        },
      }),
    };

    const runtime = await createKoi({
      manifest: testManifest(),
      adapter,
      spawn: { maxDepth: 0 },
      loopDetection: false,
    });

    await collectEvents(runtime.run({ kind: "text", text: "test" }));

    // forge_agent blocked, calculator passed through
    expect(results[0]).toContain("error:Max spawn depth exceeded");
    expect(results[1]).toBe("ok");
    // Raw terminal called only once (for calculator, not for blocked forge_agent)
    expect(rawToolCallSpy).toHaveBeenCalledTimes(1);
  });
});
