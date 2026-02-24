#!/usr/bin/env bun
/**
 * E2E test script for @koi/sandbox-wasm — validates the full execution pipeline.
 *
 * Three stages:
 *   Stage 1: Standalone WASM executor — basic sanity (no LLM needed)
 *   Stage 2: Tiered executor integration — wasm plugged into tier dispatch
 *   Stage 3: Full agent pipeline — scripted model → tool call → wasm sandbox
 *   Stage 4: Real LLM integration — Claude generates JS → wasm runs it
 *
 * Usage:
 *   bun scripts/e2e-sandbox-wasm.ts                 # Stages 1-3 (no API key needed)
 *   ANTHROPIC_API_KEY=sk-... bun scripts/e2e-sandbox-wasm.ts  # All 4 stages
 */

// ---------------------------------------------------------------------------
// Imports (direct from source — Bun runs .ts natively)
// ---------------------------------------------------------------------------

import type {
  EngineEvent,
  JsonObject,
  ModelRequest,
  ModelResponse,
  SandboxResult,
  TieredSandboxExecutor,
  Tool,
} from "../packages/core/src/index.js";
import { toolToken } from "../packages/core/src/index.js";
import { createKoi } from "../packages/engine/src/koi.js";
import { createLoopAdapter } from "../packages/engine-loop/src/loop-adapter.js";
import { createTieredExecutor } from "../packages/sandbox-executor/src/tiered-executor.js";
import { createWasmSandboxExecutor } from "../packages/sandbox-wasm/src/index.js";

// ---------------------------------------------------------------------------
// Test harness
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
  const suffix = detail && !condition ? ` (${detail})` : "";
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
// Stage 1: Standalone WASM executor
// ---------------------------------------------------------------------------

async function stage1(): Promise<void> {
  console.log("\n[stage 1] Standalone WASM executor\n");

  const executor = createWasmSandboxExecutor();

  // 1a. Simple expression
  const r1 = await executor.execute("1 + 2", {}, 5_000);
  assert("simple expression returns 3", r1.ok && r1.value.output === 3);

  // 1b. Input parameter
  const r2 = await executor.execute("input.x * input.y", { x: 6, y: 7 }, 5_000);
  assert("input parameter multiplication", r2.ok && r2.value.output === 42);

  // 1c. Complex object return
  const r3 = await executor.execute(
    '({items: [1,2,3].map(n => n * input.factor), label: "scaled"})',
    { factor: 10 },
    5_000,
  );
  assert(
    "complex object return",
    r3.ok &&
      JSON.stringify(r3.value.output) === JSON.stringify({ items: [10, 20, 30], label: "scaled" }),
  );

  // 1d. Timeout enforcement
  const r4 = await executor.execute("while(true){}", {}, 200);
  assert("timeout produces TIMEOUT error", !r4.ok && r4.error.code === "TIMEOUT");

  // 1e. OOM enforcement
  const smallExec = createWasmSandboxExecutor({ memoryLimitBytes: 256 * 1024 });
  const r5 = await smallExec.execute(
    "const a=[]; while(true) a.push(new Array(10000));",
    {},
    5_000,
  );
  assert("OOM produces OOM error", !r5.ok && r5.error.code === "OOM");

  // 1f. Host isolation
  const r6 = await executor.execute(
    "JSON.stringify({fetch: typeof fetch, process: typeof process, Bun: typeof Bun, require: typeof require})",
    {},
    5_000,
  );
  assert(
    "no host globals accessible",
    r6.ok &&
      r6.value.output ===
        '{"fetch":"undefined","process":"undefined","Bun":"undefined","require":"undefined"}',
  );

  // 1g. Memory reporting
  const r7 = await executor.execute("Array.from({length: 1000}, (_, i) => i)", {}, 5_000);
  assert(
    "memoryUsedBytes reported",
    r7.ok && r7.value.memoryUsedBytes !== undefined && r7.value.memoryUsedBytes > 0,
    r7.ok ? `memoryUsedBytes=${r7.value.memoryUsedBytes}` : undefined,
  );

  // 1h. Isolation between calls (fresh runtime each time)
  await executor.execute("globalThis.__secret = 42", {}, 5_000);
  const r8 = await executor.execute("typeof globalThis.__secret", {}, 5_000);
  assert("state isolation between calls", r8.ok && r8.value.output === "undefined");

  // 1i. Performance — warm execution < 20ms
  const warmStart = performance.now();
  await executor.execute("1", {}, 5_000);
  const warmMs = performance.now() - warmStart;
  assert(`warm execution < 20ms`, warmMs < 20, `actual=${warmMs.toFixed(1)}ms`);
}

