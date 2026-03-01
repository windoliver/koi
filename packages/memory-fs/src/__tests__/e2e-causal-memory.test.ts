/**
 * End-to-end tests for causal memory graph features wired through the
 * full createKoi + createPiAdapter runtime assembly.
 *
 * Exercises the tool surface gaps filled in this PR:
 *   - memory_store: `causal_parents` parameter
 *   - memory_recall: `graph_expand` + `max_hops` parameters
 *
 * Gated on ANTHROPIC_API_KEY + E2E_TESTS=1 — tests are skipped when either
 * is missing. Run:
 *   E2E_TESTS=1 bun test src/__tests__/e2e-causal-memory.test.ts
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EngineEvent, EngineOutput } from "@koi/core";
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
// Tests: Causal memory graph through createKoi assembly
// ---------------------------------------------------------------------------

describeE2E("e2e: causal memory graph through createKoi", () => {
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
    testDir = join(tmpdir(), `koi-causal-e2e-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(testDir, { recursive: true });
    fsMemory = await createFsMemory({ baseDir: testDir });
  });

  afterEach(async () => {
    await fsMemory.close();
    rmSync(testDir, { recursive: true, force: true });
  });

  // -----------------------------------------------------------------------
  // Test 1: LLM stores a fact with causal_parents linking to existing fact
  // -----------------------------------------------------------------------

  test(
    "LLM stores a fact with causal_parents linking to existing fact",
    async () => {
      // Pre-seed fact A
      await fsMemory.component.store("The root cause was a missing env variable", {
        category: "resolution",
        relatedEntities: ["bug-123"],
      });

      // Recall to get fact A's ID
      const seedResults = await fsMemory.component.recall("root cause");
      expect(seedResults.length).toBeGreaterThan(0);
      const parentId = (seedResults[0]?.metadata as { readonly id: string } | undefined)?.id;
      expect(parentId).toBeDefined();

      const provider = createMemoryProvider({ memory: fsMemory });
      const adapter = createAdapter();

      const runtime = await createKoi({
        manifest: {
          name: "e2e-causal-store-agent",
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
          text: `Use the memory_store tool to store "Applied the fix by adding DATABASE_URL to .env" with category "resolution", related_entities ["bug-123"], and causal_parents ["${parentId}"]. Then confirm you stored it.`,
        }),
      );

      const output = findDoneOutput(events);
      expect(output).toBeDefined();
      expect(output?.stopReason).toBe("completed");

      // Verify the LLM actually called memory_store
      const storeCalls = findToolCallEvents(events, "memory_store");
      expect(storeCalls.length).toBeGreaterThanOrEqual(1);

      // Verify fact was persisted and parent's causalChildren updated
      const recallResults = await fsMemory.component.recall("DATABASE_URL");
      expect(recallResults.length).toBeGreaterThan(0);
      const newFact = recallResults.find((r) => r.content.includes("DATABASE_URL"));
      expect(newFact).toBeDefined();
      expect(newFact?.causalParents).toContain(parentId);

      // Verify parent now has causalChildren pointing to the new fact
      const parentResults = await fsMemory.component.recall("root cause");
      const parent = parentResults.find(
        (r) => (r.metadata as { readonly id: string } | undefined)?.id === parentId,
      );
      expect(parent).toBeDefined();
      const newFactId = (newFact?.metadata as { readonly id: string } | undefined)?.id;
      expect(parent?.causalChildren).toContain(newFactId);

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );

  // -----------------------------------------------------------------------
  // Test 2: LLM recalls with graph expansion and finds causally linked facts
  // -----------------------------------------------------------------------

  test(
    "LLM recalls with graph expansion and finds causally linked facts",
    async () => {
      // Pre-seed chain A → B → C
      await fsMemory.component.store("Server crashed due to OOM", {
        category: "incident",
        relatedEntities: ["infra"],
      });
      const resultsA = await fsMemory.component.recall("Server crashed");
      const idA = (resultsA[0]?.metadata as { readonly id: string } | undefined)?.id;
      expect(idA).toBeDefined();

      // idA is guaranteed by the expect above
      const parentIdA = idA ?? "";
      await fsMemory.component.store("Root cause: unbounded cache growth", {
        category: "analysis",
        relatedEntities: ["infra"],
        causalParents: [parentIdA],
      });
      const resultsB = await fsMemory.component.recall("unbounded cache");
      const idB = (resultsB[0]?.metadata as { readonly id: string } | undefined)?.id;
      expect(idB).toBeDefined();

      // idB is guaranteed by the expect above
      const parentIdB = idB ?? "";
      await fsMemory.component.store("Fix: added LRU eviction with 1GB max", {
        category: "resolution",
        relatedEntities: ["infra"],
        causalParents: [parentIdB],
      });

      const provider = createMemoryProvider({ memory: fsMemory });
      const adapter = createAdapter();

      const runtime = await createKoi({
        manifest: {
          name: "e2e-causal-recall-agent",
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
          text: 'Use the memory_recall tool with query "LRU eviction", graph_expand set to true, and max_hops set to 2. Then report all facts you found, including their content.',
        }),
      );

      const output = findDoneOutput(events);
      expect(output).toBeDefined();
      expect(output?.stopReason).toBe("completed");

      // Verify the LLM called memory_recall
      const recallCalls = findToolCallEvents(events, "memory_recall");
      expect(recallCalls.length).toBeGreaterThanOrEqual(1);

      // The model should mention content from the causal chain
      const text = extractTextFromEvents(events).toLowerCase();
      expect(text).toContain("lru");
      // Graph expansion should surface at least one related fact
      const mentionsChain =
        text.includes("oom") || text.includes("cache") || text.includes("crash");
      expect(mentionsChain).toBe(true);

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );

  // -----------------------------------------------------------------------
  // Test 3: Full causal workflow: store chain → recall with expansion
  // -----------------------------------------------------------------------

  test(
    "full causal workflow: store chain then recall with expansion",
    async () => {
      const provider = createMemoryProvider({ memory: fsMemory });
      const adapter = createAdapter();

      const runtime = await createKoi({
        manifest: {
          name: "e2e-causal-workflow-agent",
          version: "0.0.0",
          model: { name: "claude-haiku-4-5-20251001" },
        },
        adapter,
        providers: [provider],
        loopDetection: false,
        limits: { maxTurns: 15, maxDurationMs: 90_000 },
      });

      const events = await collectEvents(
        runtime.run({
          kind: "text",
          text: [
            "Do these steps in exact order:",
            '1. Use memory_store to store: "Bug: login page returns 500 error" with category "incident" and related_entities ["auth-service"]',
            '2. Use memory_recall with query "login page 500" to find the fact you just stored. Note the id from the metadata of the first result.',
            '3. Use memory_store to store: "Fix: corrected database connection string in auth config" with category "resolution", related_entities ["auth-service"], and causal_parents set to an array containing the id you found in step 2.',
            '4. Use memory_recall with query "database connection", graph_expand set to true, and max_hops set to 2.',
            "5. Tell me all the facts you found in step 4, including their content.",
          ].join("\n"),
        }),
      );

      const output = findDoneOutput(events);
      expect(output).toBeDefined();
      expect(output?.stopReason).toBe("completed");

      // Verify both memory_store and memory_recall were called
      const storeCalls = findToolCallEvents(events, "memory_store");
      const recallCalls = findToolCallEvents(events, "memory_recall");
      expect(storeCalls.length).toBeGreaterThanOrEqual(2);
      expect(recallCalls.length).toBeGreaterThanOrEqual(2);

      // Verify the LLM mentions both facts in its response
      const text = extractTextFromEvents(events).toLowerCase();
      expect(text).toContain("500");
      expect(text).toContain("database connection");

      // Verify underlying data: both facts exist and are linked
      const allResults = await fsMemory.component.recall("auth-service", {
        graphExpand: true,
        maxHops: 2,
      });
      expect(allResults.length).toBeGreaterThanOrEqual(2);

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );
});
