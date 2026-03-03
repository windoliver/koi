/**
 * End-to-end tests for @koi/memory-fs wired through the full createKoi +
 * createPiAdapter runtime assembly using the new createMemoryProvider.
 *
 * Architecture: the agent decides what to remember via memory_store /
 * memory_recall / memory_search tools (NOT auto-storing middleware). Tools
 * and skill are attached via createMemoryProvider ComponentProvider.
 *
 * Test structure:
 *   - Tool wiring: verify all 3 tools + skill + MEMORY token attached
 *   - Tool execution: verify each tool executes against FsMemory
 *   - Backend behaviors: dedup, contradiction, tiers, persistence
 *   - LLM integration: full createKoi + createPiAdapter with real model calls
 *
 * Gated on ANTHROPIC_API_KEY + E2E_TESTS=1 — tests are skipped when either
 * is missing. Run:
 *   E2E_TESTS=1 bun test src/__tests__/e2e.test.ts
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EngineEvent, EngineOutput, MemoryResult, Tool } from "@koi/core";
import { MEMORY, skillToken, toolToken } from "@koi/core";
import { createKoi } from "@koi/engine";
import { createPiAdapter } from "@koi/engine-pi";
import { createFsMemory } from "../fs-memory.js";
import { createMemoryProvider } from "../provider/memory-component-provider.js";
import type { FsMemory } from "../types.js";

// ---------------------------------------------------------------------------
// Environment gate
// ---------------------------------------------------------------------------

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY ?? "";
const HAS_KEY = ANTHROPIC_KEY.length > 0;
const E2E_OPTED_IN = process.env.E2E_TESTS === "1";
const describeE2E = HAS_KEY && E2E_OPTED_IN ? describe : describe.skip;

const TIMEOUT_MS = 120_000;

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

function findToolCallEvents(
  events: readonly EngineEvent[],
  toolName: string,
): readonly (EngineEvent & { readonly kind: "tool_call_start" })[] {
  return events.filter(
    (e): e is EngineEvent & { readonly kind: "tool_call_start" } =>
      e.kind === "tool_call_start" && e.toolName === toolName,
  );
}

// ---------------------------------------------------------------------------
// Tests: Provider wiring through createKoi assembly
// ---------------------------------------------------------------------------

describeE2E("e2e: memory-fs provider through createKoi", () => {
  // let — needed for mutable test directory and memory refs
  let testDir: string;
  let fsMemory: FsMemory;

  const PI_MODEL = "anthropic:claude-haiku-4-5-20251001";

  function createAdapter(): ReturnType<typeof createPiAdapter> {
    return createPiAdapter({
      model: PI_MODEL,
      getApiKey: () => ANTHROPIC_KEY,
      thinkingLevel: "off",
    });
  }

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

  // -----------------------------------------------------------------------
  // Component wiring
  // -----------------------------------------------------------------------

  test(
    "createMemoryProvider attaches MEMORY token + 3 tools + skill to agent",
    async () => {
      const provider = createMemoryProvider({ memory: fsMemory });
      const adapter = createAdapter();

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

      // All 3 tools are attached
      const storeTool = runtime.agent.component<Tool>(toolToken("memory_store"));
      const recallTool = runtime.agent.component<Tool>(toolToken("memory_recall"));
      const searchTool = runtime.agent.component<Tool>(toolToken("memory_search"));
      expect(storeTool).toBeDefined();
      expect(recallTool).toBeDefined();
      expect(searchTool).toBeDefined();
      expect(storeTool?.descriptor.name).toBe("memory_store");
      expect(recallTool?.descriptor.name).toBe("memory_recall");
      expect(searchTool?.descriptor.name).toBe("memory_search");

      // Skill component is attached (skillToken narrows to SkillMetadata)
      const skill = runtime.agent.component(skillToken("memory"));
      expect(skill).toBeDefined();
      expect(skill?.name).toBe("memory");
      // Access content via the broader map (SkillComponent extends SkillMetadata)
      const skillFull = runtime.agent.components().get(skillToken("memory") as string) as
        | { readonly content: string }
        | undefined;
      expect(skillFull?.content).toContain("memory_store");
      expect(skillFull?.content).toContain("memory_recall");
      expect(skillFull?.content).toContain("memory_search");

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );

  test(
    "custom prefix changes tool names",
    async () => {
      const provider = createMemoryProvider({ memory: fsMemory, prefix: "mem" });
      const adapter = createAdapter();

      const runtime = await createKoi({
        manifest: {
          name: "e2e-prefix-agent",
          version: "0.0.0",
          model: { name: "claude-haiku-4-5-20251001" },
        },
        adapter,
        providers: [provider],
      });

      expect(runtime.agent.component<Tool>(toolToken("mem_store"))).toBeDefined();
      expect(runtime.agent.component<Tool>(toolToken("mem_recall"))).toBeDefined();
      expect(runtime.agent.component<Tool>(toolToken("mem_search"))).toBeDefined();
      expect(runtime.agent.component<Tool>(toolToken("memory_store"))).toBeUndefined();

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );

  test(
    "operations subset limits attached tools",
    async () => {
      const provider = createMemoryProvider({
        memory: fsMemory,
        operations: ["store", "recall"],
      });
      const adapter = createAdapter();

      const runtime = await createKoi({
        manifest: {
          name: "e2e-ops-agent",
          version: "0.0.0",
          model: { name: "claude-haiku-4-5-20251001" },
        },
        adapter,
        providers: [provider],
      });

      expect(runtime.agent.component<Tool>(toolToken("memory_store"))).toBeDefined();
      expect(runtime.agent.component<Tool>(toolToken("memory_recall"))).toBeDefined();
      expect(runtime.agent.component<Tool>(toolToken("memory_search"))).toBeUndefined();

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );

  // -----------------------------------------------------------------------
  // Tool execution: memory_store
  // -----------------------------------------------------------------------

  test(
    "memory_store persists facts to disk via FsMemory",
    async () => {
      const provider = createMemoryProvider({ memory: fsMemory });
      const adapter = createAdapter();

      const runtime = await createKoi({
        manifest: {
          name: "e2e-store-tool-agent",
          version: "0.0.0",
          model: { name: "claude-haiku-4-5-20251001" },
        },
        adapter,
        providers: [provider],
      });

      const storeTool = runtime.agent.component<Tool>(toolToken("memory_store"));
      expect(storeTool).toBeDefined();

      const result = await storeTool?.execute({
        content: "The user's favorite language is Rust",
        category: "preference",
        related_entities: ["user"],
      });

      expect(result).toEqual({ stored: true });

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

  // -----------------------------------------------------------------------
  // Tool execution: memory_recall
  // -----------------------------------------------------------------------

  test(
    "memory_recall retrieves pre-stored facts with tier info",
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

      const provider = createMemoryProvider({ memory: fsMemory });
      const adapter = createAdapter();

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
        readonly results: readonly MemoryResult[];
      };

      expect(result.count).toBeGreaterThan(0);
      const catFact = result.results.find((m) => m.content.includes("cats"));
      expect(catFact).toBeDefined();
      expect(catFact?.tier).toBe("hot");
      expect(catFact?.decayScore).toBeGreaterThan(0.9);

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );

  // -----------------------------------------------------------------------
  // Tool execution: memory_search
  // -----------------------------------------------------------------------

  test(
    "memory_search lists entities when no entity param",
    async () => {
      await fsMemory.component.store("Alice likes TypeScript", {
        relatedEntities: ["alice"],
      });
      await fsMemory.component.store("Bob uses Rust", {
        relatedEntities: ["bob"],
      });

      const provider = createMemoryProvider({ memory: fsMemory });
      const adapter = createAdapter();

      const runtime = await createKoi({
        manifest: {
          name: "e2e-search-list-agent",
          version: "0.0.0",
          model: { name: "claude-haiku-4-5-20251001" },
        },
        adapter,
        providers: [provider],
      });

      const searchTool = runtime.agent.component<Tool>(toolToken("memory_search"));
      expect(searchTool).toBeDefined();

      const result = (await searchTool?.execute({})) as {
        readonly entities: readonly string[];
      };

      expect(result.entities).toContain("alice");
      expect(result.entities).toContain("bob");

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );

  test(
    "memory_search returns facts for a specific entity",
    async () => {
      await fsMemory.component.store("Alice likes TypeScript", {
        relatedEntities: ["alice"],
      });

      const provider = createMemoryProvider({ memory: fsMemory });
      const adapter = createAdapter();

      const runtime = await createKoi({
        manifest: {
          name: "e2e-search-entity-agent",
          version: "0.0.0",
          model: { name: "claude-haiku-4-5-20251001" },
        },
        adapter,
        providers: [provider],
      });

      const searchTool = runtime.agent.component<Tool>(toolToken("memory_search"));
      const result = (await searchTool?.execute({ entity: "alice" })) as {
        readonly count: number;
        readonly results: readonly MemoryResult[];
      };

      expect(result.count).toBeGreaterThan(0);
      expect(result.results[0]?.content).toContain("TypeScript");

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );

  // -----------------------------------------------------------------------
  // Store → recall round-trip
  // -----------------------------------------------------------------------

  test(
    "store → recall round-trip through tools within assembled agent",
    async () => {
      const provider = createMemoryProvider({ memory: fsMemory });
      const adapter = createAdapter();

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
        related_entities: ["project-alpha"],
      });

      // Recall via tool
      const result = (await recallTool?.execute({ query: "deadline" })) as {
        readonly count: number;
        readonly results: readonly MemoryResult[];
      };

      expect(result.count).toBe(1);
      expect(result.results[0]?.content).toContain("March 15");

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );

  // -----------------------------------------------------------------------
  // Backend behaviors through tools
  // -----------------------------------------------------------------------

  test(
    "dedup prevents duplicate storage through tools",
    async () => {
      const provider = createMemoryProvider({ memory: fsMemory });
      const adapter = createAdapter();

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

      await storeTool?.execute({
        content: "The API endpoint is /v2/users",
        category: "context",
        related_entities: ["api"],
      });
      await storeTool?.execute({
        content: "The API endpoint is /v2/users",
        category: "context",
        related_entities: ["api"],
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
      const provider = createMemoryProvider({ memory: fsMemory });
      const adapter = createAdapter();

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
        related_entities: ["alice"],
      });
      await storeTool?.execute({
        content: "Alice now prefers cats",
        category: "preference",
        related_entities: ["alice"],
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
      const provider = createMemoryProvider({ memory: fsMemory });
      const adapter = createAdapter();

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
        related_entities: ["alice"],
      });
      await storeTool?.execute({
        content: "Bob likes Rust",
        category: "preference",
        related_entities: ["bob"],
      });
      await storeTool?.execute({
        content: "The project uses Bun",
        category: "context",
        related_entities: ["project"],
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
      const provider = createMemoryProvider({ memory: fsMemory });
      const adapter = createAdapter();

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
        related_entities: ["project-neptune"],
      });
      await storeTool?.execute({
        content: "Neptune launch date is Q3 2026",
        category: "milestone",
        related_entities: ["project-neptune"],
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

  // -----------------------------------------------------------------------
  // Cross-session persistence
  // -----------------------------------------------------------------------

  test(
    "facts persist across close → reopen → new createKoi assembly",
    async () => {
      const provider1 = createMemoryProvider({ memory: fsMemory });
      const adapter1 = createAdapter();

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
        related_entities: ["build"],
      });

      await runtime1.dispose();
      await fsMemory.close();

      // Reopen from disk (simulates process restart)
      const reopened = await createFsMemory({ baseDir: testDir });
      const provider2 = createMemoryProvider({ memory: reopened });
      const adapter2 = createAdapter();

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
        readonly results: readonly MemoryResult[];
      };

      expect(result.count).toBeGreaterThan(0);
      expect(result.results[0]?.content).toContain(marker);
      expect(result.results[0]?.tier).toBe("hot");

      // Also verify memory_search in session 2
      const searchTool = runtime2.agent.component<Tool>(toolToken("memory_search"));
      const searchResult = (await searchTool?.execute({})) as {
        readonly entities: readonly string[];
      };
      expect(searchResult.entities).toContain("build");

      await runtime2.dispose();
      await reopened.close();

      // Reassign for afterEach cleanup
      fsMemory = await createFsMemory({ baseDir: testDir });
    },
    TIMEOUT_MS,
  );

  // -----------------------------------------------------------------------
  // LLM integration: full pipeline with real model calls
  // -----------------------------------------------------------------------

  test(
    "LLM single-turn response with memory tools registered",
    async () => {
      const provider = createMemoryProvider({ memory: fsMemory });
      const adapter = createAdapter();

      const runtime = await createKoi({
        manifest: {
          name: "e2e-llm-basic-agent",
          version: "0.0.0",
          model: { name: "claude-haiku-4-5-20251001" },
        },
        adapter,
        providers: [provider],
        limits: { maxTurns: 3, maxDurationMs: 60_000 },
      });

      const events = await collectEvents(
        runtime.run({
          kind: "text",
          text: "Say hello. Reply with one short sentence only.",
        }),
      );

      const output = findDoneOutput(events);
      expect(output).toBeDefined();
      expect(output?.stopReason).toBe("completed");

      const text = extractTextFromEvents(events);
      expect(text.length).toBeGreaterThan(0);

      // Verify agent had all memory tools registered
      expect(runtime.agent.component<Tool>(toolToken("memory_store"))).toBeDefined();
      expect(runtime.agent.component<Tool>(toolToken("memory_recall"))).toBeDefined();
      expect(runtime.agent.component<Tool>(toolToken("memory_search"))).toBeDefined();

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );

  test(
    "LLM stores a fact via memory_store when instructed",
    async () => {
      const provider = createMemoryProvider({ memory: fsMemory });
      const adapter = createAdapter();

      const runtime = await createKoi({
        manifest: {
          name: "e2e-llm-store-agent",
          version: "0.0.0",
          model: { name: "claude-haiku-4-5-20251001" },
        },
        adapter,
        providers: [provider],
        loopDetection: false,
        limits: { maxTurns: 5, maxDurationMs: 60_000 },
      });

      const events = await collectEvents(
        runtime.run({
          kind: "text",
          text: 'Use the memory_store tool to store this fact: "The project codename is Phoenix". Use category "context" and related_entities ["project"]. Then confirm you stored it.',
        }),
      );

      const output = findDoneOutput(events);
      expect(output).toBeDefined();
      expect(output?.stopReason).toBe("completed");

      // Verify the LLM actually called memory_store
      const storeCalls = findToolCallEvents(events, "memory_store");
      expect(storeCalls.length).toBeGreaterThanOrEqual(1);

      // Verify fact was persisted to disk
      const recalled = await fsMemory.component.recall("Phoenix");
      expect(recalled.length).toBeGreaterThan(0);
      expect(recalled[0]?.content).toContain("Phoenix");

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );

  test(
    "LLM recalls pre-stored facts via memory_recall when asked",
    async () => {
      // Pre-seed a fact
      await fsMemory.component.store("The secret password is swordfish42", {
        category: "context",
        relatedEntities: ["security"],
      });

      const provider = createMemoryProvider({ memory: fsMemory });
      const adapter = createAdapter();

      const runtime = await createKoi({
        manifest: {
          name: "e2e-llm-recall-agent",
          version: "0.0.0",
          model: { name: "claude-haiku-4-5-20251001" },
        },
        adapter,
        providers: [provider],
        loopDetection: false,
        limits: { maxTurns: 5, maxDurationMs: 60_000 },
      });

      const events = await collectEvents(
        runtime.run({
          kind: "text",
          text: 'Use the memory_recall tool with query "password" to search your memory, then tell me what you found.',
        }),
      );

      const output = findDoneOutput(events);
      expect(output).toBeDefined();
      expect(output?.stopReason).toBe("completed");

      // Verify the LLM called memory_recall
      const recallCalls = findToolCallEvents(events, "memory_recall");
      expect(recallCalls.length).toBeGreaterThanOrEqual(1);

      // The model should mention the password in its response
      const text = extractTextFromEvents(events);
      expect(text.toLowerCase()).toContain("swordfish42");

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );

  test(
    "LLM uses memory_search to list entities",
    async () => {
      // Pre-seed facts for multiple entities
      await fsMemory.component.store("Alice is the CTO", {
        relatedEntities: ["alice"],
        category: "relationship",
      });
      await fsMemory.component.store("Bob is the lead engineer", {
        relatedEntities: ["bob"],
        category: "relationship",
      });

      const provider = createMemoryProvider({ memory: fsMemory });
      const adapter = createAdapter();

      const runtime = await createKoi({
        manifest: {
          name: "e2e-llm-search-agent",
          version: "0.0.0",
          model: { name: "claude-haiku-4-5-20251001" },
        },
        adapter,
        providers: [provider],
        loopDetection: false,
        limits: { maxTurns: 5, maxDurationMs: 60_000 },
      });

      const events = await collectEvents(
        runtime.run({
          kind: "text",
          text: "Use the memory_search tool (with no arguments) to list all entities you know about, then tell me who they are.",
        }),
      );

      const output = findDoneOutput(events);
      expect(output).toBeDefined();
      expect(output?.stopReason).toBe("completed");

      // Verify the LLM called memory_search
      const searchCalls = findToolCallEvents(events, "memory_search");
      expect(searchCalls.length).toBeGreaterThanOrEqual(1);

      // The model should mention both entities
      const text = extractTextFromEvents(events).toLowerCase();
      expect(text).toContain("alice");
      expect(text).toContain("bob");

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );

  test(
    "full workflow: store → search → recall across tool calls",
    async () => {
      const provider = createMemoryProvider({ memory: fsMemory });
      const adapter = createAdapter();

      const runtime = await createKoi({
        manifest: {
          name: "e2e-llm-workflow-agent",
          version: "0.0.0",
          model: { name: "claude-haiku-4-5-20251001" },
        },
        adapter,
        providers: [provider],
        loopDetection: false,
        limits: { maxTurns: 10, maxDurationMs: 90_000 },
      });

      const events = await collectEvents(
        runtime.run({
          kind: "text",
          text: [
            "Do these steps in order:",
            '1. Use memory_store to store: "The team standup is at 9am" with category "context" and related_entities ["team"]',
            '2. Use memory_store to store: "Sprint ends on Friday" with category "milestone" and related_entities ["team"]',
            "3. Use memory_search with no arguments to list all entities",
            '4. Use memory_recall with query "standup" to find the standup time',
            "5. Tell me what you found in step 4",
          ].join("\n"),
        }),
      );

      const output = findDoneOutput(events);
      expect(output).toBeDefined();
      expect(output?.stopReason).toBe("completed");

      // Verify all tools were called
      const storeCalls = findToolCallEvents(events, "memory_store");
      const searchCalls = findToolCallEvents(events, "memory_search");
      const recallCalls = findToolCallEvents(events, "memory_recall");

      expect(storeCalls.length).toBeGreaterThanOrEqual(2);
      expect(searchCalls.length).toBeGreaterThanOrEqual(1);
      expect(recallCalls.length).toBeGreaterThanOrEqual(1);

      // Verify facts actually persisted
      const dist = await fsMemory.getTierDistribution();
      expect(dist.total).toBe(2);

      // Verify the model mentioned the standup
      const text = extractTextFromEvents(events).toLowerCase();
      expect(text).toContain("9am");

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );
});
