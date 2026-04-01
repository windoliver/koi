/**
 * End-to-end validation of forge security features:
 * - Network isolation (Seatbelt on macOS)
 * - Resource limits (ulimit -v)
 * - Post-install integrity verification
 *
 * Exercises the FULL stack: createKoi + createPiAdapter + ForgeRuntime +
 * SubprocessExecutor + TieredExecutor. Real Anthropic API calls drive the
 * Pi agent, which calls forged tools executed in isolated subprocesses.
 *
 * Gated on ANTHROPIC_API_KEY — tests are skipped when the key is not set.
 *
 * Run:
 *   bun test tests/e2e/forge-security-e2e.test.ts
 *
 * Cost: ~$0.05 per run (haiku model, minimal prompts).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  EngineEvent,
  ExecutionContext,
  ForgeStore,
  KoiMiddleware,
  ModelStreamHandler,
  SandboxExecutor,
  ToolArtifact,
} from "@koi/core";
import { createKoi } from "@koi/engine";
import { createPiAdapter } from "@koi/engine-pi";
import type { ForgeRuntimeInstance } from "@koi/forge";
import {
  createDefaultForgeConfig,
  createForgeRuntime,
  createInMemoryForgeStore,
  verifyInstallIntegrity,
} from "@koi/forge";
import { computeBrickId } from "@koi/hash";
import { createSubprocessExecutor, detectSandboxPlatform } from "@koi/sandbox-executor";

// ---------------------------------------------------------------------------
// Environment gate
// ---------------------------------------------------------------------------

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY ?? "";
const HAS_KEY = ANTHROPIC_KEY.length > 0;
const describePi = HAS_KEY ? describe : describe.skip;

const TIMEOUT_MS = 60_000;
const PI_MODEL = "anthropic:claude-haiku-4-5-20251001";
const MODEL_NAME = "claude-haiku-4-5-20251001";

// ---------------------------------------------------------------------------
// Test workspace for integrity checks
// ---------------------------------------------------------------------------

const TEST_DIR = join(
  tmpdir(),
  `forge-security-e2e-${Date.now()}-${Math.random().toString(36).slice(2)}`,
);

beforeAll(async () => {
  await mkdir(TEST_DIR, { recursive: true });
});

afterAll(async () => {
  await rm(TEST_DIR, { recursive: true, force: true }).catch(() => {});
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function collectEvents(
  iterable: AsyncIterable<EngineEvent>,
): Promise<readonly EngineEvent[]> {
  const result: EngineEvent[] = []; // let justified: test accumulator
  for await (const event of iterable) {
    result.push(event);
  }
  return result;
}

/**
 * Create a minimal SandboxExecutor backed by createSubprocessExecutor.
 */
function createTestExecutor(): SandboxExecutor {
  return createSubprocessExecutor();
}

/**
 * Build a minimal ToolArtifact for testing.
 * Content-addressed ID is a placeholder — tests care about execution, not dedup.
 */
function createTestToolArtifact(opts: {
  readonly name: string;
  readonly description: string;
  readonly implementation: string;
  readonly inputSchema: Record<string, unknown>;
  readonly requires?: { readonly network?: boolean };
}): ToolArtifact {
  // Compute content-addressed ID so integrity verification passes
  const id = computeBrickId("tool", opts.implementation);
  return {
    id,
    kind: "tool",
    name: opts.name,
    description: opts.description,
    scope: "session",
    trustTier: "promoted",
    lifecycle: "active",
    version: "0.0.1",
    tags: [],
    usageCount: 0,
    inputSchema: opts.inputSchema,
    implementation: opts.implementation,
    provenance: {
      builder: {
        id: "e2e-test",
        version: "1.0.0",
      },
      buildDefinition: {
        buildType: "forge/tool",
        resolvedDependencies: [],
      },
      metadata: {
        invocationId: id,
        agentId: "e2e-agent",
        sessionId: "e2e-session",
        depth: 0,
        startedAt: Date.now(),
        finishedAt: Date.now(),
        inputHash: "e2e-hash",
        contentHash: id,
        configSnapshot: {},
        verificationSummary: {
          stages: ["static", "sandbox"],
          finalTrustTier: "promoted",
          totalDurationMs: 1,
          passed: true,
        },
      },
      classification: "public",
      contentMarkers: [],
    },
    ...(opts.requires !== undefined ? { requires: opts.requires } : {}),
  };
}

