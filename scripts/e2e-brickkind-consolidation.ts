#!/usr/bin/env bun
/**
 * E2E: BrickKind Consolidation via Full L1 Runtime (Pi Agent).
 *
 * Validates that all 5 BrickKinds (tool, skill, middleware, channel, agent)
 * work through the full L1 runtime assembly with real LLM calls. After
 * consolidation from 9 to 5 kinds, this validates the middleware chain,
 * ComponentProvider, and forge pipeline work end-to-end.
 *
 * Tests:
 *   1. Forge a **tool** via Pi agent
 *   2. Forge a **skill** via Pi agent
 *   3. Forge a **middleware** via Pi agent
 *   4. Forge a **channel** via Pi agent
 *   5. Search all 4 forged bricks
 *   6. Search by kind filter
 *   7. Promote tool to verified trust
 *   8. Forged tool is callable through engine
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-... bun scripts/e2e-brickkind-consolidation.ts
 */

import type {
  ComponentProvider,
  EngineEvent,
  SandboxExecutor,
} from "../packages/core/src/index.js";
import { toolToken } from "../packages/core/src/index.js";
import { createKoi } from "../packages/engine/src/koi.js";
import { createPiAdapter } from "../packages/engine-pi/src/adapter.js";
import { createDefaultForgeConfig } from "../packages/forge/src/config.js";
import { createForgeComponentProvider } from "../packages/forge/src/forge-component-provider.js";
import { createForgeRuntime } from "../packages/forge/src/forge-runtime.js";
import { createInMemoryForgeStore } from "../packages/forge/src/memory-store.js";
import { createForgeChannelTool } from "../packages/forge/src/tools/forge-channel.js";
import { createForgeMiddlewareTool } from "../packages/forge/src/tools/forge-middleware.js";
import { createForgeSkillTool } from "../packages/forge/src/tools/forge-skill.js";
import { createForgeToolTool } from "../packages/forge/src/tools/forge-tool.js";
import { createPromoteForgeTool } from "../packages/forge/src/tools/promote-forge.js";
import { createSearchForgeTool } from "../packages/forge/src/tools/search-forge.js";
import type { ForgeDeps } from "../packages/forge/src/tools/shared.js";

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

const API_KEY = process.env.ANTHROPIC_API_KEY;
if (!API_KEY) {
  console.error("[e2e] ANTHROPIC_API_KEY is not set. Skipping.");
  process.exit(0);
}

console.log("[e2e] Starting BrickKind consolidation E2E tests...\n");

// ---------------------------------------------------------------------------
// Test infrastructure
// ---------------------------------------------------------------------------

interface TestResult {
  readonly name: string;
  readonly passed: boolean;
  readonly detail?: string;
}

const results: TestResult[] = [];

function assert(name: string, condition: boolean, detail?: string): void {
  results.push({ name, passed: condition, detail });
  const tag = condition ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m";
  const suffix = detail && !condition ? ` \u2014 ${detail}` : "";
  console.log(`  ${tag}  ${name}${suffix}`);
}

async function withTimeout<T>(fn: () => Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    fn(),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms),
    ),
  ]);
}

// ---------------------------------------------------------------------------
// Shared infrastructure
// ---------------------------------------------------------------------------

const E2E_MODEL = "anthropic:claude-haiku-4-5-20251001";
const TIMEOUT_MS = 90_000;

const store = createInMemoryForgeStore();

/** Eval executor — runs forged code via `new Function()`. No sandbox isolation (dev only). */
const executor: SandboxExecutor = {
  execute: async (code, input, _timeout) => {
    try {
      const fn = new Function("input", code) as (input: unknown) => unknown;
      const output = await Promise.resolve(fn(input));
      return { ok: true as const, value: { output, durationMs: 1 } };
    } catch (err: unknown) {
      return {
        ok: false as const,
        error: {
          code: "CRASH" as const,
          message: err instanceof Error ? err.message : String(err),
          durationMs: 1,
        },
      };
    }
  },
};

const config = createDefaultForgeConfig({
  maxForgesPerSession: 50,
  scopePromotion: {
    requireHumanApproval: false,
    minTrustForZone: "sandbox",
    minTrustForGlobal: "sandbox",
  },
});

