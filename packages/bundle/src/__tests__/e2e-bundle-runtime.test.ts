/**
 * E2E: Bundle export → serialize → deserialize → import → real LLM agent.
 *
 * Validates the full @koi/bundle lifecycle end-to-end:
 *   1. Forge tools into store A
 *   2. Export agent bundle from store A
 *   3. Serialize to JSON → deserialize back (simulates .koibundle file transfer)
 *   4. Import into store B (trust downgrade, dedup, integrity)
 *   5. Wire store B tools into a real createKoi + createPiAdapter agent
 *   6. Run the agent with real Anthropic API calls
 *   7. Verify the imported tool was called through the middleware chain
 *
 * @koi/engine and @koi/engine-pi are devDependencies (test-only — no layer violation).
 *
 * Run:
 *   E2E_TESTS=1 ANTHROPIC_API_KEY=sk-ant-... bun test src/__tests__/e2e-bundle-runtime.test.ts
 */

import { describe, expect, test } from "bun:test";
import type {
  AgentManifest,
  BrickArtifact,
  ComponentProvider,
  EngineEvent,
  EngineOutput,
  ForgeStore,
  KoiMiddleware,
  Tool,
  ToolArtifact,
  ToolRequest,
  ToolResponse,
} from "@koi/core";
import { BUNDLE_FORMAT_VERSION, toolToken } from "@koi/core";
import { createKoi } from "@koi/engine";
import { createPiAdapter } from "@koi/engine-pi";
import { computeBrickId } from "@koi/hash";

import { createBundle } from "../export-bundle.js";
import { importBundle } from "../import-bundle.js";
import { deserializeBundle, serializeBundle } from "../serialize.js";

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

function testManifest(): AgentManifest {
  return {
    name: "Bundle E2E Agent",
    version: "0.1.0",
    model: { name: "claude-haiku-4-5" },
  };
}

// ---------------------------------------------------------------------------
// In-memory ForgeStore factory (shared across tests)
// ---------------------------------------------------------------------------

function createInMemoryStore(initialBricks?: readonly BrickArtifact[]): ForgeStore & {
  readonly getAll: () => readonly BrickArtifact[];
} {
  const map = new Map<string, BrickArtifact>();
  if (initialBricks) {
    for (const brick of initialBricks) {
      map.set(brick.id, brick);
    }
  }
  return {
    save: async (brick) => {
      map.set(brick.id, brick);
      return { ok: true, value: undefined };
    },
    load: async (id) => {
      const brick = map.get(id);
      if (brick === undefined) {
        return {
          ok: false,
          error: { code: "NOT_FOUND", message: `Not found: ${id}`, retryable: false },
        };
      }
      return { ok: true, value: brick };
    },
    search: async () => ({ ok: true, value: [...map.values()] }),
    remove: async (id) => {
      map.delete(id);
      return { ok: true, value: undefined };
    },
    update: async () => ({ ok: true, value: undefined }),
    exists: async (id) => ({ ok: true, value: map.has(id) }),
    getAll: () => [...map.values()],
  };
}

// ---------------------------------------------------------------------------
// Test brick factories
// ---------------------------------------------------------------------------

function createTestProvenance(): ToolArtifact["provenance"] {
  return {
    source: { origin: "forged", forgedBy: "e2e-agent" },
    buildDefinition: { buildType: "forge", externalParameters: {} },
    builder: { id: "e2e-builder" },
    metadata: {
      invocationId: "e2e-inv-1",
      startedAt: Date.now() - 1000,
      finishedAt: Date.now(),
      sessionId: "e2e-session",
      agentId: "e2e-agent",
      depth: 0,
    },
    verification: {
      passed: true,
      finalTrustTier: "verified",
      totalDurationMs: 1000,
      stageResults: [],
    },
    classification: "public",
    contentMarkers: [],
    contentHash: "e2e-hash",
  };
}

function createMultiplyBrick(): ToolArtifact {
  const implementation = "return String(Number(input.a) * Number(input.b));";
  const id = computeBrickId("tool", implementation);
  return {
    id,
    kind: "tool",
    name: "multiply",
    description: "Multiplies two numbers together and returns the product.",
    scope: "agent",
    trustTier: "verified",
    lifecycle: "active",
    provenance: createTestProvenance(),
    version: "1.0.0",
    tags: ["math", "e2e"],
    usageCount: 0,
    implementation,
    inputSchema: {
      type: "object",
      properties: {
        a: { type: "number", description: "First number" },
        b: { type: "number", description: "Second number" },
      },
      required: ["a", "b"],
    },
  };
}

