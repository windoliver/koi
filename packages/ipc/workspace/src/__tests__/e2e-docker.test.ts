/**
 * E2E: Docker workspace backend wired through the full Koi runtime stack.
 *
 * Validates that createDockerWorkspaceBackend works end-to-end with:
 *   - Full L1 runtime assembly (createKoi)
 *   - Real LLM calls via both createPiAdapter and createLoopAdapter
 *   - Middleware chain integration
 *   - Workspace lifecycle (attach -> run -> detach -> cleanup)
 *
 * Uses a mock SandboxAdapter backed by a real temp directory on the host FS
 * so that writeFile/exec operations are inspectable without a Docker daemon.
 *
 * Run:
 *   E2E_TESTS=1 ANTHROPIC_API_KEY=sk-ant-... bun test packages/workspace/src/__tests__/e2e-docker.test.ts
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AgentManifest,
  ComponentProvider,
  EngineEvent,
  EngineOutput,
  KoiMiddleware,
  ModelHandler,
  SandboxAdapter,
  SandboxAdapterResult,
  SandboxInstance,
  SandboxProfile,
  Tool,
  WorkspaceComponent,
} from "@koi/core";
import { DEFAULT_SANDBOXED_POLICY, toolToken, WORKSPACE } from "@koi/core";
import { createKoi } from "@koi/engine";
import { createLoopAdapter } from "@koi/engine-loop";
import { createPiAdapter } from "@koi/engine-pi";
import { createAnthropicAdapter } from "@koi/model-router";
import { createDockerWorkspaceBackend } from "../docker-backend.js";
import { createWorkspaceProvider } from "../provider.js";

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
// E2E mock SandboxAdapter — backed by real host temp directory
// ---------------------------------------------------------------------------

const OK_EXEC_RESULT: SandboxAdapterResult = {
  exitCode: 0,
  stdout: "",
  stderr: "",
  durationMs: 1,
  timedOut: false,
  oomKilled: false,
};

interface E2EMockAdapterTracking {
  readonly createCalls: readonly SandboxProfile[];
  readonly destroyCalls: readonly number[];
}

/**
 * Create a mock SandboxAdapter backed by a real temp directory on host FS.
 *
 * - `writeFile(path, content)` writes to `tempDir + path` on host
 * - `exec("test", ["-d", dir])` checks `tempDir + dir` exists (real FS check)
 * - `destroy()` tracks the call for assertions
 *
 * This gives real filesystem inspection while avoiding Docker.
 */
function createE2EMockAdapter(tempDir: string): SandboxAdapter & E2EMockAdapterTracking {
  // Mutable arrays justified: test-only tracking state.
  const createCalls: SandboxProfile[] = [];
  const destroyCalls: number[] = [];

  return {
    name: "e2e-mock-docker",
    createCalls,
    destroyCalls,

    create: async (profile: SandboxProfile): Promise<SandboxInstance> => {
      createCalls.push(profile);

      return {
        exec: async (command: string, args: readonly string[]): Promise<SandboxAdapterResult> => {
          // Support real FS checks for "test -d <dir>"
          if (command === "test" && args[0] === "-d" && args[1]) {
            const hostPath = join(tempDir, args[1]);
            const dirExists = existsSync(hostPath);
            return { ...OK_EXEC_RESULT, exitCode: dirExists ? 0 : 1 };
          }
          return OK_EXEC_RESULT;
        },

        readFile: async (path: string): Promise<Uint8Array> => {
          const hostPath = join(tempDir, path);
          const file = Bun.file(hostPath);
          return new Uint8Array(await file.arrayBuffer());
        },

        writeFile: async (path: string, content: Uint8Array): Promise<void> => {
          const hostPath = join(tempDir, path);
          // Ensure parent directory exists
          const parentDir = hostPath.substring(0, hostPath.lastIndexOf("/"));
          if (!existsSync(parentDir)) {
            await Bun.write(hostPath, content);
          } else {
            await Bun.write(hostPath, content);
          }
        },

        destroy: async (): Promise<void> => {
          destroyCalls.push(Date.now());
        },
      };
    },
  };
}

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

function requireWs(ws: WorkspaceComponent | undefined): WorkspaceComponent {
  if (ws === undefined) throw new Error("workspace component missing");
  return ws;
}

function testManifest(name: string = "e2e-docker-agent"): AgentManifest {
  return {
    name,
    version: "1.0.0",
    description: "E2E test agent with Docker workspace isolation",
    model: { name: "claude-haiku-4-5-20251001" },
  };
}