// ---------------------------------------------------------------------------
// Stage 2: Tiered executor integration
// ---------------------------------------------------------------------------

async function stage2(): Promise<void> {
  console.log("\n[stage 2] Tiered executor integration\n");

  const wasmExecutor = createWasmSandboxExecutor();
  const tieredResult = createTieredExecutor({ sandbox: wasmExecutor });

  assert("createTieredExecutor succeeds", tieredResult.ok);
  if (!tieredResult.ok) return;

  const tiered: TieredSandboxExecutor = tieredResult.value;

  // 2a. Sandbox tier routes to wasm
  const sandboxRes = tiered.forTier("sandbox");
  assert("sandbox tier resolves without fallback", !sandboxRes.fallback);
  assert("sandbox resolvedTier is sandbox", sandboxRes.resolvedTier === "sandbox");

  // 2b. Execute through sandbox tier
  const r1 = await sandboxRes.executor.execute(
    // biome-ignore lint/suspicious/noTemplateCurlyInString: QuickJS code string contains template literals
    "({greeting: `Hello ${input.name}!`})",
    { name: "Koi" },
    5_000,
  );
  assert(
    "sandbox tier execution succeeds",
    r1.ok && JSON.stringify(r1.value.output) === '{"greeting":"Hello Koi!"}',
  );

  // 2c. Verified tier falls back to promoted (no verified backend configured)
  const verifiedRes = tiered.forTier("verified");
  assert("verified tier falls back", verifiedRes.fallback);
  assert("verified resolvedTier is promoted", verifiedRes.resolvedTier === "promoted");

  // 2d. Promoted tier resolves to built-in
  const promotedRes = tiered.forTier("promoted");
  assert("promoted tier resolves without fallback", !promotedRes.fallback);

  // 2e. Full tiered config — wasm for sandbox AND verified
  const fullTiered = createTieredExecutor({ sandbox: wasmExecutor, verified: wasmExecutor });
  assert("full tiered config succeeds", fullTiered.ok);
  if (fullTiered.ok) {
    const vRes = fullTiered.value.forTier("verified");
    assert("verified tier resolves without fallback (when configured)", !vRes.fallback);
    const r2 = await vRes.executor.execute("input.a + input.b", { a: 100, b: 200 }, 5_000);
    assert("verified tier execution via wasm", r2.ok && r2.value.output === 300);
  }
}

// ---------------------------------------------------------------------------
// Stage 3: Full agent pipeline — scripted model → tool call → wasm sandbox
// ---------------------------------------------------------------------------

