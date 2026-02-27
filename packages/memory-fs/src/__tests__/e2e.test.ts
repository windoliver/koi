/**
 * End-to-end tests for @koi/memory-fs wired through the full createKoi +
 * createLoopAdapter runtime assembly.
 *
 * Architecture: the agent decides what to remember via memory_store /
 * memory_recall tools (NOT auto-storing middleware). Tools are attached
 * via ComponentProvider + toolToken, the same pattern as @koi/code-mode.
 *
 * Test structure:
 *   - Tool wiring tests: verify memory tools are correctly attached to the
 *     agent entity and execute against FsMemory (no LLM calls needed)
 *   - LLM integration tests: verify the full createKoi pipeline runs with
 *     memory tools registered and FsMemory persists across sessions
 *
 * Gated on ANTHROPIC_API_KEY + E2E_TESTS=1 — tests are skipped when either
 * is missing. Run:
 *   E2E_TESTS=1 bun test src/__tests__/e2e.test.ts
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  Agent,
  ComponentProvider,
  EngineEvent,
  EngineOutput,
  JsonObject,
  ModelRequest,
  Tool,
} from "@koi/core";
import { MEMORY, toolToken } from "@koi/core";
import { createKoi } from "@koi/engine";
import { createLoopAdapter } from "@koi/engine-loop";
import { createAnthropicAdapter } from "@koi/model-router";
import { createFsMemory } from "../../src/fs-memory.js";
import type { FsMemory } from "../../src/types.js";

// ---------------------------------------------------------------------------
// Environment gate
// ---------------------------------------------------------------------------

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY ?? "";
const HAS_KEY = ANTHROPIC_KEY.length > 0;
const E2E_OPTED_IN = process.env.E2E_TESTS === "1";
const describeE2E = HAS_KEY && E2E_OPTED_IN ? describe : describe.skip;

const TIMEOUT_MS = 120_000;

// ---------------------------------------------------------------------------
// Tool factories: memory_store + memory_recall backed by FsMemory
// ---------------------------------------------------------------------------

function createMemoryStoreTool(fsMemory: FsMemory): Tool {
  return {
    descriptor: {
      name: "memory_store",
      description:
        "Store a fact in long-term memory. Use this when the user shares important information worth remembering.",
      inputSchema: {
        type: "object",
        properties: {
          content: { type: "string", description: "The fact to remember." },
          category: {
            type: "string",
            description: "Category: preference, context, milestone, decision.",
          },
          entities: {
            type: "array",
            items: { type: "string" },
            description: "Related entity names.",
          },
        },
        required: ["content"],
      },
    },
    trustTier: "verified",
    async execute(args: JsonObject): Promise<unknown> {
      const content = args.content as string;
      const category = (args.category as string | undefined) ?? "context";
      const entities = (args.entities as readonly string[] | undefined) ?? [];
      await fsMemory.component.store(content, {
        category,
        ...(entities.length > 0 ? { relatedEntities: [...entities] } : {}),
      });
      return { stored: true, content };
    },
  };
}

function createMemoryRecallTool(fsMemory: FsMemory): Tool {
  return {
    descriptor: {
      name: "memory_recall",
      description: "Recall facts from long-term memory by search query.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query." },
          limit: { type: "number", description: "Max results. Default: 5." },
        },
        required: ["query"],
      },
    },
    trustTier: "verified",
    async execute(args: JsonObject): Promise<unknown> {
      const query = args.query as string;
      const limit = (args.limit as number | undefined) ?? 5;
      const results = await fsMemory.component.recall(query, { limit });
      return {
        count: results.length,
        memories: results.map((r) => ({
          content: r.content,
          tier: r.tier,
          decayScore: r.decayScore,
        })),
      };
    },
  };
}

/** ComponentProvider that attaches MEMORY token + memory_store / memory_recall tools. */
function createMemoryProvider(fsMemory: FsMemory): ComponentProvider {
  return {
    name: "fs-memory",
    async attach(_agent: Agent): Promise<ReadonlyMap<string, unknown>> {
      const storeTool = createMemoryStoreTool(fsMemory);
      const recallTool = createMemoryRecallTool(fsMemory);
      return new Map<string, unknown>([
        [MEMORY as string, fsMemory.component],
        [toolToken("memory_store") as string, storeTool],
        [toolToken("memory_recall") as string, recallTool],
      ]);
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function collectEvents(
  iterable: AsyncIterable<EngineEvent>,
): Promise<readonly EngineEvent[]> {
  // let — accumulates events from async iteration
  let events: readonly EngineEvent[] = [];
  for await (const event of iterable) {
    events = [...events, event];
  }
  return events;
}

function findDoneOutput(events: readonly EngineEvent[]): EngineOutput | undefined {
  const done = events.find((e): e is EngineEvent & { readonly kind: "done" } => e.kind === "done");
  return done?.output;
}

function extractTextFromEvents(events: readonly EngineEvent[]): string {
  return events
    .filter((e): e is EngineEvent & { readonly kind: "text_delta" } => e.kind === "text_delta")
    .map((e) => e.delta)
    .join("");
}

// ---------------------------------------------------------------------------
// Tests: Tool wiring through createKoi assembly
// ---------------------------------------------------------------------------

describeE2E("e2e: memory-fs tool wiring through createKoi", () => {
  // let — needed for mutable test directory and memory refs
  let testDir: string;
  let fsMemory: FsMemory;

  const anthropicAdapter = createAnthropicAdapter({ apiKey: ANTHROPIC_KEY });
  const modelCall = (request: ModelRequest) =>
    anthropicAdapter.complete({ ...request, model: "claude-haiku-4-5-20251001" });

  beforeEach(async () => {
    testDir = join(
      tmpdir(),
      `koi-memory-fs-e2e-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(testDir, { recursive: true });
    fsMemory = await createFsMemory({ baseDir: testDir });
  });

  afterEach(async () => {
    await fsMemory.close();
    rmSync(testDir, { recursive: true, force: true });
  });

  test(
    "MEMORY token + tools are attached to the assembled agent entity",
    async () => {
      const provider = createMemoryProvider(fsMemory);
      const adapter = createLoopAdapter({ modelCall, maxTurns: 1 });

      const runtime = await createKoi({
        manifest: {
          name: "e2e-wiring-agent",
          version: "0.0.0",
          model: { name: "claude-haiku-4-5-20251001" },
        },
        adapter,
        providers: [provider],
      });

      // MEMORY component is attached
      const memoryComponent = runtime.agent.component(MEMORY);
      expect(memoryComponent).toBeDefined();
      expect(typeof memoryComponent?.recall).toBe("function");
      expect(typeof memoryComponent?.store).toBe("function");

      // Tools are attached
      const storeTool = runtime.agent.component<Tool>(toolToken("memory_store"));
      const recallTool = runtime.agent.component<Tool>(toolToken("memory_recall"));
      expect(storeTool).toBeDefined();
      expect(recallTool).toBeDefined();
      expect(storeTool?.descriptor.name).toBe("memory_store");
      expect(recallTool?.descriptor.name).toBe("memory_recall");

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );

  test(
    "memory_store tool persists facts to disk via FsMemory",
    async () => {
      const provider = createMemoryProvider(fsMemory);
      const adapter = createLoopAdapter({ modelCall, maxTurns: 1 });

      const runtime = await createKoi({
        manifest: {
          name: "e2e-store-tool-agent",
          version: "0.0.0",
          model: { name: "claude-haiku-4-5-20251001" },
        },
        adapter,
        providers: [provider],
      });

      // Execute the tool directly (as the ReAct loop would)
      const storeTool = runtime.agent.component<Tool>(toolToken("memory_store"));
      expect(storeTool).toBeDefined();

      const result = await storeTool?.execute({
        content: "The user's favorite language is Rust",
        category: "preference",
        entities: ["user"],
      });

      expect(result).toEqual({
        stored: true,
        content: "The user's favorite language is Rust",
      });

      // Verify persisted in FsMemory
      const recalled = await fsMemory.component.recall("Rust");
      expect(recalled.length).toBeGreaterThan(0);
      expect(recalled[0]?.content).toBe("The user's favorite language is Rust");

      // Verify on-disk persistence
      const entities = await fsMemory.listEntities();
      expect(entities).toContain("user");

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );

  test(
    "memory_recall tool retrieves pre-stored facts with tier info",
    async () => {
      // Pre-seed facts
      await fsMemory.component.store("Alice prefers cats", {
        relatedEntities: ["alice"],
        category: "preference",
      });
      await fsMemory.component.store("Bob likes dogs", {
        relatedEntities: ["bob"],
        category: "preference",
      });

      const provider = createMemoryProvider(fsMemory);
      const adapter = createLoopAdapter({ modelCall, maxTurns: 1 });

      const runtime = await createKoi({
        manifest: {
          name: "e2e-recall-tool-agent",
          version: "0.0.0",
          model: { name: "claude-haiku-4-5-20251001" },
        },
        adapter,
        providers: [provider],
      });

      const recallTool = runtime.agent.component<Tool>(toolToken("memory_recall"));
      expect(recallTool).toBeDefined();

      const result = (await recallTool?.execute({ query: "Alice prefers cats" })) as {
        readonly count: number;
        readonly memories: readonly {
          readonly content: string;
          readonly tier: string;
          readonly decayScore: number;
        }[];
      };

      expect(result.count).toBeGreaterThan(0);
      // BM25-only mode: check that our fact is somewhere in the results
      const catFact = result.memories.find((m) => m.content.includes("cats"));
      expect(catFact).toBeDefined();
      expect(catFact?.tier).toBe("hot"); // Fresh fact
      expect(catFact?.decayScore).toBeGreaterThan(0.9);

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );

  test(
    "store → recall round-trip through tools within assembled agent",
    async () => {
      const provider = createMemoryProvider(fsMemory);
      const adapter = createLoopAdapter({ modelCall, maxTurns: 1 });

      const runtime = await createKoi({
        manifest: {
          name: "e2e-roundtrip-agent",
          version: "0.0.0",
          model: { name: "claude-haiku-4-5-20251001" },
        },
        adapter,
        providers: [provider],
      });

      const storeTool = runtime.agent.component<Tool>(toolToken("memory_store"));
      const recallTool = runtime.agent.component<Tool>(toolToken("memory_recall"));

      // Store via tool
      await storeTool?.execute({
        content: "Project deadline is March 15, 2026",
        category: "milestone",
        entities: ["project-alpha"],
      });

      // Recall via tool
      const result = (await recallTool?.execute({ query: "deadline" })) as {
        readonly count: number;
        readonly memories: readonly { readonly content: string }[];
      };

      expect(result.count).toBe(1);
      expect(result.memories[0]?.content).toContain("March 15");

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );

  test(
    "dedup prevents duplicate storage through tools",
    async () => {
      const provider = createMemoryProvider(fsMemory);
      const adapter = createLoopAdapter({ modelCall, maxTurns: 1 });

      const runtime = await createKoi({
        manifest: {
          name: "e2e-dedup-agent",
          version: "0.0.0",
          model: { name: "claude-haiku-4-5-20251001" },
        },
        adapter,
        providers: [provider],
      });

      const storeTool = runtime.agent.component<Tool>(toolToken("memory_store"));

      // Store the same fact twice
      await storeTool?.execute({
        content: "The API endpoint is /v2/users",
        category: "context",
        entities: ["api"],
      });
      await storeTool?.execute({
        content: "The API endpoint is /v2/users",
        category: "context",
        entities: ["api"],
      });

      const results = await fsMemory.component.recall("API endpoint");
      expect(results).toHaveLength(1);

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );

  test(
    "contradiction supersedes old fact through tools",
    async () => {
      const provider = createMemoryProvider(fsMemory);
      const adapter = createLoopAdapter({ modelCall, maxTurns: 1 });

      const runtime = await createKoi({
        manifest: {
          name: "e2e-contradict-agent",
          version: "0.0.0",
          model: { name: "claude-haiku-4-5-20251001" },
        },
        adapter,
        providers: [provider],
      });

      const storeTool = runtime.agent.component<Tool>(toolToken("memory_store"));

      await storeTool?.execute({
        content: "Alice prefers dogs",
        category: "preference",
        entities: ["alice"],
      });
      await storeTool?.execute({
        content: "Alice now prefers cats",
        category: "preference",
        entities: ["alice"],
      });

      const results = await fsMemory.component.recall("preference");
      expect(results).toHaveLength(1);
      expect(results[0]?.content).toBe("Alice now prefers cats");

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );

  test(
    "tier distribution reflects tool-stored facts",
    async () => {
      const provider = createMemoryProvider(fsMemory);
      const adapter = createLoopAdapter({ modelCall, maxTurns: 1 });

      const runtime = await createKoi({
        manifest: {
          name: "e2e-tier-agent",
          version: "0.0.0",
          model: { name: "claude-haiku-4-5-20251001" },
        },
        adapter,
        providers: [provider],
      });

      const storeTool = runtime.agent.component<Tool>(toolToken("memory_store"));

      await storeTool?.execute({
        content: "Alice prefers TypeScript",
        category: "preference",
        entities: ["alice"],
      });
      await storeTool?.execute({
        content: "Bob likes Rust",
        category: "preference",
        entities: ["bob"],
      });
      await storeTool?.execute({
        content: "The project uses Bun",
        category: "context",
        entities: ["project"],
      });

      const dist = await fsMemory.getTierDistribution();
      expect(dist.total).toBe(3);
      expect(dist.hot).toBe(3);

      const entities = await fsMemory.listEntities();
      expect(entities).toContain("alice");
      expect(entities).toContain("bob");
      expect(entities).toContain("project");

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );

  test(
    "rebuildSummaries generates summary.md after tool-based storage",
    async () => {
      const provider = createMemoryProvider(fsMemory);
      const adapter = createLoopAdapter({ modelCall, maxTurns: 1 });

      const runtime = await createKoi({
        manifest: {
          name: "e2e-summary-agent",
          version: "0.0.0",
          model: { name: "claude-haiku-4-5-20251001" },
        },
        adapter,
        providers: [provider],
      });

      const storeTool = runtime.agent.component<Tool>(toolToken("memory_store"));

      await storeTool?.execute({
        content: "Project Neptune is a secret initiative",
        category: "context",
        entities: ["project-neptune"],
      });
      await storeTool?.execute({
        content: "Neptune launch date is Q3 2026",
        category: "milestone",
        entities: ["project-neptune"],
      });

      await fsMemory.rebuildSummaries();

      const summaryPath = join(testDir, "entities", "project-neptune", "summary.md");
      expect(existsSync(summaryPath)).toBe(true);

      const content = readFileSync(summaryPath, "utf-8");
      expect(content.toLowerCase()).toContain("neptune");

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );

  test(
    "facts persist across close → reopen → new createKoi assembly",
    async () => {
      const provider1 = createMemoryProvider(fsMemory);
      const adapter1 = createLoopAdapter({ modelCall, maxTurns: 1 });

      const runtime1 = await createKoi({
        manifest: {
          name: "e2e-persist-agent-1",
          version: "0.0.0",
          model: { name: "claude-haiku-4-5-20251001" },
        },
        adapter: adapter1,
        providers: [provider1],
      });

      // Store via tool in session 1
      const storeTool = runtime1.agent.component<Tool>(toolToken("memory_store"));
      const marker = `marker-${Date.now()}`;
      await storeTool?.execute({
        content: `Build number is ${marker}`,
        category: "context",
        entities: ["build"],
      });

      await runtime1.dispose();
      await fsMemory.close();

      // Reopen from disk (simulates process restart)
      const reopened = await createFsMemory({ baseDir: testDir });
      const provider2 = createMemoryProvider(reopened);
      const adapter2 = createLoopAdapter({ modelCall, maxTurns: 1 });

      const runtime2 = await createKoi({
        manifest: {
          name: "e2e-persist-agent-2",
          version: "0.0.0",
          model: { name: "claude-haiku-4-5-20251001" },
        },
        adapter: adapter2,
        providers: [provider2],
      });

      // Recall via tool in session 2
      const recallTool = runtime2.agent.component<Tool>(toolToken("memory_recall"));
      const result = (await recallTool?.execute({ query: marker })) as {
        readonly count: number;
        readonly memories: readonly {
          readonly content: string;
          readonly tier: string;
          readonly decayScore: number;
        }[];
      };

      expect(result.count).toBeGreaterThan(0);
      expect(result.memories[0]?.content).toContain(marker);
      expect(result.memories[0]?.tier).toBe("hot");

      await runtime2.dispose();
      await reopened.close();

      // Reassign for afterEach cleanup
      fsMemory = await createFsMemory({ baseDir: testDir });
    },
    TIMEOUT_MS,
  );

  test(
    "LLM runs through createKoi with memory tools registered",
    async () => {
      const provider = createMemoryProvider(fsMemory);
      const adapter = createLoopAdapter({ modelCall, maxTurns: 3 });

      const runtime = await createKoi({
        manifest: {
          name: "e2e-llm-agent",
          version: "0.0.0",
          model: { name: "claude-haiku-4-5-20251001" },
        },
        adapter,
        providers: [provider],
      });

      // Pre-seed a fact so memory is non-empty
      await fsMemory.component.store("The user's name is Alice", {
        relatedEntities: ["user"],
        category: "context",
      });

      const events = await collectEvents(
        runtime.run({
          kind: "text",
          text: "Say hello. Reply briefly.",
        }),
      );

      const output = findDoneOutput(events);
      expect(output).toBeDefined();
      expect(output?.stopReason).toBe("completed");

      const text = extractTextFromEvents(events);
      expect(text.length).toBeGreaterThan(0);

      // Verify agent had memory tools registered (even if LLM didn't call them)
      const storeTool = runtime.agent.component<Tool>(toolToken("memory_store"));
      expect(storeTool).toBeDefined();

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );
});