function createModelHandler(): ModelHandler {
  const adapter = createAnthropicAdapter({ apiKey: ANTHROPIC_KEY });
  return (request) => adapter.complete(request);
}

const ECHO_TOOL: Tool = {
  descriptor: {
    name: "echo",
    description: "Returns the input text as-is. Use to confirm you can call tools.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Text to echo back" },
      },
      required: ["text"],
    },
  },
  origin: "primordial",
  policy: DEFAULT_SANDBOXED_POLICY,
  execute: async (input: Readonly<Record<string, unknown>>) => {
    return String(input.text ?? "");
  },
};

function createToolProvider(tools: readonly Tool[]): ComponentProvider {
  return {
    name: "e2e-tool-provider",
    attach: async () => new Map(tools.map((t) => [toolToken(t.descriptor.name) as string, t])),
  };
}

// ---------------------------------------------------------------------------
// createPiAdapter path (4 tests)
// ---------------------------------------------------------------------------

describeE2E("e2e: Docker workspace backend + createPiAdapter", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "koi-docker-e2e-pi-"));
    // Pre-create the /workspace directory so marker file writes succeed
    await Bun.write(join(tempDir, "workspace", ".gitkeep"), "");
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  // ── Test 1: Assembly + real LLM call ─────────────────────────────────

  test(
    "Docker workspace attaches via createKoi, real LLM call succeeds",
    async () => {
      const mockAdapter = createE2EMockAdapter(tempDir);
      const backendResult = createDockerWorkspaceBackend({ adapter: mockAdapter });
      if (!backendResult.ok) throw new Error(backendResult.error.message);

      const providerResult = createWorkspaceProvider({
        backend: backendResult.value,
        cleanupPolicy: "always",
      });
      if (!providerResult.ok) throw new Error(providerResult.error.message);

      const adapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt: "Reply with exactly: pong",
        getApiKey: async () => ANTHROPIC_KEY,
      });

      const runtime = await createKoi({
        manifest: testManifest("docker-pi-assembly"),
        adapter,
        providers: [providerResult.value],
        loopDetection: false,
      });

      // Workspace component should be on the agent entity
      const ws = requireWs(runtime.agent.component<WorkspaceComponent>(WORKSPACE));
      expect(ws.path).toBe("/workspace");
      expect(ws.metadata.adapterName).toBe("e2e-mock-docker");
      expect(ws.metadata.workDir).toBe("/workspace");

      // Marker file should exist on host FS
      expect(existsSync(join(tempDir, "workspace", ".koi-workspace"))).toBe(true);

      // Run a real LLM call
      const events = await collectEvents(
        runtime.run({ kind: "text", text: "Reply with exactly: pong" }),
      );

      const output = findDoneOutput(events);
      expect(output).toBeDefined();
      expect(output?.stopReason).toBe("completed");
      expect(runtime.agent.state).toBe("terminated");
      expect(runtime.agent.terminationOutcome).toBe("success");

      const text = extractText(events);
      expect(text.toLowerCase()).toContain("pong");

      // Adapter should have been called once to create container
      expect(mockAdapter.createCalls.length).toBe(1);

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );

  // ── Test 2: Cleanup "always" ─────────────────────────────────────────

  test(
    "cleanup 'always' disposes container after successful agent run",
    async () => {
      const mockAdapter = createE2EMockAdapter(tempDir);
      const backendResult = createDockerWorkspaceBackend({ adapter: mockAdapter });
      if (!backendResult.ok) throw new Error(backendResult.error.message);

      const providerResult = createWorkspaceProvider({
        backend: backendResult.value,
        cleanupPolicy: "always",
      });
      if (!providerResult.ok) throw new Error(providerResult.error.message);

      const adapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt: "Reply briefly.",
        getApiKey: async () => ANTHROPIC_KEY,
      });

      const runtime = await createKoi({
        manifest: testManifest("docker-pi-cleanup"),
        adapter,
        providers: [providerResult.value],
        loopDetection: false,
      });

      expect(mockAdapter.destroyCalls.length).toBe(0);

      await collectEvents(runtime.run({ kind: "text", text: "Say: OK" }));

      expect(runtime.agent.state).toBe("terminated");
      expect(runtime.agent.terminationOutcome).toBe("success");

      // Detach with "always" — container should be destroyed
      if (providerResult.value.detach) {
        await providerResult.value.detach(runtime.agent);
      }
      expect(mockAdapter.destroyCalls.length).toBe(1);

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );

  // ── Test 3: on_success + interrupted ─────────────────────────────────

  test(
    "on_success preserves workspace on interrupted + pruneStale fires",
    async () => {
      const mockAdapter = createE2EMockAdapter(tempDir);
      const backendResult = createDockerWorkspaceBackend({ adapter: mockAdapter });
      if (!backendResult.ok) throw new Error(backendResult.error.message);

      const pruneStale = mock(async (): Promise<void> => {});

      const providerResult = createWorkspaceProvider({
        backend: backendResult.value,
        cleanupPolicy: "on_success",
        pruneStale,
      });
      if (!providerResult.ok) throw new Error(providerResult.error.message);

      const adapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt:
          "You MUST use the echo tool to respond. Always call echo with the user's message.",
        getApiKey: async () => ANTHROPIC_KEY,
      });

      const runtime = await createKoi({
        manifest: testManifest("docker-pi-interrupted"),
        adapter,
        providers: [providerResult.value, createToolProvider([ECHO_TOOL])],
        loopDetection: false,
      });

      // Start the run but abort it mid-stream to trigger "interrupted"
      const controller = new AbortController();

      const events: EngineEvent[] = [];
      for await (const event of runtime.run({
        kind: "text",
        text: "Use the echo tool with 'hello'. Then explain the result in detail.",
        signal: controller.signal,
      })) {
        events.push(event);
        // Abort after we see the first text delta
        if (event.kind === "text_delta") {
          controller.abort();
          break;
        }
      }

      expect(runtime.agent.state).toBe("terminated");
      expect(runtime.agent.terminationOutcome).toBe("interrupted");

      // Detach — on_success + interrupted -> workspace preserved + pruneStale fires
      if (providerResult.value.detach) {
        await providerResult.value.detach(runtime.agent);
      }
      // Container should NOT be destroyed (preserved)
      expect(mockAdapter.destroyCalls.length).toBe(0);
      expect(pruneStale).toHaveBeenCalledTimes(1);

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );

  // ── Test 4: Middleware + tool + workspace ─────────────────────────────

  test(
    "tool observer middleware intercepts echo tool call with Docker workspace attached",
    async () => {
      const mockAdapter = createE2EMockAdapter(tempDir);
      const backendResult = createDockerWorkspaceBackend({ adapter: mockAdapter });
      if (!backendResult.ok) throw new Error(backendResult.error.message);

      const providerResult = createWorkspaceProvider({
        backend: backendResult.value,
        cleanupPolicy: "always",
      });
      if (!providerResult.ok) throw new Error(providerResult.error.message);

      // let justified: tracking middleware interception count
      let toolCallCount = 0;
      const toolObserver: KoiMiddleware = {
        name: "tool-observer",
        describeCapabilities: () => undefined,
        wrapToolCall: async (_ctx, request, next) => {
          toolCallCount += 1;
          return next(request);
        },
      };

      const adapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt:
          "You MUST use the echo tool for every request. Call echo with the user's text.",
        getApiKey: async () => ANTHROPIC_KEY,
      });

      const runtime = await createKoi({
        manifest: testManifest("docker-pi-middleware"),
        adapter,
        middleware: [toolObserver],
        providers: [providerResult.value, createToolProvider([ECHO_TOOL])],
        loopDetection: false,
      });

      // Both workspace and tool should be on the agent
      const ws = requireWs(runtime.agent.component<WorkspaceComponent>(WORKSPACE));
      expect(ws.path).toBe("/workspace");
      expect(ws.metadata.adapterName).toBe("e2e-mock-docker");

      const events = await collectEvents(
        runtime.run({ kind: "text", text: "Use echo with 'docker workspace test'" }),
      );

      const output = findDoneOutput(events);
      expect(output).toBeDefined();
      expect(output?.stopReason).toBe("completed");

      // Middleware should have intercepted at least one tool call
      expect(toolCallCount).toBeGreaterThanOrEqual(1);

      // tool_call_start events should exist
      const toolStarts = events.filter((e) => e.kind === "tool_call_start");
      expect(toolStarts.length).toBeGreaterThanOrEqual(1);

      if (providerResult.value.detach) {
        await providerResult.value.detach(runtime.agent);
      }

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// createLoopAdapter path (4 tests)
// ---------------------------------------------------------------------------