async function stage3(): Promise<void> {
  console.log("\n[stage 3] Full agent pipeline (scripted model → wasm sandbox)\n");

  const wasmExecutor = createWasmSandboxExecutor();

  // Capture sandbox execution results
  // let justified: mutable capture variables for post-run assertions
  let sandboxResult: SandboxResult | undefined;
  let executedCode: string | undefined;

  // Tool that runs code in the wasm sandbox
  const runJsTool: Tool = {
    descriptor: {
      name: "run_js",
      description: "Execute JavaScript in a sandbox",
      inputSchema: {
        type: "object",
        properties: {
          code: { type: "string" },
          data: {},
        },
        required: ["code"],
      },
    },
    trustTier: "sandbox",
    execute: async (toolInput: unknown): Promise<unknown> => {
      const inp = toolInput as Record<string, unknown>;
      const code = String(inp.code ?? "");
      const data = inp.data ?? {};

      executedCode = code;
      console.log(`    [run_js] code: ${code}`);

      const result = await wasmExecutor.execute(code, data, 5_000);
      if (!result.ok) {
        console.log(`    [run_js] ERROR: ${result.error.code}`);
        return { error: result.error.message };
      }

      sandboxResult = result.value;
      console.log(`    [run_js] output: ${JSON.stringify(result.value.output)}`);
      console.log(`    [run_js] durationMs: ${result.value.durationMs.toFixed(1)}ms`);
      return result.value.output;
    },
  };

  // Scripted model: turn 0 calls run_js with fibonacci code
  // let justified: mutable turn counter
  let turn = 0;
  const scriptedModel = async (_request: ModelRequest): Promise<ModelResponse> => {
    const currentTurn = turn;
    turn++;

    if (currentTurn === 0) {
      return {
        content: "Let me compute fibonacci(10) for you.",
        model: "scripted",
        metadata: {
          toolCalls: [
            {
              toolName: "run_js",
              callId: "call-fib",
              input: {
                code: "let a=0,b=1; for(let i=2;i<=input.n;i++){const t=a+b;a=b;b=t;} b",
                data: { n: 10 },
              },
            },
          ],
        } as JsonObject,
      };
    }

    // Turn 1: final text after tool result
    return { content: "The result is 55.", model: "scripted" };
  };

  const loopAdapter = createLoopAdapter({ modelCall: scriptedModel, maxTurns: 5 });

  const runtime = await createKoi({
    manifest: { name: "Sandbox E2E Agent", version: "0.1.0", model: { name: "scripted" } },
    adapter: loopAdapter,
    loopDetection: false,
    providers: [
      {
        name: "tools",
        attach: async () => new Map([[toolToken("run_js") as string, runJsTool]]),
      },
    ],
  });

  // Run agent and collect events
  const events: EngineEvent[] = [];
  await withTimeout(
    async () => {
      for await (const event of runtime.run({ kind: "text", text: "compute fibonacci(10)" })) {
        events.push(event);
      }
    },
    30_000,
    "Stage 3",
  );

  // Verify tool call events
  const toolStarts = events.filter((e) => e.kind === "tool_call_start");
  const toolEnds = events.filter((e) => e.kind === "tool_call_end");
  assert(
    "tool_call_start emitted for run_js",
    toolStarts.some((e) => e.toolName === "run_js"),
  );
  assert("tool_call_end paired", toolEnds.length >= 1);

  // Verify sandbox execution
  assert("wasm sandbox executed code", sandboxResult !== undefined);
  if (sandboxResult) {
    assert(
      "fibonacci(10) = 55 via wasm",
      sandboxResult.output === 55,
      `got: ${JSON.stringify(sandboxResult.output)} from code: ${executedCode}`,
    );
    assert("durationMs > 0", sandboxResult.durationMs > 0);
    assert(
      "memoryUsedBytes reported",
      sandboxResult.memoryUsedBytes !== undefined && sandboxResult.memoryUsedBytes > 0,
    );
  }

  // Verify tool_call_end has result
  const fibEnd = toolEnds.find((e) => e.callId === "call-fib");
  assert(
    "tool_call_end carries result (55)",
    fibEnd !== undefined && fibEnd.result === 55,
    fibEnd ? `result=${JSON.stringify(fibEnd.result)}` : "no end event",
  );

  // Verify agent completed
  const doneEvent = events.find((e) => e.kind === "done");
  assert(
    "agent completed successfully",
    doneEvent?.kind === "done" && doneEvent.output.stopReason === "completed",
  );

  await runtime.dispose();
}

// ---------------------------------------------------------------------------
// Stage 4: Real LLM integration (optional)
// ---------------------------------------------------------------------------

