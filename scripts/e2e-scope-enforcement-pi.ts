#!/usr/bin/env bun
/**
 * E2E: ForgeScope Enforcement with Pi-Engine (Real LLM).
 *
 * Validates that agent-scoped bricks are invisible to other agents across
 * all access paths: search_forge, ForgeResolver (discover/load/source),
 * and promote_forge.
 *
 * Flow:
 *   Test 1: Alpha forges a "secret-calc" tool  → agent-scoped, owned by alpha
 *   Test 2: Beta searches for bricks           → must NOT see alpha's agent-scoped brick
 *   Test 3: Alpha promotes to global           → scope updated
 *   Test 4: Beta searches again                → now sees the global-scoped brick
 *   Test 5: Alpha forges a 2nd agent-scoped brick "private-util"
 *   Test 6: Beta tries to promote alpha's agent-scoped brick     → must fail
 *   Test 7: ForgeResolver respects scope (discover/load/source)
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-... bun scripts/e2e-scope-enforcement-pi.ts
 */

import type { ComponentProvider, EngineEvent } from "../packages/core/src/index.js";
import { toolToken } from "../packages/core/src/index.js";
import { createKoi } from "../packages/engine/src/koi.js";
import { createPiAdapter } from "../packages/engine-pi/src/adapter.js";
import { createDefaultForgeConfig } from "../packages/forge/src/config.js";
import { createForgeResolver } from "../packages/forge/src/forge-resolver.js";
import { createInMemoryForgeStore } from "../packages/forge/src/memory-store.js";
import { createForgeToolTool } from "../packages/forge/src/tools/forge-tool.js";
import { createPromoteForgeTool } from "../packages/forge/src/tools/promote-forge.js";
import { createSearchForgeTool } from "../packages/forge/src/tools/search-forge.js";
import type { ForgeDeps } from "../packages/forge/src/tools/shared.js";
import type { SandboxExecutor, TieredSandboxExecutor } from "../packages/forge/src/types.js";

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

const API_KEY = process.env.ANTHROPIC_API_KEY;
if (!API_KEY) {
  console.error("[e2e] ANTHROPIC_API_KEY is not set. Skipping.");
  process.exit(0);
}

console.log("[e2e] Starting ForgeScope enforcement pi-engine E2E tests...\n");

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

const tieredExecutor: TieredSandboxExecutor = {
  forTier: (tier) => ({
    executor,
    requestedTier: tier,
    resolvedTier: tier,
    fallback: false,
  }),
};

const config = createDefaultForgeConfig({
  maxForgesPerSession: 50,
  scopePromotion: {
    requireHumanApproval: false,
    minTrustForZone: "sandbox",
    minTrustForGlobal: "sandbox",
  },
});