function createWeatherBrick(): ToolArtifact {
  const implementation =
    'return JSON.stringify({ city: String(input.city), temperature: 22, condition: "sunny" });';
  const id = computeBrickId("tool", implementation);
  return {
    id,
    kind: "tool",
    name: "get_weather",
    description: "Returns the current weather for a city. Always returns sunny 22C for testing.",
    scope: "agent",
    trustTier: "verified",
    lifecycle: "active",
    provenance: createTestProvenance(),
    version: "1.0.0",
    tags: ["weather", "e2e"],
    usageCount: 0,
    implementation,
    inputSchema: {
      type: "object",
      properties: {
        city: { type: "string", description: "City name" },
      },
      required: ["city"],
    },
  };
}

/**
 * Resolve imported ToolArtifacts from a ForgeStore into live Tool components.
 *
 * In production, ForgeRuntime handles this. For E2E we wire it manually
 * so the test stays self-contained and doesn't depend on sandbox executors.
 */
function createToolProviderFromStore(
  store: ForgeStore,
  toolExecutors: ReadonlyMap<string, Tool["execute"]>,
): ComponentProvider {
  return {
    name: "bundle-e2e-tool-provider",
    attach: async () => {
      const searchResult = await store.search({ kind: "tool" });
      if (!searchResult.ok) return new Map();

      const entries: Array<[string, Tool]> = [];
      for (const brick of searchResult.value) {
        if (brick.kind !== "tool") continue;
        const executor = toolExecutors.get(brick.name);
        if (executor === undefined) continue;
        entries.push([
          toolToken(brick.name) as string,
          {
            descriptor: {
              name: brick.name,
              description: brick.description,
              inputSchema: brick.inputSchema,
            },
            trustTier: brick.trustTier,
            execute: executor,
          },
        ]);
      }
      return new Map(entries);
    },
  };
}

// ---------------------------------------------------------------------------
// Tool executors (real implementations matching the brick "implementation" strings)
// ---------------------------------------------------------------------------