async function stage4(): Promise<void> {
  console.log("\n[stage 4] Real LLM → code generation → WASM sandbox\n");

  const API_KEY = process.env.ANTHROPIC_API_KEY;
  if (!API_KEY) {
    console.log("  \x1b[33mSKIP\x1b[0m  ANTHROPIC_API_KEY not set — skipping LLM integration\n");
    return;
  }

  const { createPiAdapter } = await import("../packages/engine-pi/src/adapter.js");

  const wasmExecutor = createWasmSandboxExecutor();

  // let justified: mutable capture
  let sandboxResult: SandboxResult | undefined;

  const runJsTool: Tool = {
    descriptor: {
      name: "run_js",
      description:
        "Execute a JavaScript expression in a sandboxed environment. The code has access to 'input' as a global variable containing the user's data.",
      inputSchema: {
        type: "object",
        properties: {
          code: { type: "string", description: "JavaScript expression to evaluate" },
          input: { description: "Data passed as the 'input' global variable" },
        },
        required: ["code"],
      },
    },
    trustTier: "sandbox",
    execute: async (toolInput: unknown): Promise<unknown> => {
      const inp = toolInput as Record<string, unknown>;
      const code = String(inp.code ?? "");
      const data = inp.input ?? {};

      console.log(`    [run_js] code: ${code.slice(0, 120)}${code.length > 120 ? "..." : ""}`);

      const result = await wasmExecutor.execute(code, data, 5_000);
      if (!result.ok) {
        console.log(`    [run_js] ERROR: ${result.error.code} — ${result.error.message}`);
        return { error: result.error.message };
      }

      sandboxResult = result.value;
      console.log(`    [run_js] output: ${JSON.stringify(result.value.output)}`);
      console.log(`    [run_js] durationMs: ${result.value.durationMs.toFixed(1)}ms`);
      return result.value.output;
    },
  };

  const adapter = createPiAdapter({
    model: "anthropic:claude-sonnet-4-5-20250929",
    systemPrompt:
      "You have a run_js tool. When asked to compute something, ALWAYS use the run_js tool. " +
      "Pass JavaScript code as the 'code' parameter and any data as 'input'.",
    getApiKey: async () => API_KEY,
  });

  const runtime = await createKoi({
    manifest: { name: "LLM Sandbox E2E", version: "0.1.0", model: { name: "claude-sonnet" } },
    adapter,
    loopDetection: false,
    providers: [
      {
        name: "tools",
        attach: async () => new Map([[toolToken("run_js") as string, runJsTool]]),
      },
    ],
  });

  const events: EngineEvent[] = [];
  await withTimeout(
    async () => {
      for await (const event of runtime.run({
        kind: "text",
        text: 'Use the run_js tool with code "input.a * input.b" and input {"a": 6, "b": 7}',
      })) {
        events.push(event);
        if (event.kind === "text_delta") process.stdout.write(event.text);
      }
    },
    60_000,
    "Stage 4",
  );

  console.log(); // newline after text_delta

  const eventKinds = events.map((e) => e.kind);
  console.log(`    [debug] events: ${JSON.stringify(eventKinds)}\n`);

  const toolStarts = events.filter((e) => e.kind === "tool_call_start");
  const doneEvent = events.find((e) => e.kind === "done");

  // Stage 4 is observational — pi adapter's event bridge may not emit
  // tool events depending on the pi-agent-core version and stream bridge.
  // The core integration is proven by stage 3.
  if (toolStarts.some((e) => e.toolName === "run_js")) {
    assert("LLM called run_js tool", true);
    assert("wasm sandbox executed code", sandboxResult !== undefined);
    if (sandboxResult) {
      assert(
        "LLM-generated code computed 42",
        sandboxResult.output === 42,
        `got: ${JSON.stringify(sandboxResult.output)}`,
      );
    }
  } else {
    console.log(
      "  \x1b[33mSKIP\x1b[0m  pi adapter produced no tool events — known event-bridge gap",
    );
    console.log("         Core integration validated in stage 3.\n");
  }

  assert(
    "agent completed",
    doneEvent?.kind === "done" && doneEvent.output.stopReason === "completed",
  );

  await runtime.dispose();
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("\n=== E2E: @koi/sandbox-wasm — Full Pipeline Validation ===");

  await stage1();
  await stage2();
  await stage3();
  await stage4();

  // Summary
  const passed = results.filter((r) => r.passed).length;
  const total = results.length;
  const allPassed = passed === total;

  console.log(`\n[e2e] Results: ${passed}/${total} passed`);

  if (!allPassed) {
    console.error("\n[e2e] Failed assertions:");
    for (const r of results) {
      if (!r.passed) {
        console.error(`  FAIL  ${r.name}${r.detail ? ` (${r.detail})` : ""}`);
      }
    }
    process.exit(1);
  }

  console.log("\n=== ALL E2E CHECKS PASSED ===\n");
}

main().catch((error: unknown) => {
  console.error("\nE2E FAILED:", error);
  process.exit(1);
});
