/**
 * E2E tests through createKoi + createPiAdapter (pi-agent-core engine).
 *
 * Validates Changes 2 & 3 through the full L1 runtime with the pi adapter —
 * the real production engine path with middleware composition, cooperating
 * mode, and tool chain wiring.
 *
 * This is the heaviest E2E path: createKoi composes middleware chains,
 * wires call handlers, creates terminal handlers, and passes them to the
 * pi adapter's stream() in cooperating mode.
 *
 * Gated on E2E_TESTS=1 + ANTHROPIC_API_KEY.
 *
 * Run:
 *   E2E_TESTS=1 bun test src/__tests__/e2e-pi.test.ts
 */

import { describe, expect, test } from "bun:test";
import type { EngineEvent, SubsystemToken } from "@koi/core";
import type { Tool } from "@koi/core/ecs";
import { agentId } from "@koi/core/ecs";
import { createKoi } from "@koi/engine";
import { createPiAdapter } from "@koi/engine-pi";
import { createTaskSpawnProvider } from "../provider.js";
import type {
  AgentResolver,
  MessageFn,
  TaskSpawnConfig,
  TaskSpawnRequest,
  TaskSpawnResult,
} from "../types.js";

// ---------------------------------------------------------------------------
// Environment gate
// ---------------------------------------------------------------------------

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY ?? "";
const E2E_OPTED_IN = process.env.E2E_TESTS === "1";
const E2E_GATE = ANTHROPIC_KEY.length > 0 && E2E_OPTED_IN;
const describeE2E = E2E_GATE ? describe : describe.skip;

const TIMEOUT_MS = 120_000;
const PI_MODEL = "anthropic:claude-haiku-4-5-20251001";

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

function findDoneOutput(
  events: readonly EngineEvent[],
): import("@koi/core").EngineOutput | undefined {
  const done = events.find((e): e is EngineEvent & { readonly kind: "done" } => e.kind === "done");
  return done?.output;
}

/**
 * Extract text from text_delta events in the event stream.
 * Pi adapter delivers text via text_delta events (done.output.content is always []).
 */
function extractTextFromEvents(events: readonly EngineEvent[]): string {
  return events
    .filter(
      (e): e is EngineEvent & { readonly kind: "text_delta"; readonly delta: string } =>
        e.kind === "text_delta",
    )
    .map((e) => e.delta)
    .join("");
}

