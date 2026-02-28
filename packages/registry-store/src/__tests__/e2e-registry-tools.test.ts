/**
 * E2E test — Registry agent-facing tools through full L1 runtime assembly.
 *
 * Validates that the 4 registry tools (registry_search, registry_get,
 * registry_list_versions, registry_install) work correctly through the full
 * createKoi + createPiAdapter path with real Anthropic API calls.
 *
 * Each test:
 *   1. Populates SQLite registries with test data
 *   2. Creates a ComponentProvider via createRegistryProvider
 *   3. Assembles a full L1 runtime with createKoi + createPiAdapter
 *   4. Prompts the LLM to call specific registry tools
 *   5. Asserts on tool call events and results
 *
 * Gated on ANTHROPIC_API_KEY + E2E_TESTS=1.
 *
 * Run:
 *   E2E_TESTS=1 bun --env-file=../../.env test src/__tests__/e2e-registry-tools
 */

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import type {
  BrickArtifact,
  EngineEvent,
  EngineOutput,
  JsonObject,
  KoiMiddleware,
  ToolRequest,
  ToolResponse,
} from "@koi/core";
import { brickId, publisherId, skillId, skillToken, toolToken } from "@koi/core";
import { createKoi } from "@koi/engine";
import { createPiAdapter } from "@koi/engine-pi";
import { assertOk, createTestToolArtifact } from "@koi/test-utils";
import { createSqliteBrickRegistry } from "../brick-registry.js";
import { createRegistryProvider } from "../registry-component-provider.js";
import { createSqliteSkillRegistry } from "../skill-registry.js";
import type { OnInstallCallback } from "../tools/registry-install.js";
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
// Type guards
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// Event helpers
// ---------------------------------------------------------------------------

async function collectEvents(
  iterable: AsyncIterable<EngineEvent>,
): Promise<readonly EngineEvent[]> {
  const events: EngineEvent[] = []; // let justified: local accumulator for async iteration
  for await (const event of iterable) {
    events.push(event);
  }
  return events;
}

function findDoneOutput(events: readonly EngineEvent[]): EngineOutput | undefined {
  const done = events.find((e): e is EngineEvent & { readonly kind: "done" } => e.kind === "done");
  return done?.output;
}

function findToolCallStarts(
  events: readonly EngineEvent[],
): readonly (EngineEvent & { readonly kind: "tool_call_start" })[] {
  return events.filter(
    (e): e is EngineEvent & { readonly kind: "tool_call_start" } => e.kind === "tool_call_start",
  );
}

function findToolCallEnds(
  events: readonly EngineEvent[],
): readonly (EngineEvent & { readonly kind: "tool_call_end" })[] {
  return events.filter(
    (e): e is EngineEvent & { readonly kind: "tool_call_end" } => e.kind === "tool_call_end",
  );
}

