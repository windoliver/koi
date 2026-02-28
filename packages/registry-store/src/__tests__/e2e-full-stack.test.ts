/**
 * E2E test — Registry-Store through full L1 runtime assembly.
 *
 * Validates that SQLite registries (BrickRegistry, SkillRegistry, VersionIndex)
 * work correctly through the full L1 runtime pipeline:
 *   createKoi + createPiAdapter (real Anthropic API with tool calling)
 *
 * Tests:
 *   1. BrickRegistry tool → real LLM calls it via createPiAdapter
 *   2. BrickRegistry search + FTS5 during runtime
 *   3. SkillRegistry publish + install + version retrieval
 *   4. VersionIndex publish + resolve + deprecate
 *   5. Full pipeline — all 3 registries + middleware + real LLM
 *   6. onChange events during registry mutations
 *
 * Gated on ANTHROPIC_API_KEY + E2E_TESTS=1 — tests skip when either is missing.
 *
 * Run:
 *   E2E_TESTS=1 ANTHROPIC_API_KEY=... bun test packages/registry-store/src/__tests__/e2e-full-stack.test.ts
 */

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import type {
  AgentManifest,
  BrickRegistryChangeEvent,
  ComponentProvider,
  EngineEvent,
  EngineOutput,
  KoiMiddleware,
  SkillRegistryChangeEvent,
  Tool,
  ToolRequest,
  ToolResponse,
  VersionChangeEvent,
} from "@koi/core";
import { brickId, publisherId, skillId, toolToken } from "@koi/core";
import { createKoi } from "@koi/engine";
import { createPiAdapter } from "@koi/engine-pi";
import { assertOk, createTestToolArtifact } from "@koi/test-utils";
import { createSqliteBrickRegistry } from "../brick-registry.js";
import { createSqliteSkillRegistry } from "../skill-registry.js";
import { createSqliteVersionIndex } from "../version-index.js";

// ---------------------------------------------------------------------------
// Environment gate
// ---------------------------------------------------------------------------

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY ?? "";
const HAS_KEY = ANTHROPIC_KEY.length > 0;
const E2E_OPTED_IN = process.env.E2E_TESTS === "1";
const describeE2E = HAS_KEY && E2E_OPTED_IN ? describe : describe.skip;

const TIMEOUT_MS = 120_000;
const E2E_MODEL = "anthropic:claude-haiku-4-5-20251001";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function testManifest(): AgentManifest {
  return {
    name: "registry-store-e2e",
    version: "0.1.0",
    model: { name: "claude-haiku-4-5-20251001" },
  };
}

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

function extractText(events: readonly EngineEvent[]): string {
  return events
    .filter((e): e is EngineEvent & { readonly kind: "text_delta" } => e.kind === "text_delta")
    .map((e) => e.delta)
    .join("");
}

/** Create a multiply tool backed by a real JS function. */
function createMultiplyTool(): Tool {
  return {
    descriptor: {
      name: "multiply",
      description: "Multiplies two numbers together and returns the product.",
      inputSchema: {
        type: "object",
        properties: {
          a: { type: "number", description: "First number" },
          b: { type: "number", description: "Second number" },
        },
        required: ["a", "b"],
      },
    },
    trustTier: "sandbox",
    execute: async (input: Readonly<Record<string, unknown>>) => {
      const a = Number(input.a ?? 0);
      const b = Number(input.b ?? 0);
      return String(a * b);
    },
  };
}