function getSchemaProperty(
  schema: { readonly properties?: unknown },
  key: string,
): Record<string, unknown> | undefined {
  if (typeof schema.properties !== "object" || schema.properties === null) {
    return undefined;
  }
  const props = schema.properties as Record<string, unknown>;
  const value = props[key];
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function requireTool<T>(tool: T | undefined, name: string): T {
  if (tool === undefined) {
    throw new Error(`${name} tool was not attached to the agent`);
  }
  return tool;
}

/** Create a pi adapter configured for E2E testing. */
function createTestPiAdapter(): ReturnType<typeof createPiAdapter> {
  return createPiAdapter({
    model: PI_MODEL,
    systemPrompt: "You are a concise assistant. Follow instructions exactly.",
    getApiKey: async () => ANTHROPIC_KEY,
  });
}

/**
 * Spawn callback for child agents — uses createPiAdapter through createKoi.
 * This is the real production path for subagent spawning.
 */
async function piSpawn(request: TaskSpawnRequest): Promise<TaskSpawnResult> {
  const childAdapter = createPiAdapter({
    model: PI_MODEL,
    systemPrompt: "You are a concise worker. Follow instructions exactly.",
    getApiKey: async () => ANTHROPIC_KEY,
  });

  const childRuntime = await createKoi({
    manifest: request.manifest,
    adapter: childAdapter,
    loopDetection: false,
    limits: { maxTurns: 2, maxDurationMs: 60_000, maxTokens: 30_000 },
  });

  try {
    const events = await collectEvents(
      childRuntime.run({ kind: "text", text: request.description }),
    );
    const output = findDoneOutput(events);

    if (output === undefined) {
      return { ok: false, error: "No done event from child pi agent" };
    }

    if (output.stopReason === "error") {
      const errMeta = output.metadata;
      const errMsg =
        typeof errMeta === "object" && errMeta !== null && "error" in errMeta
          ? String(errMeta.error)
          : "Child pi agent terminated with error";
      return { ok: false, error: errMsg };
    }

    // Pi adapter delivers text via text_delta events (done.content is always [])
    const text = extractTextFromEvents(events);
    return { ok: true, output: text.length > 0 ? text : "(empty)" };
  } finally {
    await childRuntime.dispose();
  }
}

const WORKER_MANIFEST = {
  name: "pi-test-worker",
  version: "0.0.1",
  description: "E2E test worker (pi adapter)",
  model: { name: "claude-haiku-4-5-20251001" },
  lifecycle: "worker" as const,
};

const COPILOT_MANIFEST = {
  name: "pi-test-copilot",
  version: "0.0.1",
  description: "E2E test copilot (pi adapter)",
  model: { name: "claude-haiku-4-5-20251001" },
  lifecycle: "copilot" as const,
};

// =========================================================================
// Change 2: Dynamic AgentResolver through createKoi + createPiAdapter
// =========================================================================

describeE2E("Pi adapter: Dynamic AgentResolver through full L1 runtime", () => {
  test(
    "async AgentResolver + dynamic enum + real pi agent spawn",
    async () => {
      const resolver: AgentResolver = {
        async resolve(agentType) {
          await Promise.resolve();
          if (agentType === "researcher") {
            return {
              name: "pi-researcher",
              description: "Researches via pi adapter",
              manifest: WORKER_MANIFEST,
            };
          }
          return undefined;
        },
        async list() {
          return [
            {
              key: "researcher",
              name: "pi-researcher",
              description: "Researches via pi adapter",
            },
          ];
        },
      };

      const config: TaskSpawnConfig = {
        agentResolver: resolver,
        spawn: piSpawn,
        defaultAgent: "researcher",
        maxDurationMs: 60_000,
      };

      const provider = createTaskSpawnProvider(config);
      const adapter = createTestPiAdapter();

      const runtime = await createKoi({
        manifest: {
          name: "pi-parent-resolver",
          version: "0.0.1",
          model: { name: "claude-haiku-4-5-20251001" },
        },
        adapter,
        providers: [provider],
        loopDetection: false,
        limits: { maxTurns: 2, maxDurationMs: 60_000, maxTokens: 50_000 },
      });

      try {
        const taskTool = requireTool(
          runtime.agent.component<Tool>("tool:task" as SubsystemToken<Tool>),
          "task",
        );

        // Verify dynamic enum
        const agentTypeProp = getSchemaProperty(taskTool.descriptor.inputSchema, "agent_type");
        expect(agentTypeProp?.enum).toEqual(["researcher"]);

        // Execute through real pi agent (child spawns another pi agent)
        const result = await taskTool.execute({
          description: "Reply with exactly: PI_PONG",
          agent_type: "researcher",
        });

        expect(typeof result).toBe("string");
        expect(String(result).toLowerCase()).toContain("pi_pong");
      } finally {
        await runtime.dispose();
      }
    },
    TIMEOUT_MS,
  );
});

// =========================================================================
// Change 3: Copilot routing through createKoi + createPiAdapter
// =========================================================================

describeE2E("Pi adapter: Copilot routing through full L1 runtime", () => {
  test(
    "routes to live copilot via message callback (pi adapter parent)",
    async () => {
      const liveAgentId = agentId("pi-copilot-live-001");
      // let: track whether message was called
      let messageCalled = false;

      const messageFn: MessageFn = async (request) => {
        messageCalled = true;
        return {
          ok: true,
          output: `PI_COPILOT_RESPONSE: ${request.description}`,
        };
      };

      const resolver: AgentResolver = {
        resolve(agentType) {
          if (agentType === "assistant") {
            return {
              name: "pi-copilot",
              description: "A live pi copilot",
              manifest: COPILOT_MANIFEST,
            };
          }
          return undefined;
        },
        list() {
          return [
            {
              key: "assistant",
              name: "pi-copilot",
              description: "A live pi copilot",
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
        spawn: piSpawn,
        message: messageFn,
        defaultAgent: "assistant",
        maxDurationMs: 60_000,
      };

      const provider = createTaskSpawnProvider(config);
      const adapter = createTestPiAdapter();

      const runtime = await createKoi({
        manifest: {
          name: "pi-parent-copilot",
          version: "0.0.1",
          model: { name: "claude-haiku-4-5-20251001" },
        },
        adapter,
        providers: [provider],
        loopDetection: false,
        limits: { maxTurns: 2, maxDurationMs: 60_000, maxTokens: 50_000 },
      });

      try {
        const taskTool = requireTool(
          runtime.agent.component<Tool>("tool:task" as SubsystemToken<Tool>),
          "task",
        );

        const result = await taskTool.execute({
          description: "Help me with pi routing",
          agent_type: "assistant",
        });

        expect(messageCalled).toBe(true);
        expect(typeof result).toBe("string");
        expect(String(result)).toContain("PI_COPILOT_RESPONSE");
      } finally {
        await runtime.dispose();
      }
    },
    TIMEOUT_MS,
  );

  test(
    "falls through to pi spawn when findLive returns undefined",
    async () => {
      // let: track calls
      let spawnCalled = false;

      const resolver: AgentResolver = {
        resolve(agentType) {
          if (agentType === "worker") {
            return {
              name: "pi-worker",
              description: "A pi worker",
              manifest: WORKER_MANIFEST,
            };
          }
          return undefined;
        },
        list() {
          return [{ key: "worker", name: "pi-worker", description: "A pi worker" }];
        },
        findLive() {
          return undefined;
        },
      };

      const spawnWithTracking = async (request: TaskSpawnRequest): Promise<TaskSpawnResult> => {
        spawnCalled = true;
        return piSpawn(request);
      };

      const config: TaskSpawnConfig = {
        agentResolver: resolver,
        spawn: spawnWithTracking,
        message: async () => ({ ok: true, output: "should not be called" }),
        defaultAgent: "worker",
        maxDurationMs: 60_000,
      };

      const provider = createTaskSpawnProvider(config);
      const adapter = createTestPiAdapter();

      const runtime = await createKoi({
        manifest: {
          name: "pi-parent-fallthrough",
          version: "0.0.1",
          model: { name: "claude-haiku-4-5-20251001" },
        },
        adapter,
        providers: [provider],
        loopDetection: false,
        limits: { maxTurns: 2, maxDurationMs: 60_000, maxTokens: 50_000 },
      });

      try {
        const taskTool = requireTool(
          runtime.agent.component<Tool>("tool:task" as SubsystemToken<Tool>),
          "task",
        );

        const result = await taskTool.execute({
          description: "Reply with exactly: PI_SPAWNED",
          agent_type: "worker",
        });

        expect(spawnCalled).toBe(true);
        expect(typeof result).toBe("string");
        expect(String(result).toLowerCase()).toContain("pi_spawned");
      } finally {
        await runtime.dispose();
      }
    },
    TIMEOUT_MS,
  );

  test(
    "LLM-driven round-trip with task tool via pi adapter",
    async () => {
      const config: TaskSpawnConfig = {
        agents: new Map([
          [
            "helper",
            {
              name: "pi-helper",
              description: "A helper that answers questions via pi agent",
              manifest: WORKER_MANIFEST,
            },
          ],
        ]),
        spawn: piSpawn,
        defaultAgent: "helper",
        maxDurationMs: 60_000,
      };

      const provider = createTaskSpawnProvider(config);
      const adapter = createTestPiAdapter();

      const runtime = await createKoi({
        manifest: {
          name: "pi-orchestrator",
          version: "0.0.1",
          description: "Orchestrator with task tool via pi adapter",
          model: { name: "claude-haiku-4-5-20251001" },
        },
        adapter,
        providers: [provider],
        loopDetection: false,
        limits: { maxTurns: 4, maxDurationMs: 90_000, maxTokens: 100_000 },
      });

      try {
        // Verify task tool attached
        const taskTool = requireTool(
          runtime.agent.component<Tool>("tool:task" as SubsystemToken<Tool>),
          "task",
        );
        expect(taskTool.descriptor.name).toBe("task");

        // LLM-driven round-trip: ask pi agent to use task tool.
        // Note: This is a smoke test — the LLM may or may not decide to call the tool.
        const events = await collectEvents(
          runtime.run({
            kind: "text",
            text: 'You have a "task" tool available. Use it to delegate this task to the helper: "What is 5 times 6?" Then report the helper\'s answer.',
          }),
        );

        const output = findDoneOutput(events);
        expect(output).toBeDefined();
        if (output === undefined) {
          throw new Error("Expected done event from pi agent");
        }
        expect(output.stopReason).not.toBe("error");

        // Pi adapter delivers text via text_delta events
        const text = extractTextFromEvents(events);
        expect(text.length).toBeGreaterThan(0);

        // Verify metrics
        expect(output.metrics.inputTokens).toBeGreaterThan(0);
        expect(output.metrics.outputTokens).toBeGreaterThan(0);
        expect(output.metrics.turns).toBeGreaterThan(0);
        expect(output.metrics.durationMs).toBeGreaterThan(0);
      } finally {
        await runtime.dispose();
      }
    },
    TIMEOUT_MS,
  );
});