const TOOL_EXECUTORS = new Map<string, Tool["execute"]>([
  [
    "multiply",
    async (input: Readonly<Record<string, unknown>>) => {
      const a = Number(input.a ?? 0);
      const b = Number(input.b ?? 0);
      return String(a * b);
    },
  ],
  [
    "get_weather",
    async (input: Readonly<Record<string, unknown>>) => {
      const city = String(input.city ?? "unknown");
      return JSON.stringify({ city, temperature: 22, condition: "sunny" });
    },
  ],
]);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describeE2E("e2e: bundle export → import → real LLM agent", () => {
  test(
    "full pipeline: export tools, transfer bundle, import, run agent with real LLM",
    async () => {
      // ── Step 1: Create bricks and save to origin store ───────────────
      const multiplyBrick = createMultiplyBrick();
      const weatherBrick = createWeatherBrick();
      const originStore = createInMemoryStore([multiplyBrick, weatherBrick]);

      // ── Step 2: Export bundle from origin store ──────────────────────
      const exportResult = await createBundle({
        name: "e2e-portable-agent",
        description: "E2E test agent with math and weather tools",
        manifestYaml: "name: e2e-agent\nversion: 1.0.0\nmodel: claude-haiku-4-5",
        brickIds: [multiplyBrick.id, weatherBrick.id],
        store: originStore,
        metadata: { testRun: true, timestamp: Date.now() },
      });

      expect(exportResult.ok).toBe(true);
      if (!exportResult.ok) return;

      const bundle = exportResult.value;
      expect(bundle.bricks).toHaveLength(2);
      expect(bundle.name).toBe("e2e-portable-agent");

      // ── Step 3: Serialize → simulate file transfer → deserialize ─────
      const json = serializeBundle(bundle);
      expect(json.length).toBeGreaterThan(0);

      const deserializeResult = deserializeBundle(json);
      expect(deserializeResult.ok).toBe(true);
      if (!deserializeResult.ok) return;

      const transferredBundle = deserializeResult.value;
      expect(transferredBundle.contentHash).toBe(bundle.contentHash);

      // ── Step 4: Import into destination store ────────────────────────
      const destStore = createInMemoryStore();
      const importResult = await importBundle({
        bundle: transferredBundle,
        store: destStore,
      });

      expect(importResult.ok).toBe(true);
      if (!importResult.ok) return;
      expect(importResult.value.imported).toBe(2);
      expect(importResult.value.skipped).toBe(0);
      expect(importResult.value.errors).toHaveLength(0);

      // ── Step 5: Verify trust downgrade and provenance ────────────────
      const loadedMultiply = await destStore.load(multiplyBrick.id);
      expect(loadedMultiply.ok).toBe(true);
      if (!loadedMultiply.ok) return;
      expect(loadedMultiply.value.trustTier).toBe("sandbox");
      expect(loadedMultiply.value.provenance.source).toEqual({
        origin: "bundled",
        bundleName: "e2e-portable-agent",
        bundleVersion: BUNDLE_FORMAT_VERSION,
      });

      // ── Step 6: Wire imported tools into a real Koi agent ────────────
      const toolProvider = createToolProviderFromStore(destStore, TOOL_EXECUTORS);

      // let justified: capture tool calls for assertion
      let toolCallObserved = false;
      let observedToolId: string | undefined;

      const observerMiddleware: KoiMiddleware = {
        name: "e2e-bundle-observer",
        wrapToolCall: async (
          _ctx: unknown,
          request: ToolRequest,
          next: (r: ToolRequest) => Promise<ToolResponse>,
        ) => {
          toolCallObserved = true;
          observedToolId = request.toolId;
          return next(request);
        },
      };

      const adapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt:
          "You MUST use the multiply tool to answer math questions. Never compute in your head. Always use the tool.",
        getApiKey: async () => ANTHROPIC_KEY,
      });

      const runtime = await createKoi({
        manifest: testManifest(),
        adapter,
        middleware: [observerMiddleware],
        providers: [toolProvider],
        loopDetection: false,
      });

      expect(runtime.agent.state).toBe("created");

      // ── Step 7: Run the agent with a real LLM call ───────────────────
      const events = await collectEvents(
        runtime.run({
          kind: "text",
          text: "Use the multiply tool to compute 7 * 8. Tell me the result.",
        }),
      );

      expect(runtime.agent.state).toBe("terminated");

      // ── Step 8: Verify results ───────────────────────────────────────
      const output = findDoneOutput(events);
      expect(output).toBeDefined();
      if (output === undefined) return;
      expect(output.stopReason).toBe("completed");
      expect(output.metrics.inputTokens).toBeGreaterThan(0);
      expect(output.metrics.outputTokens).toBeGreaterThan(0);

      // Middleware observed the tool call
      expect(toolCallObserved).toBe(true);
      expect(observedToolId).toBe("multiply");

      // Tool call events were emitted
      const toolStarts = events.filter((e) => e.kind === "tool_call_start");
      const toolEnds = events.filter((e) => e.kind === "tool_call_end");
      expect(toolStarts.length).toBeGreaterThanOrEqual(1);
      expect(toolEnds.length).toBeGreaterThanOrEqual(1);

      // LLM response includes the correct answer
      const text = extractText(events);
      expect(text).toContain("56");

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );

  test(
    "imported tools have sandbox trust — provenance is rewritten correctly",
    async () => {
      // Export and import a single tool
      const brick = createMultiplyBrick();
      const originStore = createInMemoryStore([brick]);

      const exportResult = await createBundle({
        name: "trust-test-bundle",
        description: "Tests trust downgrade",
        manifestYaml: "name: trust-test\nversion: 1.0",
        brickIds: [brick.id],
        store: originStore,
      });
      expect(exportResult.ok).toBe(true);
      if (!exportResult.ok) return;

      // Roundtrip through serialization
      const json = serializeBundle(exportResult.value);
      const deserialized = deserializeBundle(json);
      expect(deserialized.ok).toBe(true);
      if (!deserialized.ok) return;

      // Import into fresh store
      const destStore = createInMemoryStore();
      const importResult = await importBundle({ bundle: deserialized.value, store: destStore });
      expect(importResult.ok).toBe(true);
      if (!importResult.ok) return;

      // Verify trust properties
      const loaded = await destStore.load(brick.id);
      expect(loaded.ok).toBe(true);
      if (!loaded.ok) return;

      // Original was "verified" — imported must be "sandbox"
      expect(brick.trustTier).toBe("verified");
      expect(loaded.value.trustTier).toBe("sandbox");

      // Original was "forged" — imported must be "bundled"
      expect(brick.provenance.source.origin).toBe("forged");
      expect(loaded.value.provenance.source.origin).toBe("bundled");
      expect(loaded.value.provenance.source).toEqual({
        origin: "bundled",
        bundleName: "trust-test-bundle",
        bundleVersion: BUNDLE_FORMAT_VERSION,
      });

      // Scope downgraded to "agent"
      expect(loaded.value.scope).toBe("agent");
    },
    TIMEOUT_MS,
  );

  test(
    "second import deduplicates — same bricks are skipped",
    async () => {
      const brick = createMultiplyBrick();
      const originStore = createInMemoryStore([brick]);

      const exportResult = await createBundle({
        name: "dedup-test",
        description: "Tests dedup on re-import",
        manifestYaml: "name: dedup\nversion: 1.0",
        brickIds: [brick.id],
        store: originStore,
      });
      expect(exportResult.ok).toBe(true);
      if (!exportResult.ok) return;

      const json = serializeBundle(exportResult.value);
      const deserialized = deserializeBundle(json);
      expect(deserialized.ok).toBe(true);
      if (!deserialized.ok) return;

      const destStore = createInMemoryStore();

      // First import
      const first = await importBundle({ bundle: deserialized.value, store: destStore });
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      expect(first.value.imported).toBe(1);
      expect(first.value.skipped).toBe(0);

      // Second import — same bricks → all skipped
      const second = await importBundle({ bundle: deserialized.value, store: destStore });
      expect(second.ok).toBe(true);
      if (!second.ok) return;
      expect(second.value.imported).toBe(0);
      expect(second.value.skipped).toBe(1);
    },
    TIMEOUT_MS,
  );

  test(
    "content hash tamper detection rejects corrupted bundles",
    async () => {
      const brick = createMultiplyBrick();
      const originStore = createInMemoryStore([brick]);

      const exportResult = await createBundle({
        name: "tamper-test",
        description: "Tests tamper detection",
        manifestYaml: "name: tamper\nversion: 1.0",
        brickIds: [brick.id],
        store: originStore,
      });
      expect(exportResult.ok).toBe(true);
      if (!exportResult.ok) return;

      // Serialize, then tamper with the manifest
      const json = serializeBundle(exportResult.value);
      const parsed = JSON.parse(json) as Record<string, unknown>;
      parsed.manifestYaml = "name: EVIL-AGENT\nversion: 666";
      const tamperedJson = JSON.stringify(parsed, null, 2);

      const deserialized = deserializeBundle(tamperedJson);
      expect(deserialized.ok).toBe(true);
      if (!deserialized.ok) return;

      // Import should fail because contentHash no longer matches
      const destStore = createInMemoryStore();
      const importResult = await importBundle({ bundle: deserialized.value, store: destStore });
      expect(importResult.ok).toBe(false);
      if (importResult.ok) return;
      expect(importResult.error.code).toBe("VALIDATION");
      expect(importResult.error.message).toContain("content hash mismatch");
    },
    TIMEOUT_MS,
  );

  test(
    "multi-tool agent: LLM uses weather tool from imported bundle",
    async () => {
      const weatherBrick = createWeatherBrick();
      const originStore = createInMemoryStore([weatherBrick]);

      const exportResult = await createBundle({
        name: "weather-bundle",
        description: "Weather tool bundle",
        manifestYaml: "name: weather-agent\nversion: 1.0",
        brickIds: [weatherBrick.id],
        store: originStore,
      });
      expect(exportResult.ok).toBe(true);
      if (!exportResult.ok) return;

      const json = serializeBundle(exportResult.value);
      const deserialized = deserializeBundle(json);
      expect(deserialized.ok).toBe(true);
      if (!deserialized.ok) return;

      const destStore = createInMemoryStore();
      const importResult = await importBundle({ bundle: deserialized.value, store: destStore });
      expect(importResult.ok).toBe(true);

      // Wire the imported weather tool into a real agent
      const toolProvider = createToolProviderFromStore(destStore, TOOL_EXECUTORS);
      const toolCalls: string[] = [];

      const spy: KoiMiddleware = {
        name: "weather-spy",
        wrapToolCall: async (_ctx, req: ToolRequest, next) => {
          toolCalls.push(req.toolId);
          return next(req);
        },
      };

      const adapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt:
          "You have the get_weather tool. Use it when asked about weather. Always use the tool.",
        getApiKey: async () => ANTHROPIC_KEY,
      });

      const runtime = await createKoi({
        manifest: testManifest(),
        adapter,
        middleware: [spy],
        providers: [toolProvider],
        loopDetection: false,
      });

      const events = await collectEvents(
        runtime.run({
          kind: "text",
          text: "What is the weather in Tokyo? Use the get_weather tool.",
        }),
      );

      const output = findDoneOutput(events);
      expect(output).toBeDefined();
      expect(output?.stopReason).toBe("completed");

      // Weather tool was called
      expect(toolCalls).toContain("get_weather");

      // Response mentions weather data
      const text = extractText(events);
      const hasWeatherInfo =
        text.includes("22") || text.includes("sunny") || text.includes("Tokyo");
      expect(hasWeatherInfo).toBe(true);

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );
});
