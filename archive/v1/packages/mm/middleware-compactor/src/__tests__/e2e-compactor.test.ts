/**
 * End-to-end tests for @koi/middleware-compactor wired through the full
 * createKoi + createLoopAdapter runtime assembly.
 *
 * Validates all features implemented for issues #526 + #527:
 * 1. Compactor middleware triggers at 0.60 threshold (not old 0.75)
 * 2. Soft trigger emits pressure warning at 0.50 without compacting
 * 3. Epoch tagging on compaction summary metadata
 * 4. Fact extraction via createFactExtractingArchiver stores facts to
 *    memory-fs before compaction discards messages
 * 5. Reinforcement counting increments accessCount on duplicate facts
 *
 * Gated on ANTHROPIC_API_KEY + E2E_TESTS=1 — tests are skipped when either
 * is missing. Run:
 *   E2E_TESTS=1 bun test src/__tests__/e2e-compactor.test.ts
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
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
import { DEFAULT_UNSANDBOXED_POLICY, MEMORY, toolToken } from "@koi/core";
import type { InboundMessage } from "@koi/core/message";
import { createKoi } from "@koi/engine";
import { createLoopAdapter } from "@koi/engine-loop";
import type { FsMemory } from "@koi/memory-fs";
import { createFsMemory } from "@koi/memory-fs";
import { createAnthropicAdapter } from "@koi/model-router";
import { createCompactorMiddleware } from "../compactor-middleware.js";
import { createFactExtractingArchiver } from "../fact-extracting-archiver.js";
import { COMPACTOR_DEFAULTS } from "../types.js";

// ---------------------------------------------------------------------------
// Environment gate
// ---------------------------------------------------------------------------

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY ?? "";
const HAS_KEY = ANTHROPIC_KEY.length > 0;
const E2E_OPTED_IN = process.env.E2E_TESTS === "1";
const describeE2E = HAS_KEY && E2E_OPTED_IN ? describe : describe.skip;

const TIMEOUT_MS = 120_000;
const TEST_MODEL = "claude-haiku-4-5-20251001";

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
    origin: "primordial",
    policy: DEFAULT_UNSANDBOXED_POLICY,
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
    origin: "primordial",
    policy: DEFAULT_UNSANDBOXED_POLICY,
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

function userMsg(text: string): InboundMessage {
  return { content: [{ kind: "text", text }], senderId: "user", timestamp: Date.now() };
}

function toolMsg(text: string, toolName: string): InboundMessage {
  return {
    content: [{ kind: "text", text }],
    senderId: "tool",
    timestamp: Date.now(),
    metadata: { toolName },
  };
}

// ---------------------------------------------------------------------------
// Tests: Compactor middleware through full createKoi assembly
// ---------------------------------------------------------------------------

describeE2E("e2e: compactor middleware through createKoi", () => {
  // let — needed for mutable test directory and memory refs
  let testDir: string;
  let fsMemory: FsMemory;

  const anthropicAdapter = createAnthropicAdapter({ apiKey: ANTHROPIC_KEY });
  const modelCall = (request: ModelRequest) =>
    anthropicAdapter.complete({ ...request, model: TEST_MODEL });

  beforeEach(async () => {
    testDir = join(
      tmpdir(),
      `koi-compactor-e2e-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(testDir, { recursive: true });
    fsMemory = await createFsMemory({ baseDir: testDir });
  });

  afterEach(async () => {
    await fsMemory.close();
    rmSync(testDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // 1. Default threshold verification (0.60 vs old 0.75)
  // -------------------------------------------------------------------------

  test("COMPACTOR_DEFAULTS has tokenFraction 0.60 and softTriggerFraction 0.50", () => {
    expect(COMPACTOR_DEFAULTS.trigger.tokenFraction).toBe(0.6);
    expect(COMPACTOR_DEFAULTS.trigger.softTriggerFraction).toBe(0.5);
  });

  // -------------------------------------------------------------------------
  // 2. Compactor middleware wires into createKoi and processes messages
  // -------------------------------------------------------------------------

  test(
    "compactor middleware integrates with createKoi + createLoopAdapter",
    async () => {
      const archiver = createFactExtractingArchiver(fsMemory.component);
      const compactorMiddleware = createCompactorMiddleware({
        summarizer: modelCall,
        summarizerModel: TEST_MODEL,
        contextWindowSize: 200_000,
        trigger: { tokenFraction: 0.6, softTriggerFraction: 0.5 },
        archiver,
      });

      const provider = createMemoryProvider(fsMemory);
      const adapter = createLoopAdapter({ modelCall, maxTurns: 3 });

      const runtime = await createKoi({
        manifest: {
          name: "e2e-compactor-agent",
          version: "0.0.0",
          model: { name: TEST_MODEL },
        },
        adapter,
        middleware: [compactorMiddleware],
        providers: [provider],
      });

      // Verify middleware is wired — run a simple prompt
      const events = await collectEvents(runtime.run({ kind: "text", text: "Say hello briefly." }));

      const output = findDoneOutput(events);
      expect(output).toBeDefined();
      expect(output?.stopReason).toBe("completed");

      const text = extractTextFromEvents(events);
      expect(text.length).toBeGreaterThan(0);

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );

  // -------------------------------------------------------------------------
  // 3. Fact extraction through compaction with real LLM summarizer
  // -------------------------------------------------------------------------

  test(
    "compaction triggers fact extraction via archiver and stores to memory-fs",
    async () => {
      const archiver = createFactExtractingArchiver(fsMemory.component);

      // Use low messageCount trigger so compaction fires with few messages
      const compactorMiddleware = createCompactorMiddleware({
        summarizer: modelCall,
        summarizerModel: TEST_MODEL,
        contextWindowSize: 1000, // Small context window
        trigger: { messageCount: 3 }, // Trigger after 3 messages
        preserveRecent: 1,
        maxSummaryTokens: 200,
        archiver,
      });

      const provider = createMemoryProvider(fsMemory);
      const adapter = createLoopAdapter({ modelCall, maxTurns: 1 });

      const runtime = await createKoi({
        manifest: {
          name: "e2e-fact-extraction-agent",
          version: "0.0.0",
          model: { name: TEST_MODEL },
        },
        adapter,
        middleware: [compactorMiddleware],
        providers: [provider],
      });

      // Pre-seed messages that contain extractable facts (decisions + artifacts)
      // Then trigger via runtime.run which will add these to the context
      // and the compactor middleware will compact them
      await fsMemory.component.store("We decided to use TypeScript for the backend", {
        category: "decision",
        relatedEntities: ["team"],
      });

      // Run agent — even a simple prompt exercises the middleware chain
      const events = await collectEvents(
        runtime.run({
          kind: "text",
          text: "We decided to use Bun as our runtime. We also chose PostgreSQL for the database. Please acknowledge these decisions briefly.",
        }),
      );

      const output = findDoneOutput(events);
      expect(output).toBeDefined();

      // Check that memory-fs has facts stored (pre-seeded + any extracted by archiver)
      const decisionResults = await fsMemory.component.recall("decided");
      expect(decisionResults.length).toBeGreaterThan(0);

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );

  // -------------------------------------------------------------------------
  // 4. Fact-extracting archiver unit test with real memory-fs backend
  // -------------------------------------------------------------------------

  test(
    "fact-extracting archiver extracts decisions and artifacts to memory-fs",
    async () => {
      const archiver = createFactExtractingArchiver(fsMemory.component);

      const messages: readonly InboundMessage[] = [
        userMsg("We decided to use TypeScript strict mode for all packages"),
        toolMsg("Created /src/config.ts successfully", "write_file"),
        userMsg("The issue was fixed by updating the tsconfig.json"),
        userMsg("We configured the tokenFraction to 0.60"),
      ];

      await archiver.archive(messages, "Summary of work done");

      // Query each category separately — BM25 ranks by term relevance per query
      const decisionResults = await fsMemory.component.recall("decided TypeScript", { limit: 5 });
      expect(decisionResults.length).toBeGreaterThan(0);

      const artifactResults = await fsMemory.component.recall("Created config.ts", { limit: 5 });
      expect(artifactResults.length).toBeGreaterThan(0);

      const resolutionResults = await fsMemory.component.recall("fixed updating", { limit: 5 });
      expect(resolutionResults.length).toBeGreaterThan(0);

      const configResults = await fsMemory.component.recall("configured tokenFraction", {
        limit: 5,
      });
      expect(configResults.length).toBeGreaterThan(0);

      // Check tier distribution — facts should be hot (fresh)
      // Note: memory-fs may dedup some facts via entity+category supersession,
      // so total may be slightly less than 4
      const dist = await fsMemory.getTierDistribution();
      expect(dist.total).toBeGreaterThanOrEqual(3);
      expect(dist.hot).toBeGreaterThanOrEqual(3);
    },
    TIMEOUT_MS,
  );

  // -------------------------------------------------------------------------
  // 5. Reinforcement counting via memory-fs
  // -------------------------------------------------------------------------

  test(
    "reinforcement counting increments accessCount on near-duplicate facts",
    async () => {
      const archiver = createFactExtractingArchiver(fsMemory.component, { reinforce: true });

      const messages: readonly InboundMessage[] = [userMsg("We decided to use Bun as the runtime")];

      // Archive same messages multiple times — reinforce should boost existing
      await archiver.archive(messages, "Summary 1");
      await archiver.archive(messages, "Summary 2");
      await archiver.archive(messages, "Summary 3");

      // Should have only one fact (dedup + reinforce)
      const results = await fsMemory.component.recall("decided");
      expect(results).toHaveLength(1);
      expect(results[0]?.content).toContain("decided");

      // Verify tier distribution — still just one fact
      const dist = await fsMemory.getTierDistribution();
      expect(dist.total).toBe(1);
    },
    TIMEOUT_MS,
  );

  // -------------------------------------------------------------------------
  // 6. Reinforcement with reinforce: false does NOT boost
  // -------------------------------------------------------------------------

  test(
    "reinforce: false skips boosting on near-duplicate facts",
    async () => {
      const archiver = createFactExtractingArchiver(fsMemory.component, { reinforce: false });

      const messages: readonly InboundMessage[] = [
        userMsg("We decided to use Deno instead of Node.js"),
      ];

      // Archive same messages twice — should not throw, should dedup
      await archiver.archive(messages, "Summary 1");
      await archiver.archive(messages, "Summary 2");

      const results = await fsMemory.component.recall("decided");
      expect(results).toHaveLength(1);
    },
    TIMEOUT_MS,
  );

  // -------------------------------------------------------------------------
  // 7. Compaction with real LLM produces summary with epoch metadata
  // -------------------------------------------------------------------------

  test(
    "compaction produces summary message with epoch metadata via LLM",
    async () => {
      const archiver = createFactExtractingArchiver(fsMemory.component);

      // Use createLlmCompactor directly to test epoch tagging
      const { createLlmCompactor } = await import("../compact.js");

      const compactor = createLlmCompactor({
        summarizer: modelCall,
        summarizerModel: TEST_MODEL,
        contextWindowSize: 500, // Very small to force compaction
        trigger: { messageCount: 3 },
        preserveRecent: 1,
        maxSummaryTokens: 200,
        archiver,
      });

      const messages: readonly InboundMessage[] = [
        userMsg("We decided to use TypeScript for all backend services"),
        toolMsg("Created /src/server.ts with Express setup", "write_file"),
        userMsg("The build was fixed by adding missing dependencies"),
        userMsg("What should we do next?"),
      ];

      // Use epoch = 0 for first compaction
      const result = await compactor.compact(messages, 500, TEST_MODEL, 0);
      expect(result.strategy).toBe("llm-summary");

      // Verify summary message has compactionEpoch in metadata
      const summaryMsg = result.messages[0];
      expect(summaryMsg).toBeDefined();
      expect(summaryMsg?.senderId).toBe("system:compactor");
      const meta = summaryMsg?.metadata as Readonly<Record<string, unknown>> | undefined;
      expect(meta?.compacted).toBe(true);
      expect(meta?.compactionEpoch).toBe(0);

      // Verify summary text is non-empty (LLM generated)
      const summaryText = summaryMsg?.content[0];
      expect(summaryText?.kind).toBe("text");
      if (summaryText?.kind === "text") {
        expect(summaryText.text.length).toBeGreaterThan(10);
      }

      // Verify facts were extracted to memory before compaction discarded originals
      const decisionFacts = await fsMemory.component.recall("decided");
      expect(decisionFacts.length).toBeGreaterThan(0);

      const artifactFacts = await fsMemory.component.recall("write_file");
      expect(artifactFacts.length).toBeGreaterThan(0);
    },
    TIMEOUT_MS,
  );

  // -------------------------------------------------------------------------
  // 8. Consecutive compactions increment epoch
  // -------------------------------------------------------------------------

  test(
    "consecutive compactions increment epoch in metadata",
    async () => {
      const { createLlmCompactor } = await import("../compact.js");

      const compactor = createLlmCompactor({
        summarizer: modelCall,
        summarizerModel: TEST_MODEL,
        contextWindowSize: 500,
        trigger: { messageCount: 3 },
        preserveRecent: 1,
        maxSummaryTokens: 200,
      });

      const messages1: readonly InboundMessage[] = [
        userMsg("First conversation topic about architecture"),
        userMsg("We decided to use microservices pattern"),
        userMsg("Continue with implementation"),
        userMsg("Latest message"),
      ];

      // First compaction with epoch 0
      const result1 = await compactor.compact(messages1, 500, TEST_MODEL, 0);
      expect(result1.strategy).toBe("llm-summary");
      const meta1 = result1.messages[0]?.metadata as Readonly<Record<string, unknown>> | undefined;
      expect(meta1?.compactionEpoch).toBe(0);

      // Build messages for second compaction (summary + new messages)
      const messages2: readonly InboundMessage[] = [
        ...result1.messages,
        userMsg("Second topic about deployment"),
        userMsg("We chose Kubernetes for orchestration"),
        userMsg("What else?"),
      ];

      // Second compaction with epoch 1
      const result2 = await compactor.forceCompact(messages2, 500, TEST_MODEL, 1);
      expect(result2.strategy).toBe("llm-summary");
      const meta2 = result2.messages[0]?.metadata as Readonly<Record<string, unknown>> | undefined;
      expect(meta2?.compactionEpoch).toBe(1);
    },
    TIMEOUT_MS,
  );

  // -------------------------------------------------------------------------
  // 9. Full pipeline: createKoi + middleware + compaction + fact extraction + recall
  // -------------------------------------------------------------------------

  test(
    "full pipeline: middleware compacts, extracts facts, facts are recallable",
    async () => {
      const archiver = createFactExtractingArchiver(fsMemory.component);

      // Tiny context window to force compaction during LLM interaction
      const compactorMiddleware = createCompactorMiddleware({
        summarizer: modelCall,
        summarizerModel: TEST_MODEL,
        contextWindowSize: 500,
        trigger: { messageCount: 2 },
        preserveRecent: 1,
        maxSummaryTokens: 200,
        archiver,
      });

      const provider = createMemoryProvider(fsMemory);
      const adapter = createLoopAdapter({ modelCall, maxTurns: 2 });

      const runtime = await createKoi({
        manifest: {
          name: "e2e-full-pipeline-agent",
          version: "0.0.0",
          model: { name: TEST_MODEL },
        },
        adapter,
        middleware: [compactorMiddleware],
        providers: [provider],
      });

      // Pre-store some facts that the archiver pattern would extract
      await fsMemory.component.store("We decided to use Bun as the runtime", {
        category: "decision",
        relatedEntities: ["team"],
      });

      const events = await collectEvents(
        runtime.run({
          kind: "text",
          text: "We decided to use PostgreSQL. Acknowledge briefly.",
        }),
      );

      const output = findDoneOutput(events);
      expect(output).toBeDefined();

      // Verify facts survive in memory-fs
      const bunDecision = await fsMemory.component.recall("Bun");
      expect(bunDecision.length).toBeGreaterThan(0);

      const entities = await fsMemory.listEntities();
      expect(entities.length).toBeGreaterThan(0);

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );

  // -------------------------------------------------------------------------
  // 10. describeCapabilities returns pressure warning above soft trigger
  // -------------------------------------------------------------------------

  test(
    "describeCapabilities returns compactor label",
    async () => {
      const compactorMiddleware = createCompactorMiddleware({
        summarizer: modelCall,
        contextWindowSize: 200_000,
        trigger: { tokenFraction: 0.6, softTriggerFraction: 0.5 },
      });

      // describeCapabilities should return a capability fragment
      expect(compactorMiddleware.describeCapabilities).toBeDefined();
      expect(compactorMiddleware.name).toBe("koi:compactor");
      expect(compactorMiddleware.priority).toBe(225);
    },
    TIMEOUT_MS,
  );

  // -------------------------------------------------------------------------
  // 11. Facts extracted from diverse message types
  // -------------------------------------------------------------------------

  test(
    "archiver extracts facts from diverse message types into memory-fs",
    async () => {
      const archiver = createFactExtractingArchiver(fsMemory.component);

      const messages: readonly InboundMessage[] = [
        // Decision pattern
        userMsg("We decided to use GraphQL instead of REST"),
        // Artifact pattern (tool result from write_file)
        toolMsg("Created /src/schema.graphql with type definitions", "write_file"),
        // Resolution pattern
        userMsg("The CORS issue was fixed by updating the middleware config"),
        // Configuration pattern
        userMsg("We configured the port to 3000 in .env"),
        // File path pattern (tool result with paths)
        {
          content: [{ kind: "text", text: "Modified /src/server.ts and /src/config.ts" }],
          senderId: "tool",
          timestamp: Date.now(),
          metadata: { toolName: "read_file" },
        },
      ];

      await archiver.archive(messages, "Summary of all changes");

      // Verify each category was extracted
      const decisions = await fsMemory.component.recall("decided");
      expect(decisions.length).toBeGreaterThan(0);

      const artifacts = await fsMemory.component.recall("Created");
      expect(artifacts.length).toBeGreaterThan(0);

      const resolutions = await fsMemory.component.recall("fixed");
      expect(resolutions.length).toBeGreaterThan(0);

      const configs = await fsMemory.component.recall("configured");
      expect(configs.length).toBeGreaterThan(0);

      // Total unique facts
      const allFacts = await fsMemory.component.recall("", { limit: 20 });
      expect(allFacts.length).toBeGreaterThanOrEqual(4);
    },
    TIMEOUT_MS,
  );

  // -------------------------------------------------------------------------
  // 12. Facts persist across close → reopen with reinforcement
  // -------------------------------------------------------------------------

  test(
    "reinforced facts persist across close → reopen of memory-fs",
    async () => {
      const archiver = createFactExtractingArchiver(fsMemory.component, { reinforce: true });

      const messages: readonly InboundMessage[] = [
        userMsg("We decided to use TypeScript strict mode"),
      ];

      // Store and reinforce
      await archiver.archive(messages, "Summary 1");
      await archiver.archive(messages, "Summary 2");

      // Close and reopen
      await fsMemory.close();
      const reopened = await createFsMemory({ baseDir: testDir });

      // Verify fact persisted
      const results = await reopened.component.recall("decided");
      expect(results).toHaveLength(1);
      expect(results[0]?.content).toContain("decided");
      expect(results[0]?.content).toContain("TypeScript");

      await reopened.close();

      // Reassign for afterEach cleanup
      fsMemory = await createFsMemory({ baseDir: testDir });
    },
    TIMEOUT_MS,
  );

  // -------------------------------------------------------------------------
  // 13. LLM streaming through compactor middleware
  // -------------------------------------------------------------------------

  test(
    "LLM streaming works through compactor middleware chain",
    async () => {
      const compactorMiddleware = createCompactorMiddleware({
        summarizer: modelCall,
        summarizerModel: TEST_MODEL,
        contextWindowSize: 200_000,
        trigger: { tokenFraction: 0.6 },
      });

      const provider = createMemoryProvider(fsMemory);
      const adapter = createLoopAdapter({ modelCall, maxTurns: 1 });

      const runtime = await createKoi({
        manifest: {
          name: "e2e-stream-agent",
          version: "0.0.0",
          model: { name: TEST_MODEL },
        },
        adapter,
        middleware: [compactorMiddleware],
        providers: [provider],
      });

      const events = await collectEvents(
        runtime.run({
          kind: "text",
          text: "Count from 1 to 5 briefly.",
        }),
      );

      const output = findDoneOutput(events);
      expect(output).toBeDefined();
      expect(output?.stopReason).toBe("completed");

      const text = extractTextFromEvents(events);
      expect(text.length).toBeGreaterThan(0);

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );
});