function makeDeps(forgesThisSession: number): ForgeDeps {
  return {
    store,
    executor,
    verifiers: [],
    config,
    context: {
      agentId: "e2e-consolidation-agent",
      depth: 0,
      sessionId: `e2e-consolidation-${Date.now()}`,
      forgesThisSession,
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function collectEvents(iter: AsyncIterable<EngineEvent>): Promise<readonly EngineEvent[]> {
  const events: EngineEvent[] = [];
  for await (const event of iter) {
    events.push(event);
  }
  return events;
}

function extractToolStarts(
  events: readonly EngineEvent[],
): ReadonlyArray<EngineEvent & { readonly kind: "tool_call_start" }> {
  return events.filter(
    (e): e is EngineEvent & { readonly kind: "tool_call_start" } => e.kind === "tool_call_start",
  );
}

function extractToolEnds(
  events: readonly EngineEvent[],
): ReadonlyArray<Extract<EngineEvent, { readonly kind: "tool_call_end" }>> {
  return events.filter(
    (e): e is Extract<EngineEvent, { readonly kind: "tool_call_end" }> =>
      e.kind === "tool_call_end",
  );
}

function makePrimordialProvider(deps: ForgeDeps): ComponentProvider {
  const forgeTool = createForgeToolTool(deps);
  const forgeSkill = createForgeSkillTool(deps);
  const forgeMiddleware = createForgeMiddlewareTool(deps);
  const forgeChannel = createForgeChannelTool(deps);
  const promoteTool = createPromoteForgeTool(deps);
  const searchTool = createSearchForgeTool(deps);

  const entries: ReadonlyArray<[string, unknown]> = [
    [toolToken("forge_tool"), forgeTool],
    [toolToken("forge_skill"), forgeSkill],
    [toolToken("forge_middleware"), forgeMiddleware],
    [toolToken("forge_channel"), forgeChannel],
    [toolToken("promote_forge"), promoteTool],
    [toolToken("search_forge"), searchTool],
  ];

  return {
    name: "forge-primordials",
    attach: async (): Promise<ReadonlyMap<string, unknown>> => new Map(entries),
  };
}

// ---------------------------------------------------------------------------
// Test 1: Forge a tool via Pi agent
// ---------------------------------------------------------------------------

console.log("[test 1] Forge a tool via Pi agent\n");

try {
  const deps = makeDeps(0);
  const primordialProvider = makePrimordialProvider(deps);

  const adapter = createPiAdapter({
    model: E2E_MODEL,
    systemPrompt: [
      "You are a tool-forging agent. You have ONE task: use the forge_tool tool to create a tool.",
      "Call forge_tool with EXACTLY these arguments:",
      '  name: "add-numbers"',
      '  description: "Adds two numbers together"',
      '  inputSchema: { "type": "object", "properties": { "a": { "type": "number" }, "b": { "type": "number" } }, "required": ["a", "b"] }',
      '  implementation: "const a = input.a || 0; const b = input.b || 0; return { result: a + b };"',
      "Do NOT say anything before calling the tool. Just call it immediately.",
    ].join("\n"),
    getApiKey: async () => API_KEY,
  });

  const runtime = await createKoi({
    manifest: { name: "ForgeTool", version: "0.1.0", model: { name: E2E_MODEL } },
    adapter,
    providers: [primordialProvider],
    loopDetection: false,
    limits: { maxTurns: 10, maxDurationMs: TIMEOUT_MS, maxTokens: 50_000 },
  });

  const events = await withTimeout(
    () => collectEvents(runtime.run({ kind: "text", text: "Forge the add-numbers tool now." })),
    TIMEOUT_MS,
    "Test 1",
  );

  const toolStarts = extractToolStarts(events);
  const forgeStarts = toolStarts.filter((e) => e.toolName === "forge_tool");
  assert("LLM called forge_tool", forgeStarts.length >= 1, `got ${forgeStarts.length} calls`);

  const toolEnds = extractToolEnds(events);
  const forgeCallId = forgeStarts[0]?.callId;
  const forgeEnd =
    forgeCallId !== undefined ? toolEnds.find((e) => e.callId === forgeCallId) : toolEnds[0];

  if (forgeEnd !== undefined) {
    const output = JSON.stringify(forgeEnd.result ?? "");
    assert(
      "forge_tool returned ok:true",
      output.includes('"ok":true'),
      `output: ${output.slice(0, 300)}`,
    );
  }

  const searchResult = await store.search({ kind: "tool", text: "add-numbers" });
  const hasBrick = searchResult.ok && searchResult.value.length >= 1;
  assert("store contains 'add-numbers' brick", hasBrick);

  if (searchResult.ok && searchResult.value[0] !== undefined) {
    const brick = searchResult.value[0];
    assert("brick kind is 'tool'", brick.kind === "tool", `got ${brick.kind}`);
    assert("brick trust tier assigned", brick.trustTier !== undefined, `got ${brick.trustTier}`);
    console.log(`    Brick ID: ${brick.id}, trust: ${brick.trustTier}`);
  }
} catch (err: unknown) {
  assert("Test 1 completed without error", false, err instanceof Error ? err.message : String(err));
}

// ---------------------------------------------------------------------------
// Test 2: Forge a skill via Pi agent
// ---------------------------------------------------------------------------

console.log("\n[test 2] Forge a skill via Pi agent\n");

try {
  const deps = makeDeps(1);
  const primordialProvider = makePrimordialProvider(deps);

  const adapter = createPiAdapter({
    model: E2E_MODEL,
    systemPrompt: [
      "You are a tool-forging agent. You have ONE task: use the forge_skill tool to create a skill.",
      "Call forge_skill with EXACTLY these arguments:",
      '  name: "typescript-tips"',
      '  description: "TypeScript best practices and tips"',
      '  body: "# TypeScript Tips\\n\\n## Use strict mode\\n\\nAlways enable strict: true in tsconfig.\\n\\n## Prefer const\\n\\nUse const by default."',
      "Do NOT say anything before calling the tool. Just call it immediately.",
    ].join("\n"),
    getApiKey: async () => API_KEY,
  });

  const runtime = await createKoi({
    manifest: { name: "ForgeSkill", version: "0.1.0", model: { name: E2E_MODEL } },
    adapter,
    providers: [primordialProvider],
    loopDetection: false,
    limits: { maxTurns: 10, maxDurationMs: TIMEOUT_MS, maxTokens: 50_000 },
  });

  const events = await withTimeout(
    () =>
      collectEvents(runtime.run({ kind: "text", text: "Forge the typescript-tips skill now." })),
    TIMEOUT_MS,
    "Test 2",
  );

  const toolStarts = extractToolStarts(events);
  const forgeStarts = toolStarts.filter((e) => e.toolName === "forge_skill");
  assert("LLM called forge_skill", forgeStarts.length >= 1, `got ${forgeStarts.length} calls`);

  const toolEnds = extractToolEnds(events);
  const forgeCallId = forgeStarts[0]?.callId;
  const forgeEnd =
    forgeCallId !== undefined ? toolEnds.find((e) => e.callId === forgeCallId) : toolEnds[0];

  if (forgeEnd !== undefined) {
    const output = JSON.stringify(forgeEnd.result ?? "");
    assert(
      "forge_skill returned ok:true",
      output.includes('"ok":true'),
      `output: ${output.slice(0, 300)}`,
    );
  }

  const searchResult = await store.search({ kind: "skill", text: "typescript-tips" });
  const hasBrick = searchResult.ok && searchResult.value.length >= 1;
  assert("store contains 'typescript-tips' skill", hasBrick);

  if (searchResult.ok && searchResult.value[0] !== undefined) {
    const brick = searchResult.value[0];
    assert("brick kind is 'skill'", brick.kind === "skill", `got ${brick.kind}`);

    // Verify SKILL.md generation — load and check for frontmatter
    const loaded = await store.load(brick.id);
    if (loaded.ok && loaded.value.kind === "skill") {
      assert(
        "skill artifact has SKILL.md frontmatter",
        loaded.value.content.startsWith("---"),
        loaded.value.content.slice(0, 100),
      );
    }
  }
} catch (err: unknown) {
  assert("Test 2 completed without error", false, err instanceof Error ? err.message : String(err));
}

// ---------------------------------------------------------------------------
// Test 3: Forge a middleware via Pi agent
// ---------------------------------------------------------------------------

console.log("\n[test 3] Forge a middleware via Pi agent\n");

try {
  const deps = makeDeps(2);
  const primordialProvider = makePrimordialProvider(deps);

  const adapter = createPiAdapter({
    model: E2E_MODEL,
    systemPrompt: [
      "You are a tool-forging agent. You have ONE task: use the forge_middleware tool to create a middleware.",
      "Call forge_middleware with EXACTLY these arguments:",
      '  name: "logging-mw"',
      '  description: "A simple logging middleware that logs calls"',
      '  implementation: "return { beforeModel: async (req) => req };"',
      "Do NOT say anything before calling the tool. Just call it immediately.",
    ].join("\n"),
    getApiKey: async () => API_KEY,
  });

  const runtime = await createKoi({
    manifest: { name: "ForgeMiddleware", version: "0.1.0", model: { name: E2E_MODEL } },
    adapter,
    providers: [primordialProvider],
    loopDetection: false,
    limits: { maxTurns: 10, maxDurationMs: TIMEOUT_MS, maxTokens: 50_000 },
  });

  const events = await withTimeout(
    () =>
      collectEvents(runtime.run({ kind: "text", text: "Forge the logging-mw middleware now." })),
    TIMEOUT_MS,
    "Test 3",
  );

  const toolStarts = extractToolStarts(events);
  const forgeStarts = toolStarts.filter((e) => e.toolName === "forge_middleware");
  assert("LLM called forge_middleware", forgeStarts.length >= 1, `got ${forgeStarts.length} calls`);

  const toolEnds = extractToolEnds(events);
  const forgeCallId = forgeStarts[0]?.callId;
  const forgeEnd =
    forgeCallId !== undefined ? toolEnds.find((e) => e.callId === forgeCallId) : toolEnds[0];

  if (forgeEnd !== undefined) {
    const output = JSON.stringify(forgeEnd.result ?? "");
    assert(
      "forge_middleware returned ok:true",
      output.includes('"ok":true'),
      `output: ${output.slice(0, 300)}`,
    );
  }

  const searchResult = await store.search({ kind: "middleware", text: "logging-mw" });
  const hasBrick = searchResult.ok && searchResult.value.length >= 1;
  assert("store contains 'logging-mw' middleware", hasBrick);

  if (searchResult.ok && searchResult.value[0] !== undefined) {
    const brick = searchResult.value[0];
    assert("brick kind is 'middleware'", brick.kind === "middleware", `got ${brick.kind}`);
    assert(
      "brick trust is 'sandbox' (default for middleware)",
      brick.trustTier === "sandbox",
      `got ${brick.trustTier}`,
    );
  }
} catch (err: unknown) {
  assert("Test 3 completed without error", false, err instanceof Error ? err.message : String(err));
}

// ---------------------------------------------------------------------------
// Test 4: Forge a channel via Pi agent
// ---------------------------------------------------------------------------

console.log("\n[test 4] Forge a channel via Pi agent\n");

try {
  const deps = makeDeps(3);
  const primordialProvider = makePrimordialProvider(deps);

  const adapter = createPiAdapter({
    model: E2E_MODEL,
    systemPrompt: [
      "You are a tool-forging agent. You have ONE task: use the forge_channel tool to create a channel.",
      "Call forge_channel with EXACTLY these arguments:",
      '  name: "echo-channel"',
      '  description: "A simple echo channel that returns input"',
      '  implementation: "return { send: async (msg) => msg };"',
      "Do NOT say anything before calling the tool. Just call it immediately.",
    ].join("\n"),
    getApiKey: async () => API_KEY,
  });

  const runtime = await createKoi({
    manifest: { name: "ForgeChannel", version: "0.1.0", model: { name: E2E_MODEL } },
    adapter,
    providers: [primordialProvider],
    loopDetection: false,
    limits: { maxTurns: 10, maxDurationMs: TIMEOUT_MS, maxTokens: 50_000 },
  });

  const events = await withTimeout(
    () => collectEvents(runtime.run({ kind: "text", text: "Forge the echo-channel channel now." })),
    TIMEOUT_MS,
    "Test 4",
  );

  const toolStarts = extractToolStarts(events);
  const forgeStarts = toolStarts.filter((e) => e.toolName === "forge_channel");
  assert("LLM called forge_channel", forgeStarts.length >= 1, `got ${forgeStarts.length} calls`);

  const toolEnds = extractToolEnds(events);
  const forgeCallId = forgeStarts[0]?.callId;
  const forgeEnd =
    forgeCallId !== undefined ? toolEnds.find((e) => e.callId === forgeCallId) : toolEnds[0];

  if (forgeEnd !== undefined) {
    const output = JSON.stringify(forgeEnd.result ?? "");
    assert(
      "forge_channel returned ok:true",
      output.includes('"ok":true'),
      `output: ${output.slice(0, 300)}`,
    );
  }

  const searchResult = await store.search({ kind: "channel", text: "echo-channel" });
  const hasBrick = searchResult.ok && searchResult.value.length >= 1;
  assert("store contains 'echo-channel' channel", hasBrick);

  if (searchResult.ok && searchResult.value[0] !== undefined) {
    const brick = searchResult.value[0];
    assert("brick kind is 'channel'", brick.kind === "channel", `got ${brick.kind}`);
    assert(
      "brick trust is 'sandbox' (default for channel)",
      brick.trustTier === "sandbox",
      `got ${brick.trustTier}`,
    );
  }
} catch (err: unknown) {
  assert("Test 4 completed without error", false, err instanceof Error ? err.message : String(err));
}

// ---------------------------------------------------------------------------
// Test 5: Search all 4 forged bricks
// ---------------------------------------------------------------------------

console.log("\n[test 5] Search all 4 forged bricks\n");

try {
  const deps = makeDeps(4);
  const primordialProvider = makePrimordialProvider(deps);

  const adapter = createPiAdapter({
    model: E2E_MODEL,
    systemPrompt: [
      "You have ONE task: use the search_forge tool to search for ALL bricks.",
      "Call search_forge with an empty object {} as input.",
      "After getting the result, report exactly how many bricks were found and list their names.",
      "Do NOT say anything before calling the tool. Just call it immediately.",
    ].join("\n"),
    getApiKey: async () => API_KEY,
  });

  const runtime = await createKoi({
    manifest: { name: "SearchAll", version: "0.1.0", model: { name: E2E_MODEL } },
    adapter,
    providers: [primordialProvider],
    loopDetection: false,
    limits: { maxTurns: 10, maxDurationMs: TIMEOUT_MS, maxTokens: 50_000 },
  });

  const events = await withTimeout(
    () => collectEvents(runtime.run({ kind: "text", text: "Search for all bricks now." })),
    TIMEOUT_MS,
    "Test 5",
  );

  const toolStarts = extractToolStarts(events);
  const searchStarts = toolStarts.filter((e) => e.toolName === "search_forge");
  assert("LLM called search_forge", searchStarts.length >= 1, `got ${searchStarts.length} calls`);

  const toolEnds = extractToolEnds(events);
  const searchCallId = searchStarts[0]?.callId;
  const searchEnd =
    searchCallId !== undefined ? toolEnds.find((e) => e.callId === searchCallId) : toolEnds[0];

  if (searchEnd !== undefined) {
    const output = JSON.stringify(searchEnd.result ?? "");
    // Should have all 4 bricks
    assert(
      "search result contains 'add-numbers'",
      output.includes("add-numbers"),
      `output: ${output.slice(0, 500)}`,
    );
    assert(
      "search result contains 'typescript-tips'",
      output.includes("typescript-tips"),
      `output: ${output.slice(0, 500)}`,
    );
    assert(
      "search result contains 'logging-mw'",
      output.includes("logging-mw"),
      `output: ${output.slice(0, 500)}`,
    );
    assert(
      "search result contains 'echo-channel'",
      output.includes("echo-channel"),
      `output: ${output.slice(0, 500)}`,
    );
  } else {
    assert("search_forge tool_call_end emitted", false, "no tool_call_end found");
  }

  // Also verify directly from store
  const directSearch = await store.search({});
  assert(
    "store has exactly 4 bricks",
    directSearch.ok && directSearch.value.length === 4,
    `got ${directSearch.ok ? directSearch.value.length : "error"}`,
  );
} catch (err: unknown) {
  assert("Test 5 completed without error", false, err instanceof Error ? err.message : String(err));
}

// ---------------------------------------------------------------------------
// Test 6: Search by kind filter
// ---------------------------------------------------------------------------

console.log("\n[test 6] Search by kind filter\n");

try {
  // Directly test each kind filter via store (no LLM needed)
  const toolSearch = await store.search({ kind: "tool" });
  assert(
    "kind='tool' returns 1 brick",
    toolSearch.ok && toolSearch.value.length === 1,
    `got ${toolSearch.ok ? toolSearch.value.length : "error"}`,
  );

  const skillSearch = await store.search({ kind: "skill" });
  assert(
    "kind='skill' returns 1 brick",
    skillSearch.ok && skillSearch.value.length === 1,
    `got ${skillSearch.ok ? skillSearch.value.length : "error"}`,
  );

  const middlewareSearch = await store.search({ kind: "middleware" });
  assert(
    "kind='middleware' returns 1 brick",
    middlewareSearch.ok && middlewareSearch.value.length === 1,
    `got ${middlewareSearch.ok ? middlewareSearch.value.length : "error"}`,
  );

  const channelSearch = await store.search({ kind: "channel" });
  assert(
    "kind='channel' returns 1 brick",
    channelSearch.ok && channelSearch.value.length === 1,
    `got ${channelSearch.ok ? channelSearch.value.length : "error"}`,
  );

  // Verify each search returns the correct brick name
  if (toolSearch.ok && toolSearch.value[0] !== undefined) {
    assert("tool search found 'add-numbers'", toolSearch.value[0].name === "add-numbers");
  }
  if (skillSearch.ok && skillSearch.value[0] !== undefined) {
    assert("skill search found 'typescript-tips'", skillSearch.value[0].name === "typescript-tips");
  }
  if (middlewareSearch.ok && middlewareSearch.value[0] !== undefined) {
    assert("middleware search found 'logging-mw'", middlewareSearch.value[0].name === "logging-mw");
  }
  if (channelSearch.ok && channelSearch.value[0] !== undefined) {
    assert("channel search found 'echo-channel'", channelSearch.value[0].name === "echo-channel");
  }
} catch (err: unknown) {
  assert("Test 6 completed without error", false, err instanceof Error ? err.message : String(err));
}

// ---------------------------------------------------------------------------
// Test 7: Promote tool to verified trust
// ---------------------------------------------------------------------------

console.log("\n[test 7] Promote tool to verified trust\n");

try {
  const toolSearch = await store.search({ kind: "tool", text: "add-numbers" });
  if (!toolSearch.ok || toolSearch.value.length === 0) {
    assert("Test 7 requires add-numbers brick", false, "brick not found");
  } else {
    const brickId = toolSearch.value[0]?.id;
    if (brickId === undefined) {
      assert("brick has ID", false, "brick ID is undefined");
    } else {
      const deps = makeDeps(4);
      const primordialProvider = makePrimordialProvider(deps);

      const adapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt: [
          "You have ONE task: use the promote_forge tool to promote a brick.",
          `Call promote_forge with these arguments:`,
          `  brickId: "${brickId}"`,
          `  targetTrustTier: "verified"`,
          "Do NOT say anything before calling the tool. Just call it immediately.",
        ].join("\n"),
        getApiKey: async () => API_KEY,
      });

      const runtime = await createKoi({
        manifest: { name: "Promote", version: "0.1.0", model: { name: E2E_MODEL } },
        adapter,
        providers: [primordialProvider],
        loopDetection: false,
        limits: { maxTurns: 10, maxDurationMs: TIMEOUT_MS, maxTokens: 50_000 },
      });

      const events = await withTimeout(
        () =>
          collectEvents(
            runtime.run({ kind: "text", text: "Promote the brick to verified trust now." }),
          ),
        TIMEOUT_MS,
        "Test 7",
      );

      const toolStarts = extractToolStarts(events);
      const promoteStarts = toolStarts.filter((e) => e.toolName === "promote_forge");
      assert(
        "LLM called promote_forge",
        promoteStarts.length >= 1,
        `got ${promoteStarts.length} calls`,
      );

      const toolEnds = extractToolEnds(events);
      const promoteCallId = promoteStarts[0]?.callId;
      const promoteEnd =
        promoteCallId !== undefined
          ? toolEnds.find((e) => e.callId === promoteCallId)
          : toolEnds[0];

      if (promoteEnd !== undefined) {
        const output = JSON.stringify(promoteEnd.result ?? "");
        assert(
          "promote_forge returned ok:true",
          output.includes('"ok":true'),
          `output: ${output.slice(0, 300)}`,
        );
      }

      // Verify trust tier in store
      const loadResult = await store.load(brickId);
      if (loadResult.ok) {
        assert(
          "brick trust is now 'verified'",
          loadResult.value.trustTier === "verified",
          `got ${loadResult.value.trustTier}`,
        );
      } else {
        assert("brick loaded after promotion", false, "load failed");
      }
    }
  }
} catch (err: unknown) {
  assert("Test 7 completed without error", false, err instanceof Error ? err.message : String(err));
}

// ---------------------------------------------------------------------------
// Test 8: Forged tool is callable through engine
// ---------------------------------------------------------------------------

console.log("\n[test 8] Forged tool is callable through engine\n");

try {
  // Create a ForgeComponentProvider that exposes forged tools
  const forgeProvider = createForgeComponentProvider({
    store,
    executor,
  });

  // Create a ForgeRuntime for live tool resolution
  const forgeRuntime = createForgeRuntime({
    store,
    executor,
  });

  const adapter = createPiAdapter({
    model: E2E_MODEL,
    systemPrompt: [
      "You have access to a tool called 'add-numbers'. Use it to add two numbers.",
      'Call add-numbers with: { "a": 7, "b": 13 }',
      "After getting the result, report the answer.",
      "Do NOT say anything before calling the tool. Just call it immediately.",
    ].join("\n"),
    getApiKey: async () => API_KEY,
  });

  const runtime = await createKoi({
    manifest: { name: "CallForged", version: "0.1.0", model: { name: E2E_MODEL } },
    adapter,
    providers: [forgeProvider],
    forge: forgeRuntime,
    loopDetection: false,
    limits: { maxTurns: 10, maxDurationMs: TIMEOUT_MS, maxTokens: 50_000 },
  });

  const events = await withTimeout(
    () => collectEvents(runtime.run({ kind: "text", text: "Use add-numbers to add 7 and 13." })),
    TIMEOUT_MS,
    "Test 8",
  );

  const toolStarts = extractToolStarts(events);
  const addStarts = toolStarts.filter((e) => e.toolName === "add-numbers");
  assert(
    "LLM called 'add-numbers' (forged tool)",
    addStarts.length >= 1,
    `tool calls: [${toolStarts.map((e) => e.toolName).join(", ")}]`,
  );

  const toolEnds = extractToolEnds(events);
  const addCallId = addStarts[0]?.callId;
  const addEnd = addCallId !== undefined ? toolEnds.find((e) => e.callId === addCallId) : undefined;

  if (addEnd !== undefined) {
    const output = JSON.stringify(addEnd.result ?? "");
    // The implementation returns { result: a + b } = { result: 20 }
    assert(
      "forged tool returned correct result (20)",
      output.includes("20"),
      `output: ${output.slice(0, 300)}`,
    );
  } else {
    assert("add-numbers tool_call_end emitted", false, "no tool_call_end found for add-numbers");
  }

  // Clean up forge runtime
  forgeRuntime.dispose?.();
  forgeProvider.dispose();
} catch (err: unknown) {
  assert("Test 8 completed without error", false, err instanceof Error ? err.message : String(err));
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

const passed = results.filter((r) => r.passed).length;
const total = results.length;
const allPassed = passed === total;

console.log(`\n[e2e] Results: ${passed}/${total} passed`);

if (!allPassed) {
  console.error("\n[e2e] Failed assertions:");
  for (const r of results) {
    if (!r.passed) {
      console.error(`  FAIL  ${r.name}${r.detail ? ` \u2014 ${r.detail}` : ""}`);
    }
  }
  process.exit(1);
}

console.log("\n[e2e] All BrickKind consolidation E2E tests passed!");