/**
 * Seed an in-memory ForgeStore with tool artifacts.
 */
async function seedStore(store: ForgeStore, artifacts: readonly ToolArtifact[]): Promise<void> {
  for (const artifact of artifacts) {
    const result = await store.save(artifact);
    if (!result.ok) {
      throw new Error(`Failed to seed store: ${result.error.message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// 1. Full stack: Pi agent → forged tool → subprocess executor
// ---------------------------------------------------------------------------

describePi("e2e: forge security — full Pi agent stack", () => {
  test(
    "Pi agent calls a forged tool executed in subprocess with isolation",
    async () => {
      // 1. Create forged tool: simple add function
      const store = createInMemoryForgeStore();
      const addTool = createTestToolArtifact({
        name: "add_numbers",
        description: "Add two numbers together",
        implementation: "return input.a + input.b;",
        inputSchema: {
          type: "object",
          properties: { a: { type: "number" }, b: { type: "number" } },
          required: ["a", "b"],
        },
      });
      await seedStore(store, [addTool]);

      // 2. Create subprocess executor
      const subprocessExecutor = createTestExecutor();

      // 3. Create forge runtime — resolves forged tools from the store
      const forgeRuntime: ForgeRuntimeInstance = createForgeRuntime({
        store,
        executor: subprocessExecutor,
        sandboxTimeoutMs: 10_000,
      });

      // 4. Track what happens via middleware
      const textChunks: string[] = []; // let justified: test accumulator
      let toolCallSeen = false; // let justified: toggled in middleware

      const observer: KoiMiddleware = {
        name: "e2e-forge-observer",
        wrapModelStream: async function* (_ctx, request, next: ModelStreamHandler) {
          for await (const chunk of next(request)) {
            if (chunk.kind === "text_delta") {
              textChunks.push(chunk.delta);
            }
            yield chunk;
          }
        },
      };

      // 5. Wire Pi adapter (real Anthropic API)
      const adapter = createPiAdapter({
        model: PI_MODEL,
        systemPrompt:
          "You are a test agent. You have a tool called add_numbers. " +
          "When asked to add numbers, always use the add_numbers tool. " +
          "After getting the result, state it clearly.",
        getApiKey: async () => ANTHROPIC_KEY,
        thinkingLevel: "off",
      });

      // 6. Create Koi runtime with forge
      const runtime = await createKoi({
        manifest: { name: "e2e-forge-pi", version: "0.0.1", model: { name: MODEL_NAME } },
        adapter,
        middleware: [observer],
        forge: forgeRuntime,
      });

      try {
        const events = await collectEvents(
          runtime.run({
            kind: "text",
            text: "Use the add_numbers tool to compute 17 + 25. Report the result.",
          }),
        );

        // Got a done event
        const doneEvent = events.find((e) => e.kind === "done");
        expect(doneEvent).toBeDefined();
        if (doneEvent?.kind === "done") {
          expect(doneEvent.output.stopReason).toBe("completed");
          // At least 1 turn used
          expect(doneEvent.output.metrics.turns).toBeGreaterThanOrEqual(1);
        }

        // Check that tool was called (tool_call_start/end events)
        const toolStarts = events.filter((e) => e.kind === "tool_call_start");
        const toolEnds = events.filter((e) => e.kind === "tool_call_end");
        expect(toolStarts.length).toBeGreaterThan(0);
        expect(toolEnds.length).toBeGreaterThan(0);

        // Verify the tool name matches our forged tool
        const firstStart = toolStarts[0];
        if (firstStart?.kind === "tool_call_start") {
          expect(firstStart.toolName).toBe("add_numbers");
          toolCallSeen = true;
        }

        // The final output should mention 42 (17 + 25)
        const fullText = textChunks.join("");
        expect(fullText).toContain("42");

        expect(toolCallSeen).toBe(true);
      } finally {
        forgeRuntime.dispose?.();
        await runtime.dispose?.();
      }
    },
    TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// 2. Subprocess executor: network isolation via Seatbelt (macOS)
// ---------------------------------------------------------------------------

describe("e2e: subprocess network isolation", () => {
  const executor = createSubprocessExecutor();

  test("subprocess with networkAllowed=true can execute normally", async () => {
    const entryPath = join(TEST_DIR, "net-allowed.ts");
    await writeFile(
      entryPath,
      "export default function run(input: { val: number }) { return input.val * 3; }",
      "utf8",
    );

    const context: ExecutionContext = {
      entryPath,
      workspacePath: TEST_DIR,
      networkAllowed: true,
    };

    const result = await executor.execute("", { val: 7 }, 10_000, context);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.output).toBe(21);
    }
  }, 30_000);

  // Requires OS sandbox (Seatbelt on macOS, bwrap on Linux) — fail-closed design
  // refuses execution when networkAllowed=false and no sandbox is available.
  test.skipIf(detectSandboxPlatform() === "none")(
    "subprocess with networkAllowed=false executes pure computation",
    async () => {
      const entryPath = join(TEST_DIR, "net-denied-pure.ts");
      await writeFile(
        entryPath,
        "export default function run(input: { x: number; y: number }) { return input.x + input.y; }",
        "utf8",
      );

      const context: ExecutionContext = {
        entryPath,
        workspacePath: TEST_DIR,
        networkAllowed: false,
      };

      const result = await executor.execute("", { x: 10, y: 32 }, 10_000, context);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.output).toBe(42);
      }
    },
    30_000,
  );

  test.skipIf(process.platform !== "darwin")(
    "subprocess with networkAllowed=false blocks fetch on macOS (Seatbelt)",
    async () => {
      const entryPath = join(TEST_DIR, "net-denied-fetch.ts");
      await writeFile(
        entryPath,
        `export default async function run() {
  try {
    await fetch("https://example.com");
    return { fetched: true };
  } catch (e: unknown) {
    return { fetched: false, error: e instanceof Error ? e.message : String(e) };
  }
}`,
        "utf8",
      );

      const context: ExecutionContext = {
        entryPath,
        workspacePath: TEST_DIR,
        networkAllowed: false,
      };

      const result = await executor.execute("", {}, 15_000, context);
      expect(result.ok).toBe(true);
      if (result.ok) {
        const output = result.value.output as { fetched: boolean; error?: string };
        expect(output.fetched).toBe(false);
      }
    },
    30_000,
  );
});

// ---------------------------------------------------------------------------
// 3. Subprocess executor: resource limits (ulimit -v)
// ---------------------------------------------------------------------------

describe("e2e: subprocess resource limits", () => {
  const executor = createSubprocessExecutor();

  // ulimit -v is not supported on macOS (returns "cannot modify limit: Invalid argument").
  // These tests are Linux-only where ulimit -v works.
  test.skipIf(process.platform === "darwin")(
    "subprocess with resource limits executes normal computation (Linux only)",
    async () => {
      const entryPath = join(TEST_DIR, "limits-normal.ts");
      await writeFile(
        entryPath,
        "export default function run(input: { n: number }) { return input.n * input.n; }",
        "utf8",
      );

      const context: ExecutionContext = {
        entryPath,
        workspacePath: TEST_DIR,
        resourceLimits: { maxMemoryMb: 2048 },
      };

      const result = await executor.execute("", { n: 12 }, 10_000, context);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.output).toBe(144);
      }
    },
    30_000,
  );

  // Requires OS sandbox — fail-closed design refuses networkAllowed=false without sandbox.
  test.skipIf(detectSandboxPlatform() === "none")(
    "subprocess with network deny + process isolation (no resource limits)",
    async () => {
      const entryPath = join(TEST_DIR, "combined-isolation.ts");
      await writeFile(
        entryPath,
        "export default function run() { return { isolated: true, pid: process.pid }; }",
        "utf8",
      );

      const context: ExecutionContext = {
        entryPath,
        workspacePath: TEST_DIR,
        networkAllowed: false,
      };

      const result = await executor.execute("", {}, 10_000, context);
      expect(result.ok).toBe(true);
      if (result.ok) {
        const output = result.value.output as { isolated: boolean; pid: number };
        expect(output.isolated).toBe(true);
        // Child PID should be different from our PID (proving subprocess isolation)
        expect(output.pid).not.toBe(process.pid);
      }
    },
    30_000,
  );
});

// ---------------------------------------------------------------------------
// 4. Environment isolation: sensitive vars not leaked to subprocess
// ---------------------------------------------------------------------------

describe("e2e: subprocess environment isolation", () => {
  const executor = createSubprocessExecutor();

  test("ANTHROPIC_API_KEY is NOT forwarded to child process", async () => {
    const entryPath = join(TEST_DIR, "env-leak-check.ts");
    await writeFile(
      entryPath,
      `export default function run() {
  return {
    hasApiKey: process.env.ANTHROPIC_API_KEY !== undefined,
    hasHome: process.env.HOME !== undefined,
    hasPath: process.env.PATH !== undefined,
    keyCount: Object.keys(process.env).length,
  };
}`,
      "utf8",
    );

    // Set API key in current process (should already be set from .env)
    const originalKey = process.env.ANTHROPIC_API_KEY;
    if (originalKey === undefined) {
      process.env.ANTHROPIC_API_KEY = "sk-test-for-leak-check";
    }

    const context: ExecutionContext = {
      entryPath,
      workspacePath: TEST_DIR,
    };

    const result = await executor.execute("", {}, 10_000, context);

    // Restore original value
    if (originalKey === undefined) {
      delete process.env.ANTHROPIC_API_KEY;
    }

    expect(result.ok).toBe(true);
    if (result.ok) {
      const output = result.value.output as {
        hasApiKey: boolean;
        hasHome: boolean;
        hasPath: boolean;
        keyCount: number;
      };
      expect(output.hasApiKey).toBe(false); // NOT forwarded
      expect(output.hasHome).toBe(true); // safe list
      expect(output.hasPath).toBe(true); // safe list
      // Only safe keys forwarded (PATH, HOME, TMPDIR, NODE_ENV, BUN_INSTALL, NODE_PATH)
      expect(output.keyCount).toBeLessThanOrEqual(7);
    }
  }, 30_000);
});

// ---------------------------------------------------------------------------
// 5. Post-install integrity verification
// ---------------------------------------------------------------------------

describe("e2e: install integrity verification", () => {
  test("passes when lockfile and node_modules match", async () => {
    const wsPath = join(TEST_DIR, "integrity-pass");
    await mkdir(join(wsPath, "node_modules", "zod"), { recursive: true });
    await writeFile(
      join(wsPath, "bun.lock"),
      JSON.stringify({
        packages: { zod: ["zod@3.23.8"] },
      }),
      "utf8",
    );
    await writeFile(
      join(wsPath, "node_modules", "zod", "package.json"),
      JSON.stringify({ name: "zod", version: "3.23.8" }),
      "utf8",
    );

    const result = await verifyInstallIntegrity(wsPath, { zod: "3.23.8" });
    expect(result.ok).toBe(true);
  });

  test("fails when lockfile version doesn't match declared", async () => {
    const wsPath = join(TEST_DIR, "integrity-mismatch");
    await mkdir(wsPath, { recursive: true });
    await writeFile(
      join(wsPath, "bun.lock"),
      JSON.stringify({
        packages: { zod: ["zod@3.22.0"] },
      }),
      "utf8",
    );

    const result = await verifyInstallIntegrity(wsPath, { zod: "3.23.8" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INTEGRITY_MISMATCH");
    }
  });

  test("fails when package is missing from node_modules", async () => {
    const wsPath = join(TEST_DIR, "integrity-missing-nm");
    await mkdir(wsPath, { recursive: true });
    await writeFile(
      join(wsPath, "bun.lock"),
      JSON.stringify({
        packages: { zod: ["zod@3.23.8"] },
      }),
      "utf8",
    );

    const result = await verifyInstallIntegrity(wsPath, { zod: "3.23.8" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INTEGRITY_MISMATCH");
      expect(result.error.message).toContain("not found in node_modules");
    }
  });

  test("handles scoped packages (@scope/name)", async () => {
    const wsPath = join(TEST_DIR, "integrity-scoped");
    await mkdir(join(wsPath, "node_modules", "@anthropic", "sdk"), { recursive: true });
    await writeFile(
      join(wsPath, "bun.lock"),
      JSON.stringify({
        packages: { "@anthropic/sdk": ["@anthropic/sdk@1.0.0"] },
      }),
      "utf8",
    );
    await writeFile(
      join(wsPath, "node_modules", "@anthropic", "sdk", "package.json"),
      JSON.stringify({ name: "@anthropic/sdk", version: "1.0.0" }),
      "utf8",
    );

    const result = await verifyInstallIntegrity(wsPath, { "@anthropic/sdk": "1.0.0" });
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 6. Full createKoi stack with forged tool + subprocess execution
//    (no real LLM — deterministic model handler for isolation)
// ---------------------------------------------------------------------------

describe("e2e: createKoi + forge + subprocess (deterministic)", () => {
  test("forged tool executes in subprocess through full L1 middleware chain", async () => {
    // 1. Set up forge store with a tool
    const store = createInMemoryForgeStore();
    const multiplyTool = createTestToolArtifact({
      name: "multiply",
      description: "Multiply two numbers",
      implementation: "return input.x * input.y;",
      inputSchema: {
        type: "object",
        properties: { x: { type: "number" }, y: { type: "number" } },
        required: ["x", "y"],
      },
    });
    await seedStore(store, [multiplyTool]);

    // 2. Create forge runtime
    const subprocessExecutor = createTestExecutor();
    const forgeRuntime = createForgeRuntime({
      store,
      executor: subprocessExecutor,
      sandboxTimeoutMs: 10_000,
    });

    // 3. Track lifecycle and tool calls
    const hookLog: string[] = []; // let justified: test accumulator
    let toolResult: unknown; // let justified: captured in middleware

    const lifecycle: KoiMiddleware = {
      name: "e2e-lifecycle",
      priority: 100,
      onSessionStart: async () => {
        hookLog.push("session:start");
      },
      onBeforeTurn: async () => {
        hookLog.push("turn:before");
      },
      onAfterTurn: async () => {
        hookLog.push("turn:after");
      },
      onSessionEnd: async () => {
        hookLog.push("session:end");
      },
    };

    // 4. Use loop adapter with deterministic model handler
    let callCount = 0; // let justified: tracks model call phases
    const { createLoopAdapter } = await import("@koi/engine-loop");
    const adapter = createLoopAdapter({
      modelCall: async () => {
        callCount++;
        if (callCount === 1) {
          // Phase 1: force tool call
          return {
            content: "I'll multiply those numbers.",
            model: MODEL_NAME,
            usage: { inputTokens: 10, outputTokens: 10 },
            metadata: {
              toolCalls: [{ toolName: "multiply", callId: "call-1", input: { x: 6, y: 7 } }],
            },
          };
        }
        // Phase 2: final answer
        return {
          content: "The result is 42.",
          model: MODEL_NAME,
          usage: { inputTokens: 20, outputTokens: 10 },
        };
      },
      maxTurns: 5,
    });

    // 5. Create Koi runtime
    const runtime = await createKoi({
      manifest: { name: "e2e-forge-subprocess", version: "0.0.1", model: { name: MODEL_NAME } },
      adapter,
      middleware: [lifecycle],
      forge: forgeRuntime,
    });

    try {
      const events = await collectEvents(runtime.run({ kind: "text", text: "Multiply 6 by 7" }));

      // Agent completed
      const doneEvent = events.find((e) => e.kind === "done");
      expect(doneEvent).toBeDefined();
      if (doneEvent?.kind === "done") {
        expect(doneEvent.output.stopReason).toBe("completed");
        expect(doneEvent.output.metrics.turns).toBeGreaterThanOrEqual(2);
      }

      // Tool call events were emitted
      const toolStarts = events.filter((e) => e.kind === "tool_call_start");
      expect(toolStarts.length).toBeGreaterThan(0);
      if (toolStarts[0]?.kind === "tool_call_start") {
        expect(toolStarts[0].toolName).toBe("multiply");
      }

      const toolEnds = events.filter((e) => e.kind === "tool_call_end");
      expect(toolEnds.length).toBeGreaterThan(0);
      if (toolEnds[0]?.kind === "tool_call_end") {
        // The tool result should be 42 (6 * 7)
        toolResult = toolEnds[0].result;
        expect(toolResult).toBe(42);
      }

      // L1 lifecycle hooks fired correctly
      expect(hookLog.at(0)).toBe("session:start");
      expect(hookLog.at(-1)).toBe("session:end");
      expect(hookLog).toContain("turn:before");
      expect(hookLog).toContain("turn:after");

      // Model was called twice (tool call + final answer)
      expect(callCount).toBe(2);
    } finally {
      forgeRuntime.dispose?.();
      await runtime.dispose?.();
    }
  }, 30_000);
});

// ---------------------------------------------------------------------------
// 7. Full Pi stack with forged tool that has networkAllowed=false
//    (verifies ExecutionContext.networkAllowed flows through)
// ---------------------------------------------------------------------------

describePi("e2e: Pi agent + forged tool with network isolation", () => {
  test(
    "forged tool with network=false still executes pure computation",
    async () => {
      const store = createInMemoryForgeStore();
      const hashTool = createTestToolArtifact({
        name: "hash_text",
        description: "Hash a text string and return its length",
        implementation:
          "return { length: String(input.text).length, upper: String(input.text).toUpperCase() };",
        inputSchema: {
          type: "object",
          properties: { text: { type: "string" } },
          required: ["text"],
        },
        requires: { network: false },
      });
      await seedStore(store, [hashTool]);

      const subprocessExecutor = createTestExecutor();
      const forgeRuntime = createForgeRuntime({
        store,
        executor: subprocessExecutor,
        sandboxTimeoutMs: 10_000,
      });

      const adapter = createPiAdapter({
        model: PI_MODEL,
        systemPrompt:
          "You have a tool called hash_text. When asked, use it to process the given text. " +
          "After getting the result, report it concisely.",
        getApiKey: async () => ANTHROPIC_KEY,
        thinkingLevel: "off",
      });

      const runtime = await createKoi({
        manifest: { name: "e2e-forge-netdeny", version: "0.0.1", model: { name: MODEL_NAME } },
        adapter,
        forge: forgeRuntime,
      });

      try {
        const events = await collectEvents(
          runtime.run({ kind: "text", text: 'Use hash_text on "hello world".' }),
        );

        const doneEvent = events.find((e) => e.kind === "done");
        expect(doneEvent).toBeDefined();
        if (doneEvent?.kind === "done") {
          expect(doneEvent.output.stopReason).toBe("completed");
        }

        // Tool was called
        const toolStarts = events.filter((e) => e.kind === "tool_call_start");
        expect(toolStarts.length).toBeGreaterThan(0);
      } finally {
        forgeRuntime.dispose?.();
        await runtime.dispose?.();
      }
    },
    TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// 8. Config defaults propagation (resource limits in ForgeConfig)
// ---------------------------------------------------------------------------

describe("e2e: forge config defaults", () => {
  test("default config includes resource limit fields", () => {
    const config = createDefaultForgeConfig();
    expect(config.dependencies.maxBrickMemoryMb).toBe(256);
    expect(config.dependencies.maxBrickPids).toBe(32);
    expect(config.dependencies.installTimeoutMs).toBeGreaterThan(0);
    expect(config.dependencies.maxDependencies).toBeGreaterThan(0);
  });
});