describeE2E("e2e: Docker workspace backend + createLoopAdapter", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "koi-docker-e2e-loop-"));
    // Pre-create the /workspace directory so marker file writes succeed
    await Bun.write(join(tempDir, "workspace", ".gitkeep"), "");
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  // ── Test 5: Assembly + real LLM call ─────────────────────────────────

  test("Docker workspace attaches via createLoopAdapter, real LLM call succeeds", async () => {
    const mockAdapter = createE2EMockAdapter(tempDir);
    const backendResult = createDockerWorkspaceBackend({ adapter: mockAdapter });
    if (!backendResult.ok) throw new Error(backendResult.error.message);

    const providerResult = createWorkspaceProvider({
      backend: backendResult.value,
      cleanupPolicy: "always",
    });
    if (!providerResult.ok) throw new Error(providerResult.error.message);

    const adapter = createLoopAdapter({
      modelCall: createModelHandler(),
      maxTurns: 1,
    });

    const runtime = await createKoi({
      manifest: testManifest("docker-loop-assembly"),
      adapter,
      providers: [providerResult.value],
      loopDetection: false,
      limits: { maxTurns: 1, maxDurationMs: 30_000, maxTokens: 5_000 },
    });

    // Workspace component should be on the agent entity
    const ws = requireWs(runtime.agent.component<WorkspaceComponent>(WORKSPACE));
    expect(ws.path).toBe("/workspace");
    expect(ws.metadata.adapterName).toBe("e2e-mock-docker");
    expect(ws.metadata.workDir).toBe("/workspace");

    // Run a real LLM call
    const events = await collectEvents(
      runtime.run({ kind: "text", text: "Reply with exactly: DOCKER_OK" }),
    );

    const output = findDoneOutput(events);
    expect(output).toBeDefined();
    expect(output?.stopReason).toBe("completed");
    expect(output?.metrics.totalTokens).toBeGreaterThan(0);

    await runtime.dispose();
  }, 60_000);

  // ── Test 6: postCreate hook fires ────────────────────────────────────

  test("postCreate hook runs during assembly, can write files in workspace", async () => {
    const mockAdapter = createE2EMockAdapter(tempDir);
    const backendResult = createDockerWorkspaceBackend({ adapter: mockAdapter });
    if (!backendResult.ok) throw new Error(backendResult.error.message);

    let hookCalled = false;
    let hookWorkspacePath: string | undefined;

    const providerResult = createWorkspaceProvider({
      backend: backendResult.value,
      cleanupPolicy: "always",
      postCreate: async (ws) => {
        hookCalled = true;
        hookWorkspacePath = ws.path;
        // The workspace path is "/workspace" (container-internal),
        // but we can verify the hook received correct workspace info
        expect(ws.metadata.adapterName).toBe("e2e-mock-docker");
        expect(ws.id).toMatch(/^docker-/);
      },
    });
    if (!providerResult.ok) throw new Error(providerResult.error.message);

    const adapter = createLoopAdapter({
      modelCall: createModelHandler(),
      maxTurns: 1,
    });

    const runtime = await createKoi({
      manifest: testManifest("docker-loop-postcreate"),
      adapter,
      providers: [providerResult.value],
      loopDetection: false,
      limits: { maxTurns: 1, maxDurationMs: 30_000, maxTokens: 5_000 },
    });

    expect(hookCalled).toBe(true);
    expect(hookWorkspacePath).toBe("/workspace");

    const events = await collectEvents(runtime.run({ kind: "text", text: "Say yes." }));
    expect(findDoneOutput(events)?.stopReason).toBe("completed");

    await runtime.dispose();
  }, 60_000);

  // ── Test 7: Two agents isolated ──────────────────────────────────────

  test("two agents get independent Docker containers (parallel swarm)", async () => {
    // Each agent gets its own mock adapter with its own temp dir
    const tempDir2 = await mkdtemp(join(tmpdir(), "koi-docker-e2e-loop2-"));
    await Bun.write(join(tempDir2, "workspace", ".gitkeep"), "");

    try {
      const mockAdapter1 = createE2EMockAdapter(tempDir);
      const mockAdapter2 = createE2EMockAdapter(tempDir2);

      const backend1Result = createDockerWorkspaceBackend({ adapter: mockAdapter1 });
      const backend2Result = createDockerWorkspaceBackend({ adapter: mockAdapter2 });
      if (!backend1Result.ok) throw new Error(backend1Result.error.message);
      if (!backend2Result.ok) throw new Error(backend2Result.error.message);

      const provider1Result = createWorkspaceProvider({
        backend: backend1Result.value,
        cleanupPolicy: "never",
      });
      const provider2Result = createWorkspaceProvider({
        backend: backend2Result.value,
        cleanupPolicy: "never",
      });
      if (!provider1Result.ok) throw new Error("Provider 1 failed");
      if (!provider2Result.ok) throw new Error("Provider 2 failed");

      const adapter1 = createLoopAdapter({
        modelCall: createModelHandler(),
        maxTurns: 1,
      });
      const adapter2 = createLoopAdapter({
        modelCall: createModelHandler(),
        maxTurns: 1,
      });

      const runtime1 = await createKoi({
        manifest: testManifest("docker-swarm-1"),
        adapter: adapter1,
        providers: [provider1Result.value],
        loopDetection: false,
        limits: { maxTurns: 1, maxDurationMs: 30_000, maxTokens: 5_000 },
      });

      const runtime2 = await createKoi({
        manifest: testManifest("docker-swarm-2"),
        adapter: adapter2,
        providers: [provider2Result.value],
        loopDetection: false,
        limits: { maxTurns: 1, maxDurationMs: 30_000, maxTokens: 5_000 },
      });

      // Both should have workspace components
      const ws1 = requireWs(runtime1.agent.component<WorkspaceComponent>(WORKSPACE));
      const ws2 = requireWs(runtime2.agent.component<WorkspaceComponent>(WORKSPACE));

      // Path is the same ("/workspace") but the underlying instances are separate
      expect(ws1.path).toBe("/workspace");
      expect(ws2.path).toBe("/workspace");
      // IDs must differ (includes agentId + timestamp)
      expect(ws1.id).not.toBe(ws2.id);

      // Marker files on different host temp dirs confirm isolation
      expect(existsSync(join(tempDir, "workspace", ".koi-workspace"))).toBe(true);
      expect(existsSync(join(tempDir2, "workspace", ".koi-workspace"))).toBe(true);

      // Each adapter created exactly one container
      expect(mockAdapter1.createCalls.length).toBe(1);
      expect(mockAdapter2.createCalls.length).toBe(1);

      // Run both agents in parallel
      const [events1, events2] = await Promise.all([
        collectEvents(runtime1.run({ kind: "text", text: "Say 'agent 1'." })),
        collectEvents(runtime2.run({ kind: "text", text: "Say 'agent 2'." })),
      ]);

      expect(findDoneOutput(events1)?.stopReason).toBe("completed");
      expect(findDoneOutput(events2)?.stopReason).toBe("completed");

      await Promise.all([runtime1.dispose(), runtime2.dispose()]);
    } finally {
      await rm(tempDir2, { recursive: true, force: true });
    }
  }, 90_000);

  // ── Test 8: isHealthy during lifecycle ───────────────────────────────

  test("isHealthy returns true during run, false after dispose", async () => {
    const mockAdapter = createE2EMockAdapter(tempDir);
    const backendResult = createDockerWorkspaceBackend({ adapter: mockAdapter });
    if (!backendResult.ok) throw new Error(backendResult.error.message);

    const backend = backendResult.value;

    const providerResult = createWorkspaceProvider({
      backend,
      cleanupPolicy: "always",
    });
    if (!providerResult.ok) throw new Error(providerResult.error.message);

    const adapter = createLoopAdapter({
      modelCall: createModelHandler(),
      maxTurns: 1,
    });

    const runtime = await createKoi({
      manifest: testManifest("docker-loop-healthy"),
      adapter,
      providers: [providerResult.value],
      loopDetection: false,
      limits: { maxTurns: 1, maxDurationMs: 30_000, maxTokens: 5_000 },
    });

    const ws = requireWs(runtime.agent.component<WorkspaceComponent>(WORKSPACE));

    // isHealthy should return true while workspace is alive
    // The mock adapter checks if tempDir + "/workspace" exists
    const healthyDuringRun = await backend.isHealthy(ws.id);
    expect(healthyDuringRun).toBe(true);

    // Run a real LLM call
    const events = await collectEvents(runtime.run({ kind: "text", text: "Reply: healthy" }));
    expect(findDoneOutput(events)?.stopReason).toBe("completed");

    // Detach triggers dispose for "always" policy
    if (providerResult.value.detach) {
      await providerResult.value.detach(runtime.agent);
    }

    // After dispose, isHealthy should return false (workspace removed from tracking)
    const healthyAfterDispose = await backend.isHealthy(ws.id);
    expect(healthyAfterDispose).toBe(false);

    await runtime.dispose();
  }, 60_000);
});
