/**
 * Integration test: ACE self-forge loop.
 *
 * Verifies the full data flow:
 *   record trajectories → consolidate → list_playbooks → verify forge-ready data
 *
 * Uses in-memory stores (no LLM calls) — runs in CI without API keys.
 */

import { describe, expect, test } from "bun:test";
import type { Agent, ProcessId, ProcessState } from "@koi/core";
import type {
  ModelHandler,
  ModelRequest,
  ModelResponse,
  SessionContext,
  ToolHandler,
  ToolRequest,
  ToolResponse,
  TurnContext,
} from "@koi/core/middleware";
import { createAceMiddleware } from "../ace.js";
import { createAceToolsProvider } from "../ace-tools-provider.js";
import { createInMemoryPlaybookStore, createInMemoryTrajectoryStore } from "../stores.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAgent(): Agent {
  const pid: ProcessId = {
    id: "agent-1" as ProcessId["id"],
    name: "test-agent",
    type: "copilot",
    depth: 0,
  } as ProcessId;

  return {
    pid,
    manifest: {} as Agent["manifest"],
    state: "running" as ProcessState,
    component: () => undefined,
    has: () => false,
    hasAll: () => false,
    query: () => new Map(),
    components: () => new Map(),
  };
}

function makeTurnContext(turnIndex: number): TurnContext {
  return { turnIndex } as TurnContext;
}

function makeSessionContext(sessionId: string): SessionContext {
  return { sessionId } as SessionContext;
}

const noopModelHandler: ModelHandler = async (request: ModelRequest): Promise<ModelResponse> => ({
  model: request.model ?? "test-model",
  content: "response",
  usage: { inputTokens: 10, outputTokens: 5 },
});

const noopToolHandler: ToolHandler = async (_request: ToolRequest): Promise<ToolResponse> => ({
  output: "ok",
});

// ---------------------------------------------------------------------------
// Integration test
// ---------------------------------------------------------------------------

describe("ACE self-forge loop", () => {
  test("record trajectories → consolidate → list_playbooks → verify forge-ready data", async () => {
    // 1. Create shared stores
    const trajectoryStore = createInMemoryTrajectoryStore();
    const playbookStore = createInMemoryPlaybookStore();

    // 2. Create ACE middleware with the shared stores
    const ace = createAceMiddleware({
      trajectoryStore,
      playbookStore,
      clock: () => 1000,
    });

    // 3. Simulate multiple sessions to build up trajectory data
    for (let session = 0; session < 3; session++) {
      // Simulate tool calls within a session
      for (let turn = 0; turn < 5; turn++) {
        if (ace.wrapModelCall !== undefined) {
          await ace.wrapModelCall(
            makeTurnContext(turn),
            { model: "test-model", messages: [] },
            noopModelHandler,
          );
        }

        if (ace.wrapToolCall !== undefined) {
          await ace.wrapToolCall(
            makeTurnContext(turn),
            { toolId: "search_web", input: { query: "test" } } as ToolRequest,
            noopToolHandler,
          );
        }
      }

      // End session → triggers consolidation
      if (ace.onSessionEnd !== undefined) {
        await ace.onSessionEnd(makeSessionContext(`session-${String(session)}`));
      }
    }

    // 4. Verify playbooks were consolidated
    const allPlaybooks = await playbookStore.list();
    expect(allPlaybooks.length).toBeGreaterThan(0);

    // 5. Create the ACE tools provider with the same shared store
    const provider = createAceToolsProvider({ playbookStore });
    const components = (await provider.attach(makeAgent())) as Map<string, unknown>;
    const listTool = components.get("tool:list_playbooks") as {
      execute: (args: Record<string, unknown>) => Promise<unknown>;
    };

    // 6. Call list_playbooks — should return the consolidated playbooks
    const result = (await listTool.execute({})) as {
      kind: string;
      count: number;
      playbooks: readonly {
        id: string;
        title: string;
        strategy: string;
        confidence: number;
        tags: readonly string[];
        sessionCount: number;
      }[];
    };

    expect(result.kind).toBe("stat");
    expect(result.count).toBeGreaterThan(0);

    // 7. Verify playbook data is forge-ready (has all fields forge_skill needs)
    const firstPlaybook = result.playbooks[0];
    expect(firstPlaybook).toBeDefined();
    expect(typeof firstPlaybook?.id).toBe("string");
    expect(typeof firstPlaybook?.title).toBe("string");
    expect(typeof firstPlaybook?.strategy).toBe("string");
    expect(typeof firstPlaybook?.confidence).toBe("number");
    expect(firstPlaybook?.confidence).toBeGreaterThan(0);
    expect(firstPlaybook?.sessionCount).toBeGreaterThan(0);
    expect(Array.isArray(firstPlaybook?.tags)).toBe(true);
  });

  test("self-forge skill is attached alongside tool", async () => {
    const provider = createAceToolsProvider({
      playbookStore: createInMemoryPlaybookStore(),
    });
    const components = (await provider.attach(makeAgent())) as Map<string, unknown>;

    // Both tool and skill should be present
    expect(components.has("tool:list_playbooks")).toBe(true);
    expect(components.has("skill:ace-self-forge")).toBe(true);

    // Skill should reference list_playbooks and forge_skill
    const skill = components.get("skill:ace-self-forge") as { content: string };
    expect(skill.content).toContain("list_playbooks");
    expect(skill.content).toContain("forge_skill");
    expect(skill.content).toContain("forge_tool");
  });

  test("list_playbooks with minConfidence filters low-confidence playbooks", async () => {
    const playbookStore = createInMemoryPlaybookStore();

    // Manually save playbooks with varying confidence
    await playbookStore.save({
      id: "pb-high",
      title: "High Confidence",
      strategy: "Always works",
      tags: ["reliable"],
      confidence: 0.9,
      source: "curated",
      createdAt: 1000,
      updatedAt: 1000,
      sessionCount: 10,
    });
    await playbookStore.save({
      id: "pb-low",
      title: "Low Confidence",
      strategy: "Sometimes works",
      tags: ["experimental"],
      confidence: 0.2,
      source: "curated",
      createdAt: 1000,
      updatedAt: 1000,
      sessionCount: 2,
    });

    const provider = createAceToolsProvider({ playbookStore });
    const components = (await provider.attach(makeAgent())) as Map<string, unknown>;
    const listTool = components.get("tool:list_playbooks") as {
      execute: (args: Record<string, unknown>) => Promise<unknown>;
    };

    // Filter for forge-worthy playbooks (confidence >= 0.7)
    const result = (await listTool.execute({ minConfidence: 0.7 })) as {
      count: number;
      playbooks: readonly { id: string; confidence: number }[];
    };

    expect(result.count).toBe(1);
    expect(result.playbooks[0]?.id).toBe("pb-high");
    expect(result.playbooks[0]?.confidence).toBe(0.9);
  });
});