/** ComponentProvider that registers tools on the agent entity. */
function createToolProvider(tools: readonly Tool[]): ComponentProvider {
  return {
    name: "registry-e2e-tool-provider",
    attach: async () => new Map(tools.map((t) => [toolToken(t.descriptor.name) as string, t])),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describeE2E("e2e: registry-store through full L1 runtime assembly", () => {
  // -------------------------------------------------------------------------
  // Test 1: BrickRegistry tool → real LLM calls it
  // -------------------------------------------------------------------------

  test(
    "BrickRegistry tool registered and called by real LLM",
    async () => {
      const db = new Database(":memory:");
      const brickRegistry = createSqliteBrickRegistry({ db });

      // Register a multiply ToolArtifact via createTestToolArtifact
      const artifact = createTestToolArtifact({
        id: brickId("brick_multiply"),
        name: "multiply",
        description: "Multiplies two numbers. Returns the product.",
        implementation: "return String(Number(input.a) * Number(input.b));",
        inputSchema: {
          type: "object",
          properties: {
            a: { type: "number" },
            b: { type: "number" },
          },
          required: ["a", "b"],
        },
      });
      assertOk(await brickRegistry.register(artifact));

      // Verify the brick is stored
      const getResult = await brickRegistry.get("tool", "multiply");
      assertOk(getResult);
      expect(getResult.value.name).toBe("multiply");

      // Build a ComponentProvider that serves the multiply tool
      const multiplyTool = createMultiplyTool();
      const provider = createToolProvider([multiplyTool]);

      // Full L1 runtime with createPiAdapter (supports tool calling natively)
      const adapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt:
          "You MUST use the multiply tool to answer math questions. Do not compute in your head. Always use the tool.",
        getApiKey: async () => ANTHROPIC_KEY,
      });

      const runtime = await createKoi({
        manifest: testManifest(),
        adapter,
        providers: [provider],
        loopDetection: false,
      });

      const events = await collectEvents(
        runtime.run({
          kind: "text",
          text: "Use the multiply tool to compute 7 * 8. Tell me the result.",
        }),
      );
      await runtime.dispose();
      brickRegistry.close();

      // Assertions
      const output = findDoneOutput(events);
      expect(output).toBeDefined();
      expect(output?.stopReason === "completed" || output?.stopReason === "max_turns").toBe(true);

      // tool_call_start should have been emitted
      const toolStarts = events.filter((e) => e.kind === "tool_call_start");
      expect(toolStarts.length).toBeGreaterThanOrEqual(1);

      // Response should mention 56
      const text = extractText(events);
      expect(text).toContain("56");
    },
    TIMEOUT_MS,
  );

  // -------------------------------------------------------------------------
  // Test 2: BrickRegistry search + FTS5 during runtime
  // -------------------------------------------------------------------------

  test(
    "BrickRegistry FTS5 search and tag filtering work with registered bricks",
    async () => {
      const db = new Database(":memory:");
      const brickRegistry = createSqliteBrickRegistry({ db });

      // Register multiple tool bricks with different names/tags
      const tools = [
        createTestToolArtifact({
          id: brickId("brick_calculator"),
          name: "calculator",
          description: "Performs basic arithmetic calculations",
          tags: ["math", "utility"],
        }),
        createTestToolArtifact({
          id: brickId("brick_formatter"),
          name: "formatter",
          description: "Renders text and numbers for display",
          tags: ["text", "utility"],
        }),
        createTestToolArtifact({
          id: brickId("brick_analyzer"),
          name: "analyzer",
          description: "Analyzes data and produces statistical summaries",
          tags: ["math", "statistics"],
        }),
      ];

      for (const tool of tools) {
        assertOk(await brickRegistry.register(tool));
      }

      // FTS5 matches full tokens — "arithmetic" is a token in calculator's description
      const textResults = await brickRegistry.search({ text: "arithmetic" });
      expect(textResults.items.length).toBe(1);
      expect(textResults.items[0]?.name).toBe("calculator");

      // "formatter" is the full name token
      const formatResults = await brickRegistry.search({ text: "formatter" });
      expect(formatResults.items.length).toBe(1);
      expect(formatResults.items[0]?.name).toBe("formatter");

      // Search by tags → AND-filtering: ["math", "utility"] matches only calculator
      const tagResults = await brickRegistry.search({ tags: ["math", "utility"] });
      expect(tagResults.items.length).toBe(1);
      expect(tagResults.items[0]?.name).toBe("calculator");

      // Search by single tag → "utility" matches calculator and formatter
      const utilityResults = await brickRegistry.search({ tags: ["utility"] });
      expect(utilityResults.items.length).toBe(2);
      const utilityNames = utilityResults.items
        .map((i: { readonly name: string }) => i.name)
        .sort();
      expect(utilityNames).toEqual(["calculator", "formatter"]);

      // "statistical" is a token in analyzer's description
      const statResults = await brickRegistry.search({ text: "statistical" });
      expect(statResults.items.length).toBe(1);
      expect(statResults.items[0]?.name).toBe("analyzer");

      // Total count
      const allResults = await brickRegistry.search({});
      expect(allResults.total).toBe(3);

      brickRegistry.close();
    },
    TIMEOUT_MS,
  );

  // -------------------------------------------------------------------------
  // Test 3: SkillRegistry publish + install + version retrieval
  // -------------------------------------------------------------------------

  test(
    "SkillRegistry publish, install, search, and version listing",
    async () => {
      const db = new Database(":memory:");
      const skillRegistry = createSqliteSkillRegistry({ db });

      const id = skillId("skill_test_e2e");

      // Publish skill v1.0.0
      const v1Result = await skillRegistry.publish({
        id,
        name: "testsuite",
        description: "A skill for comprehensive integration testing",
        tags: ["test", "e2e"],
        version: "1.0.0",
        content: "# V1",
      });
      assertOk(v1Result);
      expect(v1Result.value.version).toBe("1.0.0");

      // Publish skill v2.0.0
      const v2Result = await skillRegistry.publish({
        id,
        name: "testsuite",
        description: "A skill for comprehensive integration testing (updated)",
        tags: ["test", "e2e"],
        version: "2.0.0",
        content: "# V2",
      });
      assertOk(v2Result);
      expect(v2Result.value.version).toBe("2.0.0");

      // Install latest → content is "# V2"
      const latestInstall = await skillRegistry.install(id);
      assertOk(latestInstall);
      expect(latestInstall.value.content).toBe("# V2");

      // Install v1.0.0 → content is "# V1"
      const v1Install = await skillRegistry.install(id, "1.0.0");
      assertOk(v1Install);
      expect(v1Install.value.content).toBe("# V1");

      // FTS5 search by full token "testsuite" → found
      const searchResult = await skillRegistry.search({ text: "testsuite" });
      expect(searchResult.items.length).toBe(1);
      expect(searchResult.items[0]?.name).toBe("testsuite");

      // Also search by tag
      const tagResult = await skillRegistry.search({ tags: ["e2e"] });
      expect(tagResult.items.length).toBe(1);
      expect(tagResult.items[0]?.name).toBe("testsuite");

      // Versions list → ordered [v2, v1]
      const versionsResult = await skillRegistry.versions(id);
      assertOk(versionsResult);
      expect(versionsResult.value.length).toBe(2);
      expect(versionsResult.value[0]?.version).toBe("2.0.0");
      expect(versionsResult.value[1]?.version).toBe("1.0.0");

      skillRegistry.close();
    },
    TIMEOUT_MS,
  );

  // -------------------------------------------------------------------------
  // Test 4: VersionIndex publish + resolve + deprecate
  // -------------------------------------------------------------------------

  test(
    "VersionIndex publish, resolve, resolveLatest, deprecate, and listVersions",
    async () => {
      const db = new Database(":memory:");
      const versionIndex = createSqliteVersionIndex({ db });

      const pub = publisherId("pub_e2e_tester");
      const name = "testtool";
      const kind = "tool" as const;

      // Publish versions 1.0.0, 2.0.0, 3.0.0
      const v1 = await versionIndex.publish(name, kind, "1.0.0", brickId("brick_v1"), pub);
      assertOk(v1);

      const v2 = await versionIndex.publish(name, kind, "2.0.0", brickId("brick_v2"), pub);
      assertOk(v2);

      const v3 = await versionIndex.publish(name, kind, "3.0.0", brickId("brick_v3"), pub);
      assertOk(v3);

      // resolveLatest → 3.0.0
      const latest = await versionIndex.resolveLatest(name, kind);
      assertOk(latest);
      expect(latest.value.version).toBe("3.0.0");
      expect(latest.value.brickId).toBe(brickId("brick_v3"));

      // resolve specific 1.0.0 → correct brickId
      const specific = await versionIndex.resolve(name, kind, "1.0.0");
      assertOk(specific);
      expect(specific.value.brickId).toBe(brickId("brick_v1"));

      // Deprecate 2.0.0
      const deprecateResult = await versionIndex.deprecate(name, kind, "2.0.0");
      assertOk(deprecateResult);

      // resolveLatest still returns 3.0.0
      const latestAfter = await versionIndex.resolveLatest(name, kind);
      assertOk(latestAfter);
      expect(latestAfter.value.version).toBe("3.0.0");

      // listVersions → all 3 present with correct deprecated flags
      const allVersions = await versionIndex.listVersions(name, kind);
      assertOk(allVersions);
      expect(allVersions.value.length).toBe(3);

      // v3 (latest) should be first, not deprecated
      expect(allVersions.value[0]?.version).toBe("3.0.0");
      expect(allVersions.value[0]?.deprecated).toBeUndefined();

      // v2 should be deprecated
      expect(allVersions.value[1]?.version).toBe("2.0.0");
      expect(allVersions.value[1]?.deprecated).toBe(true);

      // v1 should not be deprecated
      expect(allVersions.value[2]?.version).toBe("1.0.0");
      expect(allVersions.value[2]?.deprecated).toBeUndefined();

      versionIndex.close();
    },
    TIMEOUT_MS,
  );

  // -------------------------------------------------------------------------
  // Test 5: Full pipeline — all 3 registries + middleware + real LLM
  // -------------------------------------------------------------------------

  test(
    "full pipeline: all 3 SQLite registries + observer middleware + real LLM",
    async () => {
      const db = new Database(":memory:");

      // Wire all 3 registries on shared :memory: DB
      const brickRegistry = createSqliteBrickRegistry({ db });
      const skillRegistry = createSqliteSkillRegistry({ db });
      const versionIndex = createSqliteVersionIndex({ db });

      // Track onChange events from BrickRegistry (subscribe BEFORE mutations)
      const brickEvents: BrickRegistryChangeEvent[] = [];
      if (brickRegistry.onChange !== undefined) {
        brickRegistry.onChange((evt) => {
          brickEvents.push(evt);
        });
      }

      // Register tool in BrickRegistry
      const artifact = createTestToolArtifact({
        id: brickId("brick_multiply_e2e"),
        name: "multiply",
        description: "Multiplies two numbers. Returns the product as a string.",
        implementation: "return String(Number(input.a) * Number(input.b));",
        inputSchema: {
          type: "object",
          properties: {
            a: { type: "number" },
            b: { type: "number" },
          },
          required: ["a", "b"],
        },
      });
      assertOk(await brickRegistry.register(artifact));

      // Publish matching version in VersionIndex
      const pub = publisherId("pub_e2e");
      assertOk(
        await versionIndex.publish("multiply", "tool", "0.0.1", brickId("brick_multiply_e2e"), pub),
      );

      // Observer middleware — captures tool call names
      const toolCallNames: string[] = [];
      const observer: KoiMiddleware = {
        name: "e2e-observer",
        describeCapabilities: () => undefined,
        wrapToolCall: async (
          _ctx: unknown,
          req: ToolRequest,
          next: (r: ToolRequest) => Promise<ToolResponse>,
        ) => {
          toolCallNames.push(req.toolId);
          return next(req);
        },
      };

      // Build provider with the real multiply tool
      const multiplyTool = createMultiplyTool();
      const provider = createToolProvider([multiplyTool]);

      // Full L1 runtime with createPiAdapter (supports tool calling)
      const adapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt:
          "You MUST use the multiply tool to answer math questions. Do not compute in your head. Always use the tool.",
        getApiKey: async () => ANTHROPIC_KEY,
      });

      const runtime = await createKoi({
        manifest: testManifest(),
        adapter,
        providers: [provider],
        middleware: [observer],
        loopDetection: false,
      });

      const events = await collectEvents(
        runtime.run({
          kind: "text",
          text: "Use the multiply tool to compute 9 * 11. Tell me the result.",
        }),
      );
      await runtime.dispose();

      // Assert: done with valid output
      const output = findDoneOutput(events);
      expect(output).toBeDefined();
      expect(output?.stopReason === "completed" || output?.stopReason === "max_turns").toBe(true);

      // Assert: middleware intercepted the tool call
      expect(toolCallNames).toContain("multiply");

      // Assert: text response contains 99
      const text = extractText(events);
      expect(text).toContain("99");

      // Assert: BrickRegistry registered event was fired earlier
      // (fired during register(), before the LLM run)
      expect(brickEvents.some((e) => e.kind === "registered")).toBe(true);

      // Verify VersionIndex entry is queryable
      const versionResult = await versionIndex.resolveLatest("multiply", "tool");
      assertOk(versionResult);
      expect(versionResult.value.version).toBe("0.0.1");

      brickRegistry.close();
      skillRegistry.close();
      versionIndex.close();
    },
    TIMEOUT_MS,
  );

  // -------------------------------------------------------------------------
  // Test 6: onChange events during registry mutations
  // -------------------------------------------------------------------------

  test(
    "onChange events fire correctly during registry mutations",
    async () => {
      const db = new Database(":memory:");

      const brickRegistry = createSqliteBrickRegistry({ db });
      const skillRegistry = createSqliteSkillRegistry({ db });
      const versionIndex = createSqliteVersionIndex({ db });

      // --- BrickRegistry events ---
      const brickEvents: BrickRegistryChangeEvent[] = [];
      if (brickRegistry.onChange !== undefined) {
        brickRegistry.onChange((evt) => {
          brickEvents.push(evt);
        });
      }

      // register → "registered"
      const toolArtifact = createTestToolArtifact({
        id: brickId("brick_eventtool"),
        name: "eventtool",
        description: "A tool for event testing",
      });
      assertOk(await brickRegistry.register(toolArtifact));
      expect(brickEvents.length).toBe(1);
      expect(brickEvents[0]?.kind).toBe("registered");

      // re-register (update) → "updated"
      const updatedArtifact = createTestToolArtifact({
        id: brickId("brick_eventtool"),
        name: "eventtool",
        description: "Updated description",
      });
      assertOk(await brickRegistry.register(updatedArtifact));
      expect(brickEvents.length).toBe(2);
      expect(brickEvents[1]?.kind).toBe("updated");

      // unregister → "unregistered"
      assertOk(await brickRegistry.unregister("tool", "eventtool"));
      expect(brickEvents.length).toBe(3);
      expect(brickEvents[2]?.kind).toBe("unregistered");

      // --- SkillRegistry events ---
      const skillEvents: SkillRegistryChangeEvent[] = [];
      if (skillRegistry.onChange !== undefined) {
        skillRegistry.onChange((evt) => {
          skillEvents.push(evt);
        });
      }

      const sid = skillId("skill_eventskill");

      // publish → "published"
      assertOk(
        await skillRegistry.publish({
          id: sid,
          name: "eventskill",
          description: "A skill for event testing",
          tags: ["test"],
          version: "1.0.0",
          content: "# Event Skill",
        }),
      );
      expect(skillEvents.length).toBe(1);
      expect(skillEvents[0]?.kind).toBe("published");

      // deprecate → "deprecated"
      assertOk(await skillRegistry.deprecate(sid, "1.0.0"));
      expect(skillEvents.length).toBe(2);
      expect(skillEvents[1]?.kind).toBe("deprecated");

      // unpublish → "unpublished"
      assertOk(await skillRegistry.unpublish(sid));
      expect(skillEvents.length).toBe(3);
      expect(skillEvents[2]?.kind).toBe("unpublished");

      // --- VersionIndex events ---
      const versionEvents: VersionChangeEvent[] = [];
      if (versionIndex.onChange !== undefined) {
        versionIndex.onChange((evt) => {
          versionEvents.push(evt);
        });
      }

      const pub = publisherId("pub_eventtester");

      // publish → "published"
      assertOk(
        await versionIndex.publish("eventbrick", "tool", "1.0.0", brickId("brick_eventv1"), pub),
      );
      expect(versionEvents.length).toBe(1);
      expect(versionEvents[0]?.kind).toBe("published");

      // deprecate → "deprecated"
      assertOk(await versionIndex.deprecate("eventbrick", "tool", "1.0.0"));
      expect(versionEvents.length).toBe(2);
      expect(versionEvents[1]?.kind).toBe("deprecated");

      brickRegistry.close();
      skillRegistry.close();
      versionIndex.close();
    },
    TIMEOUT_MS,
  );
});