function makeDeps(agentId: string, forgesThisSession: number): ForgeDeps {
  return {
    store,
    executor: tieredExecutor,
    verifiers: [],
    config,
    context: {
      agentId,
      depth: 0,
      sessionId: `e2e-scope-${agentId}-${Date.now()}`,
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
  const promoteTool = createPromoteForgeTool(deps);
  const searchTool = createSearchForgeTool(deps);

  const entries: ReadonlyArray<[string, unknown]> = [
    [toolToken("forge_tool"), forgeTool],
    [toolToken("promote_forge"), promoteTool],
    [toolToken("search_forge"), searchTool],
  ];

  return {
    name: "forge-primordials",
    attach: async (): Promise<ReadonlyMap<string, unknown>> => new Map(entries),
  };
}

// ---------------------------------------------------------------------------
// Test 1: Agent Alpha forges an agent-scoped "secret-calc" tool
// ---------------------------------------------------------------------------

console.log("[test 1] Alpha forges an agent-scoped 'secret-calc' tool via real LLM\n");

try {
  const alphaDeps = makeDeps("alpha-agent", 0);
  const primordialProvider = makePrimordialProvider(alphaDeps);

  const adapter = createPiAdapter({
    model: E2E_MODEL,
    systemPrompt: [
      "You are a tool-forging agent. You have ONE task: use the forge_tool tool to create a tool.",
      "Call forge_tool with EXACTLY these arguments:",
      '  name: "secret-calc"',
      '  description: "A secret calculator that triples a number"',
      '  inputSchema: { "type": "object", "properties": { "n": { "type": "number" } }, "required": ["n"] }',
      '  implementation: "const n = input.n || 0; return { result: n * 3 };"',
      "Do NOT say anything before calling the tool. Just call it immediately.",
    ].join("\n"),
    getApiKey: async () => API_KEY,
  });

  const runtime = await createKoi({
    manifest: { name: "Alpha", version: "0.1.0", model: { name: E2E_MODEL } },
    adapter,
    providers: [primordialProvider],
    loopDetection: false,
    limits: { maxTurns: 10, maxDurationMs: TIMEOUT_MS, maxTokens: 50_000 },
  });

  const events = await withTimeout(
    () => collectEvents(runtime.run({ kind: "text", text: "Forge the secret-calc tool now." })),
    TIMEOUT_MS,
    "Test 1",
  );

  const toolStarts = extractToolStarts(events);
  const forgeStarts = toolStarts.filter((e) => e.toolName === "forge_tool");
  assert("Alpha called forge_tool", forgeStarts.length >= 1, `got ${forgeStarts.length} calls`);

  const searchResult = await store.search({ kind: "tool", text: "secret-calc" });
  const hasBrick = searchResult.ok && searchResult.value.length >= 1;
  assert("store contains 'secret-calc' brick", hasBrick);

  if (searchResult.ok && searchResult.value[0] !== undefined) {
    const brick = searchResult.value[0];
    assert("brick scope is 'agent' (default)", brick.scope === "agent", `got ${brick.scope}`);
    assert(
      "brick createdBy is alpha-agent",
      brick.createdBy === "alpha-agent",
      `got ${brick.createdBy}`,
    );
    console.log(`    Brick ID: ${brick.id}`);
  }
} catch (err: unknown) {
  assert("Test 1 completed without error", false, err instanceof Error ? err.message : String(err));
}

// ---------------------------------------------------------------------------
// Test 2: Beta searches — must NOT see alpha's agent-scoped brick
// ---------------------------------------------------------------------------

console.log("\n[test 2] Beta searches for bricks — alpha's agent-scoped brick must be invisible\n");

try {
  const betaDeps = makeDeps("beta-agent", 0);
  const primordialProvider = makePrimordialProvider(betaDeps);

  const adapter = createPiAdapter({
    model: E2E_MODEL,
    systemPrompt: [
      "You have ONE task: use the search_forge tool to search for ALL bricks.",
      "Call search_forge with an empty object {} as input.",
      "After getting the result, report exactly how many bricks were found.",
      "Do NOT say anything before calling the tool. Just call it immediately.",
    ].join("\n"),
    getApiKey: async () => API_KEY,
  });

  const runtime = await createKoi({
    manifest: { name: "Beta", version: "0.1.0", model: { name: E2E_MODEL } },
    adapter,
    providers: [primordialProvider],
    loopDetection: false,
    limits: { maxTurns: 10, maxDurationMs: TIMEOUT_MS, maxTokens: 50_000 },
  });

  const events = await withTimeout(
    () => collectEvents(runtime.run({ kind: "text", text: "Search for all bricks now." })),
    TIMEOUT_MS,
    "Test 2",
  );

  const toolStarts = extractToolStarts(events);
  const searchStarts = toolStarts.filter((e) => e.toolName === "search_forge");
  assert("Beta called search_forge", searchStarts.length >= 1, `got ${searchStarts.length} calls`);

  // Verify the search_forge result returned empty (beta can't see alpha's agent-scoped brick)
  const toolEnds = extractToolEnds(events);
  const searchCallId = searchStarts[0]?.callId;
  const searchEnd =
    searchCallId !== undefined ? toolEnds.find((e) => e.callId === searchCallId) : toolEnds[0];

  if (searchEnd !== undefined) {
    const output = JSON.stringify(searchEnd.result ?? "");
    // The result should be ok:true with an empty value array
    const hasSecretCalc = output.includes("secret-calc");
    assert(
      "Beta's search result does NOT contain 'secret-calc'",
      !hasSecretCalc,
      `output: ${output.slice(0, 300)}`,
    );
  } else {
    assert("search_forge tool_call_end emitted", false, "no tool_call_end found");
  }
} catch (err: unknown) {
  assert("Test 2 completed without error", false, err instanceof Error ? err.message : String(err));
}

// ---------------------------------------------------------------------------
// Test 3: Alpha promotes brick to global scope
// ---------------------------------------------------------------------------

console.log("\n[test 3] Alpha promotes secret-calc to global scope\n");

let secretCalcBrickId: string | undefined;

try {
  const searchResult = await store.search({ kind: "tool", text: "secret-calc" });
  if (!searchResult.ok || searchResult.value.length === 0) {
    assert("Test 3 requires secret-calc brick", false, "brick not found");
  } else {
    secretCalcBrickId = searchResult.value[0]?.id;
    if (secretCalcBrickId === undefined) {
      assert("brick has ID", false, "brick ID is undefined");
    } else {
      const alphaDeps = makeDeps("alpha-agent", 1);
      const primordialProvider = makePrimordialProvider(alphaDeps);

      const adapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt: [
          "You have ONE task: use the promote_forge tool to promote a brick.",
          `Call promote_forge with these arguments:`,
          `  brickId: "${secretCalcBrickId}"`,
          `  targetScope: "global"`,
          "Do NOT say anything before calling the tool. Just call it immediately.",
        ].join("\n"),
        getApiKey: async () => API_KEY,
      });

      const runtime = await createKoi({
        manifest: { name: "Alpha-Promote", version: "0.1.0", model: { name: E2E_MODEL } },
        adapter,
        providers: [primordialProvider],
        loopDetection: false,
        limits: { maxTurns: 10, maxDurationMs: TIMEOUT_MS, maxTokens: 50_000 },
      });

      const events = await withTimeout(
        () =>
          collectEvents(runtime.run({ kind: "text", text: "Promote the brick to global now." })),
        TIMEOUT_MS,
        "Test 3",
      );

      const toolStarts = extractToolStarts(events);
      const promoteStarts = toolStarts.filter((e) => e.toolName === "promote_forge");
      assert(
        "Alpha called promote_forge",
        promoteStarts.length >= 1,
        `got ${promoteStarts.length} calls`,
      );

      const loadResult = await store.load(secretCalcBrickId);
      if (loadResult.ok) {
        assert(
          "brick scope is now 'global'",
          loadResult.value.scope === "global",
          `got ${loadResult.value.scope}`,
        );
      } else {
        assert("brick loaded after promotion", false, "load failed");
      }
    }
  }
} catch (err: unknown) {
  assert("Test 3 completed without error", false, err instanceof Error ? err.message : String(err));
}

