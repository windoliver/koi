/**
 * E2E: dynamic tool + middleware via ForgeRuntime with real file hot-loading.
 *
 * Validates that:
 * 1. A forged tool .ts file is written to disk and import()-ed at call time
 * 2. Forged tool descriptors appear in callHandlers.tools after turn boundary
 * 3. A forged middleware .ts file is written to disk, import()-ed at turn boundary,
 *    and intercepts subsequent calls
 *
 * Run: bun scripts/e2e-dynamic-forge.ts
 * No API key needed — uses scripted model responses.
 * Bun runs .ts natively — no build step needed for dynamic loading.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  EngineEvent,
  JsonObject,
  KoiMiddleware,
  ModelRequest,
  ModelResponse,
  Tool,
  ToolDescriptor,
} from "../packages/core/src/index.js";
import { toolToken } from "../packages/core/src/index.js";
import { createKoi } from "../packages/engine/src/koi.js";
import type { ForgeRuntime } from "../packages/engine/src/types.js";
import { createLoopAdapter } from "../packages/engine-loop/src/loop-adapter.js";

// ---------------------------------------------------------------------------
// Scripted model — returns pre-programmed responses per turn
// ---------------------------------------------------------------------------

function createScriptedModel(
  script: readonly ((messages: readonly unknown[]) => ModelResponse)[],
): (request: ModelRequest) => Promise<ModelResponse> {
  // let justified: mutable turn counter
  let turn = 0;
  return async (request: ModelRequest): Promise<ModelResponse> => {
    const handler = script[turn];
    if (handler === undefined) {
      return { content: "Script exhausted", model: "scripted" };
    }
    turn++;
    return handler(request.messages);
  };
}

// ---------------------------------------------------------------------------
// ForgeRuntime backed by dynamic import() of .ts files from disk
// ---------------------------------------------------------------------------

function createDynamicForgeRuntime(workDir: string): {
  readonly runtime: ForgeRuntime;
  readonly registerTool: (name: string, descriptor: ToolDescriptor) => void;
  readonly registerMiddlewareModule: (modulePath: string) => void;
} {
  // Map of tool name → { descriptor, modulePath } for lazy import() on first call
  const toolRegistry = new Map<
    string,
    { readonly descriptor: ToolDescriptor; readonly modulePath: string }
  >();

  // List of middleware module paths to import() at turn boundaries
  const middlewareModules: string[] = [];

  // let justified: mutable cache of resolved tools, populated on first call
  const resolvedTools = new Map<string, Tool>();

  // let justified: mutable cache of imported middleware, refreshed when modules change
  let cachedMiddleware: readonly KoiMiddleware[] = [];
  let lastMiddlewareCount = 0;

  const runtime: ForgeRuntime = {
    resolveTool: async (toolId: string): Promise<Tool | undefined> => {
      // Check cache first
      const cached = resolvedTools.get(toolId);
      if (cached !== undefined) return cached;

      // Check registry for unresolved tool
      const entry = toolRegistry.get(toolId);
      if (entry === undefined) return undefined;

      // Dynamic import() — Bun runs .ts natively
      const mod = (await import(entry.modulePath)) as {
        readonly execute: (input: unknown) => Promise<unknown>;
      };
      const tool: Tool = {
        descriptor: entry.descriptor,
        trustTier: "sandbox",
        execute: mod.execute,
      };
      resolvedTools.set(toolId, tool);
      return tool;
    },

    toolDescriptors: async (): Promise<readonly ToolDescriptor[]> => {
      return [...toolRegistry.values()].map((e) => e.descriptor);
    },

    middleware: async (): Promise<readonly KoiMiddleware[]> => {
      // Only re-import when new modules were added
      if (middlewareModules.length === lastMiddlewareCount) {
        return cachedMiddleware;
      }
      lastMiddlewareCount = middlewareModules.length;

      // Dynamic import() all middleware modules
      const imported: KoiMiddleware[] = [];
      for (const modulePath of middlewareModules) {
        const mod = (await import(modulePath)) as { readonly middleware: KoiMiddleware };
        imported.push(mod.middleware);
      }
      cachedMiddleware = imported;
      return cachedMiddleware;
    },
  };

  return {
    runtime,
    registerTool: (name: string, descriptor: ToolDescriptor): void => {
      toolRegistry.set(name, { descriptor, modulePath: join(workDir, `${name}.ts`) });
    },
    registerMiddlewareModule: (modulePath: string): void => {
      middlewareModules.push(modulePath);
    },
  };
}

// ---------------------------------------------------------------------------
// Test runner
// ---------------------------------------------------------------------------

const log = (tag: string, msg: string): void => console.log(`  [${tag}] ${msg}`);
const pass = (msg: string): void => console.log(`  ✓ ${msg}`);
const fail = (msg: string): void => {
  console.error(`  ✗ ${msg}`);
  process.exit(1);
};

async function main(): Promise<void> {
  console.log("\n═══ E2E: Dynamic Forge — Hot-Load .ts from Disk ═══\n");

  // --- 0. Create temp directory for forged .ts files ---
  const workDir = await mkdtemp(join(tmpdir(), "koi-forge-e2e-"));
  log("setup", `Temp dir: ${workDir}`);

  try {
    await runTest(workDir);
  } finally {
    await rm(workDir, { recursive: true });
    log("cleanup", "Temp dir removed");
  }
}

async function runTest(workDir: string): Promise<void> {
  // --- 1. Setup: dynamic forge runtime ---
  const {
    runtime: forge,
    registerTool,
    registerMiddlewareModule,
  } = createDynamicForgeRuntime(workDir);

  // Shared log file path — middleware writes to this, we read to verify
  const auditLogPath = join(workDir, "audit-log.json");
  await writeFile(auditLogPath, "[]", "utf-8");

  // --- 2. Setup: scripted model ---
  // Turn 0: call entity tool "greet"
  // Turn 1: call forged tool "multiply" (file written + registered between turns)
  // Turn 2: call entity tool "greet" again (hot-loaded middleware should intercept)
  // Turn 3: final text response (loop ends)
  const modelScript = createScriptedModel([
    () => ({
      content: "Let me greet you.",
      model: "scripted",
      metadata: {
        toolCalls: [{ toolName: "greet", callId: "call-0", input: { name: "World" } }],
      } as JsonObject,
    }),
    () => ({
      content: "Now let me multiply.",
      model: "scripted",
      metadata: {
        toolCalls: [{ toolName: "multiply", callId: "call-1", input: { a: 6, b: 7 } }],
      } as JsonObject,
    }),
    () => ({
      content: "Let me greet once more.",
      model: "scripted",
      metadata: {
        toolCalls: [{ toolName: "greet", callId: "call-2", input: { name: "Forge" } }],
      } as JsonObject,
    }),
    () => ({
      content: "All done!",
      model: "scripted",
    }),
  ]);

  // --- 3. Setup: loop adapter ---
  const loopAdapter = createLoopAdapter({ modelCall: modelScript, maxTurns: 10 });

  // --- 4. Setup: entity tool (pre-assembled via provider) ---
  const greetExecutions: string[] = [];
  const greetTool: Tool = {
    descriptor: { name: "greet", description: "Greet someone", inputSchema: {} },
    trustTier: "verified",
    execute: async (input: unknown): Promise<unknown> => {
      const name = (input as Record<string, unknown>).name ?? "unknown";
      greetExecutions.push(String(name));
      return `Hello, ${name}!`;
    },
  };

  // --- 5. Create runtime with forge ---
  const runtime = await createKoi({
    manifest: { name: "Forge E2E Agent", version: "0.1.0", model: { name: "scripted" } },
    adapter: loopAdapter,
    forge,
    loopDetection: false,
    providers: [
      {
        name: "entity-tools",
        attach: async () => new Map([[toolToken("greet") as string, greetTool]]),
      },
    ],
  });

  log("setup", `Agent assembled (state: ${runtime.agent.state})`);

  // --- 6. Run the agent, writing .ts files + registering between turns ---
  const events: EngineEvent[] = [];
  const toolCallResults: Array<{ readonly callId: string; readonly result: unknown }> = [];

  for await (const event of runtime.run({ kind: "text", text: "Start E2E test" })) {
    events.push(event);

    if (event.kind === "tool_call_start") {
      log("tool_call", `${event.toolName} (${event.callId})`);
    } else if (event.kind === "tool_call_end") {
      log("tool_result", `${event.callId} → ${JSON.stringify(event.result)}`);
      toolCallResults.push({ callId: event.callId, result: event.result });
    } else if (event.kind === "turn_end") {
      log("turn_end", `turn ${event.turnIndex}`);

      // After turn 0: write multiply.ts to disk and register it
      if (event.turnIndex === 0) {
        const multiplyPath = join(workDir, "multiply.ts");
        await writeFile(
          multiplyPath,
          `// Forged tool: multiply — written to disk at runtime
export async function execute(input: unknown): Promise<unknown> {
  const { a, b } = input as { readonly a: number; readonly b: number };
  return { product: a * b };
}
`,
          "utf-8",
        );
        registerTool("multiply", {
          name: "multiply",
          description: "Multiply two numbers",
          inputSchema: {
            type: "object",
            properties: { a: { type: "number" }, b: { type: "number" } },
          },
        });
        log("forge", `Wrote ${multiplyPath} and registered tool 'multiply'`);
      }

      // After turn 1: write audit-middleware.ts to disk and register it
      if (event.turnIndex === 1) {
        const mwPath = join(workDir, "audit-middleware.ts");
        await writeFile(
          mwPath,
          `// Forged middleware: audit — written to disk at runtime
import { readFileSync, writeFileSync } from "node:fs";

const LOG_PATH = ${JSON.stringify(auditLogPath)};

export const middleware = {
  name: "hot-loaded-audit",
  wrapToolCall: async (
    _ctx: unknown,
    req: { readonly toolId: string },
    next: (req: unknown) => Promise<unknown>,
  ): Promise<unknown> => {
    const log: string[] = JSON.parse(readFileSync(LOG_PATH, "utf-8"));
    log.push("audit:" + req.toolId);
    writeFileSync(LOG_PATH, JSON.stringify(log), "utf-8");
    return next(req);
  },
};
`,
          "utf-8",
        );
        registerMiddlewareModule(mwPath);
        log("forge", `Wrote ${mwPath} and registered middleware module`);
      }
    } else if (event.kind === "done") {
      log("done", `stopReason=${event.output.stopReason} turns=${event.output.metrics.turns}`);
    }
  }

  // --- 7. Verify ---
  console.log("\n--- Verification ---\n");

  // Check 1: Entity tool "greet" was called in turn 0
  if (greetExecutions.length < 1 || greetExecutions[0] !== "World") {
    fail(
      `Entity tool 'greet' not called with 'World' in turn 0 (got: ${JSON.stringify(greetExecutions)})`,
    );
  }
  pass("Entity tool 'greet' executed in turn 0 with name='World'");

  // Check 2: Forged tool "multiply" was hot-loaded from .ts and executed
  const multiplyResult = toolCallResults.find((r) => r.callId === "call-1");
  if (multiplyResult === undefined) {
    fail("Forged tool 'multiply' was not called in turn 1");
  }
  const product = (multiplyResult.result as Record<string, unknown>)?.product;
  if (product !== 42) {
    fail(
      `Forged tool 'multiply' returned wrong result: ${JSON.stringify(multiplyResult.result)} (expected product=42)`,
    );
  }
  pass("Forged tool 'multiply' hot-loaded from .ts file and returned product=42");

  // Check 3: Entity tool "greet" was called again in turn 2
  if (greetExecutions.length < 2 || greetExecutions[1] !== "Forge") {
    fail(
      `Entity tool 'greet' not called with 'Forge' in turn 2 (got: ${JSON.stringify(greetExecutions)})`,
    );
  }
  pass("Entity tool 'greet' executed in turn 2 with name='Forge'");

  // Check 4: Hot-loaded middleware intercepted the turn 2 tool call
  const { readFileSync } = await import("node:fs");
  const auditLog: string[] = JSON.parse(readFileSync(auditLogPath, "utf-8")) as string[];
  if (auditLog.length === 0) {
    fail("Hot-loaded middleware did not intercept any tool calls");
  }
  if (!auditLog.includes("audit:greet")) {
    fail(`Hot-loaded middleware did not intercept 'greet' (log: ${JSON.stringify(auditLog)})`);
  }
  pass(`Hot-loaded middleware intercepted tool call (log: ${JSON.stringify(auditLog)})`);

  // Check 5: Middleware was NOT active before turn 1 boundary
  const multiplyAudit = auditLog.filter((l) => l === "audit:multiply");
  if (multiplyAudit.length > 0) {
    fail("Hot-loaded middleware incorrectly intercepted 'multiply' before its turn boundary");
  }
  pass("Middleware correctly NOT active before its turn boundary");

  // Check 6: Agent completed successfully
  const doneEvent = events.find((e) => e.kind === "done");
  if (doneEvent?.kind !== "done" || doneEvent.output.stopReason !== "completed") {
    fail(
      `Agent did not complete (stopReason: ${doneEvent?.kind === "done" ? doneEvent.output.stopReason : "missing"})`,
    );
  }
  pass(`Agent completed (state: ${runtime.agent.state})`);

  console.log("\n═══ ALL CHECKS PASSED ═══\n");
  await runtime.dispose();
}

main().catch((error: unknown) => {
  console.error("\nE2E FAILED:", error);
  process.exit(1);
});