function parseToolResult(result: unknown): Record<string, unknown> | undefined {
  if (result === undefined || result === null) return undefined;
  if (typeof result === "string") {
    try {
      const parsed: unknown = JSON.parse(result);
      return isRecord(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  }
  if (isRecord(result)) {
    // Pi adapter wraps results in { content, details } — extract details
    if ("details" in result && isRecord(result.details)) {
      return result.details;
    }
    return result;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Observer middleware — records all tool calls passing through the chain
// ---------------------------------------------------------------------------

interface ToolCallRecord {
  readonly toolName: string;
  readonly input: JsonObject;
  readonly output: unknown;
}

function createObserverMiddleware(): {
  readonly middleware: KoiMiddleware;
  readonly toolCalls: readonly ToolCallRecord[];
} {
  const toolCalls: ToolCallRecord[] = []; // let justified: test observer accumulator

  const middleware: KoiMiddleware = {
    name: "e2e-observer",
    priority: 1, // outermost — sees all calls
    describeCapabilities: () => undefined,
    wrapToolCall: async (
      _ctx: unknown,
      request: ToolRequest,
      next: (request: ToolRequest) => Promise<ToolResponse>,
    ): Promise<ToolResponse> => {
      const response = await next(request);
      toolCalls.push({
        toolName: request.toolId,
        input: request.input,
        output: response.output,
      });
      return response;
    },
  };

  return {
    middleware,
    get toolCalls() {
      return toolCalls;
    },
  };
}

// ---------------------------------------------------------------------------
// Test data setup — populates all 3 registries with test data
// ---------------------------------------------------------------------------

interface TestRegistries {
  readonly db: InstanceType<typeof Database>;
  readonly brickRegistry: ReturnType<typeof createSqliteBrickRegistry>;
  readonly skillRegistry: ReturnType<typeof createSqliteSkillRegistry>;
  readonly versionIndex: ReturnType<typeof createSqliteVersionIndex>;
}

async function setupTestData(): Promise<TestRegistries> {
  const db = new Database(":memory:");
  const brickRegistry = createSqliteBrickRegistry({ db });
  const skillRegistry = createSqliteSkillRegistry({ db });
  const versionIndex = createSqliteVersionIndex({ db });

  // --- BrickRegistry: register tool bricks ---
  const calculator = createTestToolArtifact({
    id: brickId("brick_math_calculator"),
    name: "math-calculator",
    description: "Performs basic arithmetic calculations including add, subtract, multiply, divide",
    tags: ["math", "utility", "arithmetic"],
    implementation: "return String(eval(input.expression));",
    inputSchema: {
      type: "object",
      properties: { expression: { type: "string" } },
      required: ["expression"],
    },
  });
  assertOk(await brickRegistry.register(calculator));

  const formatter = createTestToolArtifact({
    id: brickId("brick_text_formatter"),
    name: "text-formatter",
    description: "Formats text with various styles like uppercase, lowercase, title case",
    tags: ["text", "utility", "formatting"],
  });
  assertOk(await brickRegistry.register(formatter));

  // --- VersionIndex: publish versions for math-calculator ---
  const pub = publisherId("pub_e2e");
  assertOk(
    await versionIndex.publish(
      "math-calculator",
      "tool",
      "1.0.0",
      brickId("brick_math_calculator_v1"),
      pub,
    ),
  );
  assertOk(
    await versionIndex.publish(
      "math-calculator",
      "tool",
      "2.0.0",
      brickId("brick_math_calculator"),
      pub,
    ),
  );
  // Deprecate v1.0.0
  assertOk(await versionIndex.deprecate("math-calculator", "tool", "1.0.0"));

  // --- SkillRegistry: publish skill versions ---
  assertOk(
    await skillRegistry.publish({
      id: skillId("debugging-guide"),
      name: "debugging-guide",
      description: "Step-by-step debugging methodology for common issues",
      tags: ["debug", "methodology"],
      version: "1.0.0",
      content: "# Debugging Guide V1\n\nStep 1: Reproduce the issue...",
    }),
  );
  assertOk(
    await skillRegistry.publish({
      id: skillId("debugging-guide"),
      name: "debugging-guide",
      description: "Comprehensive debugging methodology with advanced techniques",
      tags: ["debug", "methodology"],
      version: "2.0.0",
      content: "# Debugging Guide V2\n\nStep 1: Reproduce the issue...\nStep 2: ...",
    }),
  );

  return { db, brickRegistry, skillRegistry, versionIndex };
}

function createTestProvider(
  registries: TestRegistries,
  onInstall?: OnInstallCallback,
): ReturnType<typeof createRegistryProvider> {
  return createRegistryProvider({
    bricks: registries.brickRegistry,
    skills: registries.skillRegistry,
    versions: registries.versionIndex,
    ...(onInstall !== undefined ? { onInstall } : {}),
  });
}

function closeRegistries(registries: TestRegistries): void {
  registries.brickRegistry.close();
  registries.skillRegistry.close();
  registries.versionIndex.close();
}

const TEST_MANIFEST = {
  name: "registry-tools-e2e",
  version: "0.1.0",
  model: { name: "claude-haiku" },
} as const;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describeE2E("e2e: registry tools through full L1 runtime assembly", () => {
  // -------------------------------------------------------------------------
  // 1. Tool discovery — all 4 tools + skill registered (no LLM call)
  // -------------------------------------------------------------------------

  test("all 4 registry tools and skill component are registered on agent", async () => {
    const registries = await setupTestData();
    const provider = createTestProvider(registries);

    const adapter = createPiAdapter({
      model: E2E_MODEL,
      systemPrompt: "You are a test agent.",
      getApiKey: async () => ANTHROPIC_KEY,
    });

    const runtime = await createKoi({
      manifest: TEST_MANIFEST,
      adapter,
      providers: [provider],
      loopDetection: false,
    });

    try {
      expect(runtime.agent.has(toolToken("registry_search"))).toBe(true);
      expect(runtime.agent.has(toolToken("registry_get"))).toBe(true);
      expect(runtime.agent.has(toolToken("registry_list_versions"))).toBe(true);
      expect(runtime.agent.has(toolToken("registry_install"))).toBe(true);
      expect(runtime.agent.has(skillToken("registry-guide"))).toBe(true);
    } finally {
      await runtime.dispose();
      closeRegistries(registries);
    }
  }, 30_000);

  // -------------------------------------------------------------------------
  // 2. LLM calls registry_search to find bricks by text query
  // -------------------------------------------------------------------------

  test(
    "LLM calls registry_search to find calculator brick",
    async () => {
      const registries = await setupTestData();
      const provider = createTestProvider(registries);

      const adapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt:
          "You have registry tools. When asked to search, use registry_search. " +
          "Do NOT explain, just call the tool.",
        getApiKey: async () => ANTHROPIC_KEY,
      });

      const runtime = await createKoi({
        manifest: TEST_MANIFEST,
        adapter,
        providers: [provider],
        loopDetection: false,
      });

      try {
        const events = await collectEvents(
          runtime.run({
            kind: "text",
            text: "Use registry_search with text='calculator' to find calculator tools. Just call the tool.",
          }),
        );

        const output = findDoneOutput(events);
        expect(output).toBeDefined();

        // Verify registry_search was called
        const toolStarts = findToolCallStarts(events);
        const searchStart = toolStarts.find((e) => e.toolName === "registry_search");
        expect(searchStart).toBeDefined();

        // Verify result contains math-calculator
        const toolEnds = findToolCallEnds(events);
        const searchEnd = toolEnds.find((e) => {
          const result = parseToolResult(e.result);
          if (result === undefined) return false;
          const items = result.items;
          if (!Array.isArray(items)) return false;
          return items.some((item: unknown) => isRecord(item) && item.name === "math-calculator");
        });
        expect(searchEnd).toBeDefined();
      } finally {
        await runtime.dispose();
        closeRegistries(registries);
      }
    },
    TIMEOUT_MS,
  );

  // -------------------------------------------------------------------------
  // 3. LLM calls registry_get with full detail mode
  // -------------------------------------------------------------------------

  test(
    "LLM calls registry_get for math-calculator with full detail",
    async () => {
      const registries = await setupTestData();
      const provider = createTestProvider(registries);

      const adapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt:
          "You have registry tools. When asked to get details, use registry_get. " +
          "Do NOT explain, just call the tool.",
        getApiKey: async () => ANTHROPIC_KEY,
      });

      const runtime = await createKoi({
        manifest: TEST_MANIFEST,
        adapter,
        providers: [provider],
        loopDetection: false,
      });

      try {
        const events = await collectEvents(
          runtime.run({
            kind: "text",
            text: "Use registry_get with kind='tool' and name='math-calculator' and detail='full'. Just call the tool.",
          }),
        );

        const output = findDoneOutput(events);
        expect(output).toBeDefined();

        // Verify registry_get was called
        const toolStarts = findToolCallStarts(events);
        const getStart = toolStarts.find((e) => e.toolName === "registry_get");
        expect(getStart).toBeDefined();

        // Verify result contains full brick data including implementation
        const toolEnds = findToolCallEnds(events);
        const getEnd = toolEnds.find((e) => {
          const result = parseToolResult(e.result);
          return result !== undefined && result.name === "math-calculator";
        });
        expect(getEnd).toBeDefined();

        if (getEnd !== undefined) {
          const result = parseToolResult(getEnd.result);
          expect(result).toBeDefined();
          if (result !== undefined) {
            expect(result.name).toBe("math-calculator");
            expect(result.kind).toBe("tool");
            // Full mode should include implementation and inputSchema
            expect(result.implementation).toBeDefined();
            expect(result.inputSchema).toBeDefined();
          }
        }
      } finally {
        await runtime.dispose();
        closeRegistries(registries);
      }
    },
    TIMEOUT_MS,
  );

  // -------------------------------------------------------------------------
  // 4. LLM calls registry_list_versions to enumerate versions
  // -------------------------------------------------------------------------

  test(
    "LLM calls registry_list_versions for math-calculator",
    async () => {
      const registries = await setupTestData();
      const provider = createTestProvider(registries);

      const adapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt:
          "You have registry tools. When asked to list versions, use registry_list_versions. " +
          "Do NOT explain, just call the tool.",
        getApiKey: async () => ANTHROPIC_KEY,
      });

      const runtime = await createKoi({
        manifest: TEST_MANIFEST,
        adapter,
        providers: [provider],
        loopDetection: false,
      });

      try {
        const events = await collectEvents(
          runtime.run({
            kind: "text",
            text: "Use registry_list_versions with name='math-calculator' and kind='tool'. Just call the tool.",
          }),
        );

        const output = findDoneOutput(events);
        expect(output).toBeDefined();

        // Verify registry_list_versions was called
        const toolStarts = findToolCallStarts(events);
        const listStart = toolStarts.find((e) => e.toolName === "registry_list_versions");
        expect(listStart).toBeDefined();

        // Verify result contains version entries
        const toolEnds = findToolCallEnds(events);
        const listEnd = toolEnds.find((e) => {
          const result = parseToolResult(e.result);
          return result !== undefined && Array.isArray(result.versions);
        });
        expect(listEnd).toBeDefined();

        if (listEnd !== undefined) {
          const result = parseToolResult(listEnd.result);
          if (result !== undefined) {
            const versions = result.versions;
            expect(Array.isArray(versions)).toBe(true);
            if (Array.isArray(versions)) {
              expect(versions.length).toBe(2);
              // Should include both v2.0.0 (latest) and v1.0.0 (deprecated)
              const versionStrings = versions.map((v: unknown) =>
                isRecord(v) ? v.version : undefined,
              );
              expect(versionStrings).toContain("2.0.0");
              expect(versionStrings).toContain("1.0.0");
            }
          }
        }
      } finally {
        await runtime.dispose();
        closeRegistries(registries);
      }
    },
    TIMEOUT_MS,
  );

  // -------------------------------------------------------------------------
  // 5. LLM calls registry_install (skill) with onInstall callback
  // -------------------------------------------------------------------------

  test(
    "LLM calls registry_install for skill and onInstall callback fires",
    async () => {
      const registries = await setupTestData();

      // let justified: test assertion accumulator
      const installedArtifacts: BrickArtifact[] = [];
      const onInstall: OnInstallCallback = async (artifact) => {
        installedArtifacts.push(artifact);
        return { ok: true, value: undefined };
      };

      const provider = createTestProvider(registries, onInstall);

      const adapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt:
          "You have registry tools. When asked to install, use registry_install. " +
          "Do NOT explain, just call the tool.",
        getApiKey: async () => ANTHROPIC_KEY,
      });

      const runtime = await createKoi({
        manifest: TEST_MANIFEST,
        adapter,
        providers: [provider],
        loopDetection: false,
      });

      try {
        const events = await collectEvents(
          runtime.run({
            kind: "text",
            text: "Use registry_install with kind='skill' and name='debugging-guide'. Just call the tool.",
          }),
        );

        const output = findDoneOutput(events);
        expect(output).toBeDefined();

        // Verify registry_install was called
        const toolStarts = findToolCallStarts(events);
        const installStart = toolStarts.find((e) => e.toolName === "registry_install");
        expect(installStart).toBeDefined();

        // Verify onInstall callback was invoked with the skill artifact
        expect(installedArtifacts.length).toBe(1);
        const installed = installedArtifacts[0];
        expect(installed).toBeDefined();
        if (installed !== undefined) {
          expect(installed.name).toBe("debugging-guide");
          expect(installed.kind).toBe("skill");
        }

        // Verify tool result indicates successful install
        const toolEnds = findToolCallEnds(events);
        const installEnd = toolEnds.find((e) => {
          const result = parseToolResult(e.result);
          return result !== undefined && result.installed === true;
        });
        expect(installEnd).toBeDefined();
      } finally {
        await runtime.dispose();
        closeRegistries(registries);
      }
    },
    TIMEOUT_MS,
  );

  // -------------------------------------------------------------------------
  // 6. Full pipeline: search → install with middleware observer
  // -------------------------------------------------------------------------

  test(
    "full pipeline: search then install with middleware observer",
    async () => {
      const registries = await setupTestData();

      // let justified: test assertion accumulator
      const installedArtifacts: BrickArtifact[] = [];
      const onInstall: OnInstallCallback = async (artifact) => {
        installedArtifacts.push(artifact);
        return { ok: true, value: undefined };
      };

      const provider = createTestProvider(registries, onInstall);
      const observer = createObserverMiddleware();

      const adapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt: [
          "You have 4 registry tools: registry_search, registry_get, registry_list_versions, registry_install.",
          "When given multi-step instructions, execute them IN ORDER.",
          "Do NOT explain, just call the tools.",
        ].join("\n"),
        getApiKey: async () => ANTHROPIC_KEY,
      });

      const runtime = await createKoi({
        manifest: TEST_MANIFEST,
        adapter,
        providers: [provider],
        middleware: [observer.middleware],
        loopDetection: false,
      });

      try {
        const events = await collectEvents(
          runtime.run({
            kind: "text",
            text: [
              "Execute these steps IN ORDER:",
              "Step 1: Use registry_search with text='calculator' to find calculator tools.",
              "Step 2: Use registry_install with kind='tool' and name='math-calculator' to install it.",
              "Call the tools now. Do NOT explain.",
            ].join("\n"),
          }),
        );

        const output = findDoneOutput(events);
        expect(output).toBeDefined();

        // Verify both tools were called via engine events
        const toolStarts = findToolCallStarts(events);
        const searchStarts = toolStarts.filter((e) => e.toolName === "registry_search");
        const installStarts = toolStarts.filter((e) => e.toolName === "registry_install");
        expect(searchStarts.length).toBeGreaterThanOrEqual(1);
        expect(installStarts.length).toBeGreaterThanOrEqual(1);

        // Verify search happened before install (event ordering)
        const firstSearchIdx = events.findIndex(
          (e) => e.kind === "tool_call_start" && e.toolName === "registry_search",
        );
        const firstInstallIdx = events.findIndex(
          (e) => e.kind === "tool_call_start" && e.toolName === "registry_install",
        );
        expect(firstSearchIdx).toBeLessThan(firstInstallIdx);

        // Verify middleware observer captured both tool calls through the chain
        const observedNames = observer.toolCalls.map((tc) => tc.toolName);
        expect(observedNames).toContain("registry_search");
        expect(observedNames).toContain("registry_install");

        // Verify onInstall callback fired with correct artifact
        expect(installedArtifacts.length).toBe(1);
        expect(installedArtifacts[0]?.name).toBe("math-calculator");
        expect(installedArtifacts[0]?.kind).toBe("tool");

        // Verify search result contained math-calculator via observer
        const searchObserved = observer.toolCalls.find((tc) => tc.toolName === "registry_search");
        expect(searchObserved).toBeDefined();
        if (searchObserved !== undefined) {
          const searchResult = isRecord(searchObserved.output) ? searchObserved.output : undefined;
          if (searchResult !== undefined && Array.isArray(searchResult.items)) {
            const names = (searchResult.items as readonly Record<string, unknown>[]).map(
              (item) => item.name,
            );
            expect(names).toContain("math-calculator");
          }
        }
      } finally {
        await runtime.dispose();
        closeRegistries(registries);
      }
    },
    TIMEOUT_MS,
  );
});