// ---------------------------------------------------------------------------
// Test 4: Beta searches again — now sees the global-scoped brick
// ---------------------------------------------------------------------------

console.log("\n[test 4] Beta searches again — now sees the global-scoped brick\n");

try {
  const betaDeps = makeDeps("beta-agent", 0);
  const primordialProvider = makePrimordialProvider(betaDeps);

  const adapter = createPiAdapter({
    model: E2E_MODEL,
    systemPrompt: [
      "You have ONE task: use the search_forge tool to search for ALL bricks.",
      "Call search_forge with an empty object {} as input.",
      "After getting the result, report the names of all bricks found.",
      "Do NOT say anything before calling the tool. Just call it immediately.",
    ].join("\n"),
    getApiKey: async () => API_KEY,
  });

  const runtime = await createKoi({
    manifest: { name: "Beta-Search-2", version: "0.1.0", model: { name: E2E_MODEL } },
    adapter,
    providers: [primordialProvider],
    loopDetection: false,
    limits: { maxTurns: 10, maxDurationMs: TIMEOUT_MS, maxTokens: 50_000 },
  });

  const events = await withTimeout(
    () => collectEvents(runtime.run({ kind: "text", text: "Search for all bricks now." })),
    TIMEOUT_MS,
    "Test 4",
  );

  const toolStarts = extractToolStarts(events);
  const searchStarts = toolStarts.filter((e) => e.toolName === "search_forge");
  assert("Beta called search_forge", searchStarts.length >= 1, `got ${searchStarts.length} calls`);

  const toolEnds = extractToolEnds(events);
  const searchCallId = searchStarts[0]?.callId;
  const searchEnd =
    searchCallId !== undefined ? toolEnds.find((e) => e.callId === searchCallId) : toolEnds[0];

  if (searchEnd !== undefined) {
    const output = JSON.stringify(searchEnd.result ?? "");
    assert(
      "Beta's search result NOW contains 'secret-calc'",
      output.includes("secret-calc"),
      `output: ${output.slice(0, 300)}`,
    );
  } else {
    assert("search_forge tool_call_end emitted", false, "no tool_call_end found");
  }
} catch (err: unknown) {
  assert("Test 4 completed without error", false, err instanceof Error ? err.message : String(err));
}

