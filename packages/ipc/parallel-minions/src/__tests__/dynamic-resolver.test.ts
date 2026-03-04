/**
 * Tests for dynamic AgentResolver support in parallel-minions.
 *
 * Validates resolver-first fallback, async resolution, and concurrent
 * tasks with different agent types.
 */

import { describe, expect, it, mock } from "bun:test";
import type { AgentResolver, TaskableAgent } from "@koi/core/agent-resolver";
import type { AgentManifest } from "@koi/core/assembly";
import type { KoiError, Result } from "@koi/core/errors";
import { executeBatch } from "../executor.js";
import type { MinionSpawnRequest, ParallelMinionsConfig } from "../types.js";

const MOCK_MANIFEST: AgentManifest = {
  name: "test",
  version: "0.0.1",
  model: { name: "test-model" },
};

const RESEARCH_MANIFEST: AgentManifest = {
  name: "researcher",
  version: "0.0.1",
  model: { name: "research-model" },
};

/** Helper: creates a Result-returning resolver from a lookup map. */
function createTestResolver(agents: ReadonlyMap<string, TaskableAgent>): AgentResolver {
  const summaries = [...agents.entries()].map(([key, a]) => ({
    key,
    name: a.name,
    description: a.description,
  }));
  return {
    resolve: async (type): Promise<Result<TaskableAgent, KoiError>> => {
      const agent = agents.get(type);
      if (agent === undefined) {
        return {
          ok: false,
          error: { code: "NOT_FOUND", message: `Unknown: ${type}`, retryable: false },
        };
      }
      return { ok: true, value: agent };
    },
    list: async () => summaries,
  };
}

function createSpawnFn() {
  return mock(async (request: MinionSpawnRequest) => ({
    ok: true as const,
    output: `done: ${request.description}`,
  }));
}

describe("dynamic AgentResolver in parallel-minions", () => {
  it("resolves agents via agentResolver when provided", async () => {
    const resolver = createTestResolver(
      new Map([["test", { name: "test-agent", description: "Test", manifest: MOCK_MANIFEST }]]),
    );
    const spawnFn = createSpawnFn();
    const config: ParallelMinionsConfig = {
      agentResolver: resolver,
      spawn: spawnFn,
    };

    const result = await executeBatch(config, [{ description: "do work", agent_type: "test" }]);

    expect(result.summary.succeeded).toBe(1);
    expect(result.summary.failed).toBe(0);
    expect(result.outcomes[0]?.ok).toBe(true);
  });

  it("returns NOT_FOUND error when resolver has no match", async () => {
    const resolver = createTestResolver(new Map());
    const spawnFn = createSpawnFn();
    const config: ParallelMinionsConfig = {
      agentResolver: resolver,
      spawn: spawnFn,
    };

    const result = await executeBatch(config, [
      { description: "do work", agent_type: "nonexistent" },
    ]);

    expect(result.summary.failed).toBe(1);
    const firstOutcome = result.outcomes[0];
    expect(firstOutcome?.ok).toBe(false);
    if (firstOutcome !== undefined && !firstOutcome.ok) {
      expect(firstOutcome.error).toContain("unknown agent type");
    }
  });

  it("falls back to static agents map when resolver returns NOT_FOUND", async () => {
    const resolver = createTestResolver(new Map()); // empty resolver
    const spawnFn = createSpawnFn();
    const config: ParallelMinionsConfig = {
      agentResolver: resolver,
      agents: new Map([
        ["fallback", { name: "fallback-agent", description: "Fallback", manifest: MOCK_MANIFEST }],
      ]),
      spawn: spawnFn,
    };

    const result = await executeBatch(config, [{ description: "do work", agent_type: "fallback" }]);

    expect(result.summary.succeeded).toBe(1);
    const call = spawnFn.mock.calls[0] as unknown as [MinionSpawnRequest];
    expect(call[0].agentName).toBe("fallback-agent");
  });

  it("handles async resolver (returns Promise) correctly", async () => {
    const resolver: AgentResolver = {
      resolve: (type) =>
        new Promise((resolve) => {
          setTimeout(() => {
            if (type === "delayed") {
              resolve({
                ok: true,
                value: {
                  name: "delayed-agent",
                  description: "Delayed",
                  manifest: MOCK_MANIFEST,
                },
              });
            } else {
              resolve({
                ok: false,
                error: { code: "NOT_FOUND", message: "Not found", retryable: false },
              });
            }
          }, 10);
        }),
      list: async () => [{ key: "delayed", name: "delayed-agent", description: "Delayed" }],
    };
    const spawnFn = createSpawnFn();
    const config: ParallelMinionsConfig = {
      agentResolver: resolver,
      spawn: spawnFn,
    };

    const result = await executeBatch(config, [{ description: "do work", agent_type: "delayed" }]);

    expect(result.summary.succeeded).toBe(1);
  });

  it("resolves concurrent tasks with different agent types", async () => {
    const resolver = createTestResolver(
      new Map<string, TaskableAgent>([
        ["research", { name: "researcher", description: "Research", manifest: RESEARCH_MANIFEST }],
        ["code", { name: "coder", description: "Code", manifest: MOCK_MANIFEST }],
      ]),
    );
    const spawnFn = createSpawnFn();
    const config: ParallelMinionsConfig = {
      agentResolver: resolver,
      spawn: spawnFn,
    };

    const result = await executeBatch(config, [
      { description: "research topic", agent_type: "research" },
      { description: "write code", agent_type: "code" },
      { description: "more research", agent_type: "research" },
    ]);

    expect(result.summary.total).toBe(3);
    expect(result.summary.succeeded).toBe(3);
    expect(spawnFn).toHaveBeenCalledTimes(3);

    // Verify correct manifest was passed to each spawn
    const calls = spawnFn.mock.calls as unknown as ReadonlyArray<[MinionSpawnRequest]>;
    const manifestNames = calls.map((c) => c[0].manifest.name).sort();
    expect(manifestNames).toEqual(["researcher", "researcher", "test"]);
  });

  it("uses defaultAgent with resolver when agent_type is omitted", async () => {
    const resolver = createTestResolver(
      new Map([
        [
          "default-type",
          { name: "default-agent", description: "Default", manifest: MOCK_MANIFEST },
        ],
      ]),
    );
    const spawnFn = createSpawnFn();
    const config: ParallelMinionsConfig = {
      agentResolver: resolver,
      spawn: spawnFn,
      defaultAgent: "default-type",
    };

    const result = await executeBatch(config, [{ description: "do work" }]);

    expect(result.summary.succeeded).toBe(1);
    const call = spawnFn.mock.calls[0] as unknown as [MinionSpawnRequest];
    expect(call[0].agentName).toBe("default-agent");
  });
});
