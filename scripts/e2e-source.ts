#!/usr/bin/env bun
/**
 * Manual E2E test — Resolver.source() with real LLM call.
 *
 * Validates the complete source() pipeline:
 *   1. ForgeResolver.source() for all 4 brick kinds
 *   2. LocalResolver.source() for directory + built-in tools
 *   3. Real LLM (Claude Haiku) reads source and reasons about it
 *   4. Real LLM identifies a bug in source code (the Fork use case)
 *
 * Run:
 *   bun scripts/e2e-source.ts          (reads ANTHROPIC_API_KEY from .env)
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalResolver } from "../packages/deploy/node/src/tools/local-resolver.js";
import type { SourceBundle, ToolArtifact } from "../packages/kernel/core/src/index.js";
import { createForgeResolver } from "../packages/meta/forge/src/forge-resolver.js";
import { createInMemoryForgeStore } from "../packages/meta/forge/src/memory-store.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY ?? "";
if (!ANTHROPIC_KEY) {
  console.error("ERROR: ANTHROPIC_API_KEY not set. Skipping LLM tests.");
  console.error("Set ANTHROPIC_API_KEY in .env or environment.");
}

let passed = 0;
let failed = 0;

function ok(name: string): void {
  passed++;
  console.log(`  \x1b[32m✓\x1b[0m ${name}`);
}

function fail(name: string, error: unknown): void {
  failed++;
  console.log(`  \x1b[31m✗\x1b[0m ${name}`);
  if (error instanceof Error) {
    console.log(`    ${error.message}`);
    if (error.cause) console.log(`    cause: ${JSON.stringify(error.cause)}`);
  } else if (typeof error === "object" && error !== null) {
    console.log(`    ${JSON.stringify(error, null, 2)}`);
  } else {
    console.log(`    ${String(error)}`);
  }
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createToolBrick(overrides?: Partial<ToolArtifact>): ToolArtifact {
  return {
    id: `brick_${Math.random().toString(36).slice(2, 10)}`,
    kind: "tool",
    name: "fibonacci",
    description: "Computes the Nth Fibonacci number using dynamic programming",
    scope: "agent",
    trustTier: "sandbox",
    lifecycle: "active",
    createdBy: "agent-1",
    createdAt: Date.now(),
    version: "0.0.1",
    tags: ["math"],
    usageCount: 0,
    contentHash: "abc123",
    implementation: [
      "function fibonacci(n: number): number {",
      "  if (n <= 1) return n;",
      "  let a = 0, b = 1;",
      "  for (let i = 2; i <= n; i++) {",
      "    const c = a + b;",
      "    a = b;",
      "    b = c;",
      "  }",
      "  return b;",
      "}",
      "return fibonacci(input.n);",
    ].join("\n"),
    inputSchema: { type: "object", properties: { n: { type: "number" } } },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Part 1: ForgeResolver.source() — all 4 brick kinds
// ---------------------------------------------------------------------------

async function testForgeResolverSource(): Promise<void> {
  console.log("\n\x1b[1mPart 1: ForgeResolver.source()\x1b[0m");

  // Tool → typescript
  try {
    const store = createInMemoryForgeStore();
    await store.save(createToolBrick({ id: "fib-1" }));
    const resolver = createForgeResolver(store, { agentId: "agent-1" });
    assert(resolver.source !== undefined, "source should be defined");
    if (resolver.source === undefined) throw new Error("unreachable");
    const result = await resolver.source("fib-1");
    assert(result.ok === true, "expected ok");
    if (!result.ok) throw new Error("unreachable");
    assert(
      result.value.language === "typescript",
      `expected typescript, got ${result.value.language}`,
    );
    assert(result.value.content.includes("fibonacci"), "expected fibonacci in content");
    ok("tool brick → typescript source");
  } catch (e: unknown) {
    fail("tool brick → typescript source", e);
  }

  // Skill → markdown
  try {
    const store = createInMemoryForgeStore();
    await store.save({
      id: "skill-1",
      kind: "skill",
      name: "greeting-guide",
      description: "How to greet",
      scope: "agent",
      trustTier: "sandbox",
      lifecycle: "active",
      createdBy: "a1",
      createdAt: Date.now(),
      version: "0.0.1",
      tags: [],
      usageCount: 0,
      contentHash: "h1",
      content: "# Greeting Guide\n\nSay hello warmly.",
    });
    const resolver = createForgeResolver(store, { agentId: "a1" });
    assert(resolver.source !== undefined, "source should be defined");
    if (resolver.source === undefined) throw new Error("unreachable");
    const result = await resolver.source("skill-1");
    assert(result.ok === true, "expected ok");
    if (!result.ok) throw new Error("unreachable");
    assert(result.value.language === "markdown", `expected markdown, got ${result.value.language}`);
    assert(result.value.content.includes("# Greeting Guide"), "expected heading in content");
    ok("skill brick → markdown source");
  } catch (e: unknown) {
    fail("skill brick → markdown source", e);
  }

  // Agent → yaml
  try {
    const store = createInMemoryForgeStore();
    await store.save({
      id: "agent-1",
      kind: "agent",
      name: "math-agent",
      description: "Math",
      scope: "agent",
      trustTier: "sandbox",
      lifecycle: "active",
      createdBy: "a1",
      createdAt: Date.now(),
      version: "0.0.1",
      tags: [],
      usageCount: 0,
      contentHash: "h2",
      manifestYaml: "name: math-agent\nversion: 0.0.1\nmodel: gpt-4o-mini",
    });
    const resolver = createForgeResolver(store, { agentId: "a1" });
    assert(resolver.source !== undefined, "source should be defined");
    if (resolver.source === undefined) throw new Error("unreachable");
    const result = await resolver.source("agent-1");
    assert(result.ok === true, "expected ok");
    if (!result.ok) throw new Error("unreachable");
    assert(result.value.language === "yaml", `expected yaml, got ${result.value.language}`);
    assert(result.value.content.includes("math-agent"), "expected agent name in content");
    ok("agent brick → yaml source");
  } catch (e: unknown) {
    fail("agent brick → yaml source", e);
  }

  // Composite → json
  try {
    const store = createInMemoryForgeStore();
    await store.save({
      id: "comp-1",
      kind: "composite",
      name: "math-suite",
      description: "Combined",
      scope: "agent",
      trustTier: "sandbox",
      lifecycle: "active",
      createdBy: "a1",
      createdAt: Date.now(),
      version: "0.0.1",
      tags: [],
      usageCount: 0,
      contentHash: "h3",
      brickIds: ["fib-1", "skill-1"],
    });
    const resolver = createForgeResolver(store, { agentId: "a1" });
    assert(resolver.source !== undefined, "source should be defined");
    if (resolver.source === undefined) throw new Error("unreachable");
    const result = await resolver.source("comp-1");
    assert(result.ok === true, "expected ok");
    if (!result.ok) throw new Error("unreachable");
    assert(result.value.language === "json", `expected json, got ${result.value.language}`);
    const ids = JSON.parse(result.value.content) as readonly string[];
    assert(ids.includes("fib-1"), "expected fib-1 in brickIds");
    ok("composite brick → json source");
  } catch (e: unknown) {
    fail("composite brick → json source", e);
  }

  // NOT_FOUND
  try {
    const store = createInMemoryForgeStore();
    const resolver = createForgeResolver(store, { agentId: "any" });
    assert(resolver.source !== undefined, "source should be defined");
    if (resolver.source === undefined) throw new Error("unreachable");
    const result = await resolver.source("nonexistent");
    assert(result.ok === false, "expected error");
    if (result.ok) throw new Error("unreachable");
    assert(result.error.code === "NOT_FOUND", `expected NOT_FOUND, got ${result.error.code}`);
    ok("missing brick → NOT_FOUND");
  } catch (e: unknown) {
    fail("missing brick → NOT_FOUND", e);
  }

  // Companion files
  try {
    const store = createInMemoryForgeStore();
    await store.save(
      createToolBrick({ id: "with-files", files: { "helper.ts": "export const PI = 3.14;" } }),
    );
    const resolver = createForgeResolver(store, { agentId: "agent-1" });
    assert(resolver.source !== undefined, "source should be defined");
    if (resolver.source === undefined) throw new Error("unreachable");
    const result = await resolver.source("with-files");
    assert(result.ok === true, "expected ok");
    if (!result.ok) throw new Error("unreachable");
    assert(result.value.files !== undefined, "expected files");
    const helperContent = result.value.files?.["helper.ts"];
    assert(helperContent !== undefined, "expected helper.ts in files");
    assert(helperContent.includes("PI"), "expected PI in helper");
    ok("companion files included");
  } catch (e: unknown) {
    fail("companion files included", e);
  }
}

// ---------------------------------------------------------------------------
// Part 2: LocalResolver.source()
// ---------------------------------------------------------------------------

async function testLocalResolverSource(): Promise<void> {
  console.log("\n\x1b[1mPart 2: LocalResolver.source()\x1b[0m");

  const testDir = await mkdtemp(join(tmpdir(), "koi-source-e2e-"));
  await Bun.write(
    join(testDir, "calc.tool.json"),
    JSON.stringify({
      name: "calculator",
      description: "A simple calculator",
      inputSchema: { type: "object", properties: { expression: { type: "string" } } },
      command: 'echo "result"',
    }),
  );

  try {
    // Directory tool → JSON
    try {
      const resolver = createLocalResolver({
        directories: [testDir],
        builtins: { filesystem: false, shell: false },
      });
      const result = await resolver.source("calculator");
      assert(result.ok === true, "expected ok");
      if (!result.ok) throw new Error("unreachable");
      assert(result.value.language === "json", `expected json, got ${result.value.language}`);
      const parsed = JSON.parse(result.value.content) as { readonly name: string };
      assert(parsed.name === "calculator", `expected calculator, got ${parsed.name}`);
      ok("directory tool → JSON source");
    } catch (e: unknown) {
      fail("directory tool → JSON source", e);
    }

    // Built-in → NOT_FOUND with Shadow pattern message
    try {
      const resolver = createLocalResolver({
        directories: [],
        builtins: { filesystem: true, shell: false },
      });
      const result = await resolver.source("filesystem");
      assert(result.ok === false, "expected error");
      if (result.ok) throw new Error("unreachable");
      assert(result.error.code === "NOT_FOUND", `expected NOT_FOUND, got ${result.error.code}`);
      assert(result.error.message.includes("Shadow pattern"), "expected Shadow pattern hint");
      ok("built-in tool → NOT_FOUND with Shadow pattern message");
    } catch (e: unknown) {
      fail("built-in tool → NOT_FOUND with Shadow pattern message", e);
    }

    // Unknown → NOT_FOUND
    try {
      const resolver = createLocalResolver({
        directories: [],
        builtins: { filesystem: false, shell: false },
      });
      const result = await resolver.source("nonexistent");
      assert(result.ok === false, "expected error");
      if (result.ok) throw new Error("unreachable");
      assert(result.error.code === "NOT_FOUND", `expected NOT_FOUND, got ${result.error.code}`);
      ok("unknown tool → NOT_FOUND");
    } catch (e: unknown) {
      fail("unknown tool → NOT_FOUND", e);
    }
  } finally {
    await rm(testDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Part 3: Real LLM (Anthropic Claude) reads source() output and reasons
// ---------------------------------------------------------------------------

interface AnthropicResponse {
  readonly content: readonly { readonly type: string; readonly text?: string }[];
}

async function callClaude(prompt: string): Promise<string> {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 256,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Anthropic API ${response.status}: ${body}`);
  }
  const data = (await response.json()) as AnthropicResponse;
  return data.content
    .filter(
      (c): c is { readonly type: string; readonly text: string } =>
        c.type === "text" && c.text !== undefined,
    )
    .map((c) => c.text)
    .join("");
}

async function testLlmReadsSource(): Promise<void> {
  if (!ANTHROPIC_KEY) {
    console.log("\n\x1b[1mPart 3: LLM reads source (SKIPPED — no ANTHROPIC_API_KEY)\x1b[0m");
    return;
  }

  console.log("\n\x1b[1mPart 3: Real LLM (Claude) reads source() output\x1b[0m");

  // Test 3a: LLM reads fibonacci source from resolver and explains it
  try {
    const store = createInMemoryForgeStore();
    await store.save(createToolBrick({ id: "fib-tool" }));
    const resolver = createForgeResolver(store, { agentId: "agent-1" });

    assert(resolver.source !== undefined, "source should be defined");
    if (resolver.source === undefined) throw new Error("unreachable");
    const sourceResult = await resolver.source("fib-tool");
    assert(sourceResult.ok === true, "source() failed");
    if (!sourceResult.ok) throw new Error("unreachable");

    const bundle: SourceBundle = sourceResult.value;
    assert(bundle.language === "typescript", `expected typescript, got ${bundle.language}`);

    const explanation = await callClaude(
      [
        "Below is a tool's TypeScript source code.",
        "Explain in ONE sentence what this tool does. Include the algorithm name if recognizable.",
        "",
        "```typescript",
        bundle.content,
        "```",
      ].join("\n"),
    );

    console.log(`    LLM said: "${explanation.slice(0, 200)}"`);

    const lower = explanation.toLowerCase();
    assert(lower.includes("fibonacci") || lower.includes("fib"), "LLM should mention fibonacci");
    ok("LLM reads fibonacci source and explains it correctly");
  } catch (e: unknown) {
    fail("LLM reads fibonacci source and explains it correctly", e);
  }

  // Test 3b: LLM identifies a bug in source() output (the Fork use case)
  try {
    const store = createInMemoryForgeStore();
    await store.save(
      createToolBrick({
        id: "buggy-fib",
        name: "buggy-fibonacci",
        implementation: [
          "function fibonacci(n: number): number {",
          "  if (n <= 1) return n;",
          "  let a = 0, b = 1;",
          "  for (let i = 1; i <= n; i++) {  // BUG: should start at 2",
          "    const c = a + b;",
          "    a = b;",
          "    b = c;",
          "  }",
          "  return b;",
          "}",
          "return fibonacci(input.n);",
        ].join("\n"),
      }),
    );

    const resolver = createForgeResolver(store, { agentId: "agent-1" });
    assert(resolver.source !== undefined, "source should be defined");
    if (resolver.source === undefined) throw new Error("unreachable");
    const sourceResult = await resolver.source("buggy-fib");
    assert(sourceResult.ok === true, "source() failed");
    if (!sourceResult.ok) throw new Error("unreachable");

    const review = await callClaude(
      [
        "Review this TypeScript code for bugs. The function should compute Fibonacci numbers.",
        "fibonacci(0)=0, fibonacci(1)=1, fibonacci(2)=1, fibonacci(3)=2, fibonacci(5)=5.",
        "",
        "```typescript",
        sourceResult.value.content,
        "```",
        "",
        "If there's a bug, explain it in ONE sentence. Focus on loop initialization.",
      ].join("\n"),
    );

    console.log(`    LLM said: "${review.slice(0, 200)}"`);

    const lower = review.toLowerCase();
    assert(
      lower.includes("1") ||
        lower.includes("2") ||
        lower.includes("off") ||
        lower.includes("start") ||
        lower.includes("loop") ||
        lower.includes("bug") ||
        lower.includes("iteration") ||
        lower.includes("extra"),
      "LLM should identify the loop bug",
    );
    ok("LLM identifies off-by-one bug in source code");
  } catch (e: unknown) {
    fail("LLM identifies off-by-one bug in source code", e);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

console.log("=== Resolver.source() E2E Test ===");

await testForgeResolverSource();
await testLocalResolverSource();
await testLlmReadsSource();

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
if (failed > 0) {
  process.exit(1);
}