// ---------------------------------------------------------------------------
// Test 5: Alpha forges a 2nd agent-scoped brick "private-util"
// ---------------------------------------------------------------------------

console.log("\n[test 5] Alpha forges a 2nd agent-scoped brick 'private-util'\n");

try {
  const alphaDeps = makeDeps("alpha-agent", 2);
  const primordialProvider = makePrimordialProvider(alphaDeps);

  const adapter = createPiAdapter({
    model: E2E_MODEL,
    systemPrompt: [
      "You have ONE task: use the forge_tool tool to create a tool.",
      "Call forge_tool with EXACTLY these arguments:",
      '  name: "private-util"',
      '  description: "A private utility that adds 10 to a number"',
      '  inputSchema: { "type": "object", "properties": { "n": { "type": "number" } }, "required": ["n"] }',
      '  implementation: "const n = input.n || 0; return { result: n + 10 };"',
      "Do NOT say anything before calling the tool. Just call it immediately.",
    ].join("\n"),
    getApiKey: async () => API_KEY,
  });

  const runtime = await createKoi({
    manifest: { name: "Alpha-Forge-2", version: "0.1.0", model: { name: E2E_MODEL } },
    adapter,
    providers: [primordialProvider],
    loopDetection: false,
    limits: { maxTurns: 10, maxDurationMs: TIMEOUT_MS, maxTokens: 50_000 },
  });

  const events = await withTimeout(
    () => collectEvents(runtime.run({ kind: "text", text: "Forge the private-util tool now." })),
    TIMEOUT_MS,
    "Test 5",
  );

  const toolStarts = extractToolStarts(events);
  assert(
    "Alpha called forge_tool",
    toolStarts.some((e) => e.toolName === "forge_tool"),
  );

  const searchResult = await store.search({ text: "private-util" });
  assert("store contains 'private-util'", searchResult.ok && searchResult.value.length >= 1);
} catch (err: unknown) {
  assert("Test 5 completed without error", false, err instanceof Error ? err.message : String(err));
}

// ---------------------------------------------------------------------------
// Test 6: Beta tries to promote alpha's agent-scoped brick → must fail
// ---------------------------------------------------------------------------

console.log("\n[test 6] Beta tries to promote alpha's agent-scoped 'private-util' → must fail\n");

try {
  const searchResult = await store.search({ text: "private-util" });
  if (!searchResult.ok || searchResult.value.length === 0) {
    assert("Test 6 requires private-util brick", false, "not found");
  } else {
    const privateUtilId = searchResult.value[0]?.id;
    if (privateUtilId === undefined) {
      assert("private-util has ID", false, "ID undefined");
    } else {
      const betaDeps = makeDeps("beta-agent", 0);
      const primordialProvider = makePrimordialProvider(betaDeps);

      const adapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt: [
          "You have ONE task: use the promote_forge tool to promote a brick.",
          `Call promote_forge with these arguments:`,
          `  brickId: "${privateUtilId}"`,
          `  targetScope: "global"`,
          "Do NOT say anything before calling the tool. Just call it immediately.",
        ].join("\n"),
        getApiKey: async () => API_KEY,
      });

      const runtime = await createKoi({
        manifest: { name: "Beta-Promote", version: "0.1.0", model: { name: E2E_MODEL } },
        adapter,
        providers: [primordialProvider],
        loopDetection: false,
        limits: { maxTurns: 10, maxDurationMs: TIMEOUT_MS, maxTokens: 50_000 },
      });

      const events = await withTimeout(
        () =>
          collectEvents(runtime.run({ kind: "text", text: "Promote the brick to global now." })),
        TIMEOUT_MS,
        "Test 6",
      );

      const toolStarts = extractToolStarts(events);
      const promoteStarts = toolStarts.filter((e) => e.toolName === "promote_forge");
      assert(
        "Beta called promote_forge",
        promoteStarts.length >= 1,
        `got ${promoteStarts.length} calls`,
      );

      // The promote result should fail
      const toolEnds = extractToolEnds(events);
      const promoteCallId = promoteStarts[0]?.callId;
      const promoteEnd =
        promoteCallId !== undefined
          ? toolEnds.find((e) => e.callId === promoteCallId)
          : toolEnds[0];

      if (promoteEnd !== undefined) {
        const output = JSON.stringify(promoteEnd.result ?? "");
        assert(
          "promote_forge failed (foreign brick treated as not found)",
          output.includes("not found") ||
            output.includes("LOAD_FAILED") ||
            output.includes('"ok":false'),
          `output: ${output.slice(0, 300)}`,
        );
      } else {
        assert("promote_forge tool_call_end emitted", false, "no tool_call_end found");
      }

      // Verify the brick's scope is still "agent" (not promoted)
      const loadResult = await store.load(privateUtilId);
      if (loadResult.ok) {
        assert(
          "private-util scope is still 'agent' (unchanged)",
          loadResult.value.scope === "agent",
          `got ${loadResult.value.scope}`,
        );
      }
    }
  }
} catch (err: unknown) {
  assert("Test 6 completed without error", false, err instanceof Error ? err.message : String(err));
}

// ---------------------------------------------------------------------------
// Test 7: ForgeResolver respects scope (discover/load/source) — no LLM needed
// ---------------------------------------------------------------------------

console.log("\n[test 7] ForgeResolver respects scope (discover/load/source)\n");

try {
  // Alpha's resolver should see both bricks
  const alphaResolver = createForgeResolver(store, { agentId: "alpha-agent" });
  const alphaDiscover = await alphaResolver.discover();
  const alphaNames = alphaDiscover.map((b) => b.name);
  assert(
    "Alpha resolver discovers 'secret-calc'",
    alphaNames.includes("secret-calc"),
    `found: [${alphaNames.join(", ")}]`,
  );
  assert(
    "Alpha resolver discovers 'private-util'",
    alphaNames.includes("private-util"),
    `found: [${alphaNames.join(", ")}]`,
  );

  // Beta's resolver should see global bricks but NOT alpha's agent-scoped brick
  const betaResolver = createForgeResolver(store, { agentId: "beta-agent" });
  const betaDiscover = await betaResolver.discover();
  const betaNames = betaDiscover.map((b) => b.name);
  assert(
    "Beta resolver discovers 'secret-calc' (now global)",
    betaNames.includes("secret-calc"),
    `found: [${betaNames.join(", ")}]`,
  );
  assert(
    "Beta resolver does NOT discover 'private-util' (agent-scoped by alpha)",
    !betaNames.includes("private-util"),
    `found: [${betaNames.join(", ")}]`,
  );

  // Beta's resolver: load alpha's agent-scoped brick → NOT_FOUND
  const privateUtilSearch = await store.search({ text: "private-util" });
  if (privateUtilSearch.ok && privateUtilSearch.value[0] !== undefined) {
    const privateUtilId = privateUtilSearch.value[0].id;

    const loadResult = await betaResolver.load(privateUtilId);
    assert("Beta load() of alpha's agent-scoped brick returns NOT_FOUND", !loadResult.ok);
    if (!loadResult.ok) {
      assert(
        "error code is NOT_FOUND",
        loadResult.error.code === "NOT_FOUND",
        `got ${loadResult.error.code}`,
      );
    }

    // source() also blocked
    const sourceResult = await betaResolver.source?.(privateUtilId);
    assert(
      "Beta source() of alpha's agent-scoped brick returns NOT_FOUND",
      sourceResult !== undefined && !sourceResult.ok,
    );

    // Alpha CAN load/source its own brick
    const alphaLoadResult = await alphaResolver.load(privateUtilId);
    assert("Alpha load() of own agent-scoped brick succeeds", alphaLoadResult.ok);

    const alphaSourceResult = await alphaResolver.source?.(privateUtilId);
    assert("Alpha source() of own agent-scoped brick succeeds", alphaSourceResult?.ok);
  }

  // Beta's resolver: load beta's own brick → succeeds
  const betaLoadOwn = await betaResolver.load("brick_beta_own");
  assert("Beta load() of own brick succeeds", betaLoadOwn.ok);
} catch (err: unknown) {
  assert("Test 7 completed without error", false, err instanceof Error ? err.message : String(err));
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

console.log("\n[e2e] All ForgeScope enforcement E2E tests passed!");
