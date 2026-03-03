/**
 * E2E: Docker workspace backend — MountMode, ContainerScope, requireSandbox.
 *
 * Validates the three new features end-to-end through the full Koi runtime
 * assembly (createKoi) with real LLM calls via createPiAdapter and
 * createLoopAdapter. Uses mock SandboxAdapter backed by real temp directories.
 *
 * Run:
 *   E2E_TESTS=1 bun test packages/workspace/src/__tests__/e2e-docker-features.test.ts
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type {
  AgentManifest,
  EngineEvent,
  EngineOutput,
  SandboxAdapter,
  SandboxAdapterResult,
  SandboxInstance,
  SandboxProfile,
  WorkspaceBackend,
  WorkspaceComponent,
} from "@koi/core";
import { agentId, WORKSPACE, workspaceId } from "@koi/core";
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

const OK_EXEC: SandboxAdapterResult = {
  exitCode: 0,
  stdout: "",
  stderr: "",
  durationMs: 1,
  timedOut: false,
  oomKilled: false,
};

interface AdapterTracking {
  readonly createCalls: readonly SandboxProfile[];
  readonly destroyCalls: readonly number[];
}

function createE2EMockAdapter(tempDir: string): SandboxAdapter & AdapterTracking {
  // Mutable arrays justified: test-only tracking state.
  const createCalls: SandboxProfile[] = [];
  const destroyCalls: number[] = [];

  return {
    name: "e2e-feature-mock",
    createCalls,
    destroyCalls,

    create: async (profile: SandboxProfile): Promise<SandboxInstance> => {
      createCalls.push(profile);

      return {
        exec: async (command: string, args: readonly string[]): Promise<SandboxAdapterResult> => {
          if (command === "test" && args[0] === "-d" && args[1]) {
            const hostPath = join(tempDir, args[1]);
            return { ...OK_EXEC, exitCode: existsSync(hostPath) ? 0 : 1 };
          }
          return OK_EXEC;
        },

        readFile: async (path: string): Promise<Uint8Array> => {
          const hostPath = join(tempDir, path);
          return new Uint8Array(await Bun.file(hostPath).arrayBuffer());
        },

        writeFile: async (path: string, content: Uint8Array): Promise<void> => {
          const hostPath = join(tempDir, path);
          const parentDir = dirname(hostPath);
          if (!existsSync(parentDir)) {
            await mkdir(parentDir, { recursive: true });
          }
          await Bun.write(hostPath, content);
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

function testManifest(name: string): AgentManifest {
  return {
    name,
    version: "1.0.0",
    description: `E2E feature test: ${name}`,
    model: { name: "claude-haiku-4-5-20251001" },
  };
}

function createModelHandler(): (
  request: Parameters<import("@koi/core").ModelHandler>[0],
) => ReturnType<import("@koi/core").ModelHandler> {
  const adapter = createAnthropicAdapter({ apiKey: ANTHROPIC_KEY });
  return (request) => adapter.complete(request);
}

// ===========================================================================
// Feature 1: MountMode — via createPiAdapter (real LLM)
// ===========================================================================

describeE2E("e2e: MountMode through full Koi runtime", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "koi-e2e-mountmode-"));
    await mkdir(join(tempDir, "workspace"), { recursive: true });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test(
    'mountMode "ro" passes read-only profile to adapter, real LLM call succeeds',
    async () => {
      const mockAdapter = createE2EMockAdapter(tempDir);
      const backendResult = createDockerWorkspaceBackend({
        adapter: mockAdapter,
        mountMode: "ro",
      });
      if (!backendResult.ok) throw new Error(backendResult.error.message);

      const providerResult = createWorkspaceProvider({
        backend: backendResult.value,
        cleanupPolicy: "always",
      });
      if (!providerResult.ok) throw new Error(providerResult.error.message);

      const piAdapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt: "Reply with exactly: mount_ro_ok",
        getApiKey: async () => ANTHROPIC_KEY,
      });

      const runtime = await createKoi({
        manifest: testManifest("mountmode-ro"),
        adapter: piAdapter,
        providers: [providerResult.value],
        loopDetection: false,
      });

      // Verify profile passed to adapter has ro settings
      expect(mockAdapter.createCalls.length).toBe(1);
      const profile = mockAdapter.createCalls[0];
      if (!profile) throw new Error("expected adapter.create call");
      expect(profile.filesystem.allowRead).toEqual(["/workspace"]);
      expect(profile.filesystem.allowWrite).toEqual([]);

      // Workspace should be attached
      const ws = requireWs(runtime.agent.component<WorkspaceComponent>(WORKSPACE));
      expect(ws.path).toBe("/workspace");

      // Real LLM call
      const events = await collectEvents(
        runtime.run({ kind: "text", text: "Reply with exactly: mount_ro_ok" }),
      );
      const output = findDoneOutput(events);
      expect(output).toBeDefined();
      expect(output?.stopReason).toBe("completed");

      const text = extractText(events);
      expect(text.toLowerCase()).toContain("mount_ro_ok");

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );

  test(
    'mountMode "none" passes empty filesystem policy, real LLM call succeeds',
    async () => {
      const mockAdapter = createE2EMockAdapter(tempDir);
      const backendResult = createDockerWorkspaceBackend({
        adapter: mockAdapter,
        mountMode: "none",
      });
      if (!backendResult.ok) throw new Error(backendResult.error.message);

      const providerResult = createWorkspaceProvider({
        backend: backendResult.value,
        cleanupPolicy: "always",
      });
      if (!providerResult.ok) throw new Error(providerResult.error.message);

      const piAdapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt: "Reply with exactly: mount_none_ok",
        getApiKey: async () => ANTHROPIC_KEY,
      });

      const runtime = await createKoi({
        manifest: testManifest("mountmode-none"),
        adapter: piAdapter,
        providers: [providerResult.value],
        loopDetection: false,
      });

      // Verify profile passed to adapter has none settings
      const profile = mockAdapter.createCalls[0];
      if (!profile) throw new Error("expected adapter.create call");
      expect(profile.filesystem.allowRead).toEqual([]);
      expect(profile.filesystem.allowWrite).toEqual([]);

      const events = await collectEvents(
        runtime.run({ kind: "text", text: "Reply with exactly: mount_none_ok" }),
      );
      expect(findDoneOutput(events)?.stopReason).toBe("completed");
      expect(extractText(events).toLowerCase()).toContain("mount_none_ok");

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );

  test("profileOverrides.filesystem takes precedence over mountMode in full stack", async () => {
    const mockAdapter = createE2EMockAdapter(tempDir);
    const backendResult = createDockerWorkspaceBackend({
      adapter: mockAdapter,
      mountMode: "none",
      profileOverrides: {
        filesystem: { allowRead: ["/override"], allowWrite: ["/override"] },
      },
    });
    if (!backendResult.ok) throw new Error(backendResult.error.message);

    const providerResult = createWorkspaceProvider({
      backend: backendResult.value,
      cleanupPolicy: "always",
    });
    if (!providerResult.ok) throw new Error(providerResult.error.message);

    const loopAdapter = createLoopAdapter({
      modelCall: createModelHandler(),
      maxTurns: 1,
    });

    const runtime = await createKoi({
      manifest: testManifest("mountmode-override"),
      adapter: loopAdapter,
      providers: [providerResult.value],
      loopDetection: false,
      limits: { maxTurns: 1, maxDurationMs: 30_000, maxTokens: 5_000 },
    });

    // Override should win over mountMode "none"
    const profile = mockAdapter.createCalls[0];
    if (!profile) throw new Error("expected adapter.create call");
    expect(profile.filesystem.allowRead).toEqual(["/override"]);
    expect(profile.filesystem.allowWrite).toEqual(["/override"]);

    const events = await collectEvents(runtime.run({ kind: "text", text: "Reply: override_ok" }));
    expect(findDoneOutput(events)?.stopReason).toBe("completed");

    await runtime.dispose();
  }, 60_000);
});

// ===========================================================================
// Feature 1b: Default MountMode is "none" (most restrictive)
// ===========================================================================

describeE2E("e2e: default mountMode through full Koi runtime", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "koi-e2e-default-mount-"));
    await mkdir(join(tempDir, "workspace"), { recursive: true });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test(
    "omitting mountMode defaults to 'none' — empty filesystem policy, real LLM call succeeds",
    async () => {
      const mockAdapter = createE2EMockAdapter(tempDir);
      // No mountMode specified → should default to "none"
      const backendResult = createDockerWorkspaceBackend({ adapter: mockAdapter });
      if (!backendResult.ok) throw new Error(backendResult.error.message);

      const providerResult = createWorkspaceProvider({
        backend: backendResult.value,
        cleanupPolicy: "always",
      });
      if (!providerResult.ok) throw new Error(providerResult.error.message);

      const piAdapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt: "Reply with exactly: default_none_ok",
        getApiKey: async () => ANTHROPIC_KEY,
      });

      const runtime = await createKoi({
        manifest: testManifest("default-mountmode"),
        adapter: piAdapter,
        providers: [providerResult.value],
        loopDetection: false,
      });

      // Verify: default is "none" — empty read and write arrays
      expect(mockAdapter.createCalls.length).toBe(1);
      const profile = mockAdapter.createCalls[0];
      if (!profile) throw new Error("expected adapter.create call");
      expect(profile.filesystem.allowRead).toEqual([]);
      expect(profile.filesystem.allowWrite).toEqual([]);

      // Real LLM call succeeds
      const events = await collectEvents(
        runtime.run({ kind: "text", text: "Reply with exactly: default_none_ok" }),
      );
      expect(findDoneOutput(events)?.stopReason).toBe("completed");
      expect(extractText(events).toLowerCase()).toContain("default_none_ok");

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );

  test(
    "explicit mountMode 'rw' overrides default 'none', real LLM call succeeds",
    async () => {
      const mockAdapter = createE2EMockAdapter(tempDir);
      const backendResult = createDockerWorkspaceBackend({
        adapter: mockAdapter,
        mountMode: "rw",
      });
      if (!backendResult.ok) throw new Error(backendResult.error.message);

      const providerResult = createWorkspaceProvider({
        backend: backendResult.value,
        cleanupPolicy: "always",
      });
      if (!providerResult.ok) throw new Error(providerResult.error.message);

      const runtime = await createKoi({
        manifest: testManifest("explicit-rw"),
        adapter: createPiAdapter({
          model: E2E_MODEL,
          systemPrompt: "Reply with exactly: rw_explicit_ok",
          getApiKey: async () => ANTHROPIC_KEY,
        }),
        providers: [providerResult.value],
        loopDetection: false,
      });

      // Verify: explicit "rw" sets read+write
      const profile = mockAdapter.createCalls[0];
      if (!profile) throw new Error("expected adapter.create call");
      expect(profile.filesystem.allowRead).toEqual(["/workspace"]);
      expect(profile.filesystem.allowWrite).toEqual(["/workspace"]);

      const events = await collectEvents(
        runtime.run({ kind: "text", text: "Reply with exactly: rw_explicit_ok" }),
      );
      expect(findDoneOutput(events)?.stopReason).toBe("completed");
      expect(extractText(events).toLowerCase()).toContain("rw_explicit_ok");

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );
});

// ===========================================================================
// Feature 1c: Blocked path patterns in shared scope
// ===========================================================================

describeE2E("e2e: blocked path patterns in shared scope", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "koi-e2e-blocked-"));
    await mkdir(join(tempDir, "workspace"), { recursive: true });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("shared scope rejects agentId containing .ssh", async () => {
    const mockAdapter = createE2EMockAdapter(tempDir);
    const backendResult = createDockerWorkspaceBackend({
      adapter: mockAdapter,
      scope: "shared",
    });
    if (!backendResult.ok) throw new Error(backendResult.error.message);

    // Direct backend call with malicious agentId
    const result = await backendResult.value.create(agentId("agent-.ssh-keys"), {
      cleanupPolicy: "on_success",
      cleanupTimeoutMs: 5_000,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("VALIDATION");
    expect(result.error.message).toContain("blocked path segment");
    expect(result.error.message).toContain(".ssh");
  });

  test("shared scope rejects agentId containing credentials", async () => {
    const mockAdapter = createE2EMockAdapter(tempDir);
    const backendResult = createDockerWorkspaceBackend({
      adapter: mockAdapter,
      scope: "shared",
    });
    if (!backendResult.ok) throw new Error(backendResult.error.message);

    const result = await backendResult.value.create(agentId("steal-credentials-now"), {
      cleanupPolicy: "on_success",
      cleanupTimeoutMs: 5_000,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("VALIDATION");
    expect(result.error.message).toContain("blocked path segment");
  });

  test("shared scope rejects agentId containing .env", async () => {
    const mockAdapter = createE2EMockAdapter(tempDir);
    const backendResult = createDockerWorkspaceBackend({
      adapter: mockAdapter,
      scope: "shared",
    });
    if (!backendResult.ok) throw new Error(backendResult.error.message);

    const result = await backendResult.value.create(agentId("read-.env-file"), {
      cleanupPolicy: "on_success",
      cleanupTimeoutMs: 5_000,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("VALIDATION");
    expect(result.error.message).toContain("blocked path segment");
    expect(result.error.message).toContain(".env");
  });

  test("shared scope allows safe agentId and full runtime succeeds", async () => {
    const mockAdapter = createE2EMockAdapter(tempDir);
    const backendResult = createDockerWorkspaceBackend({
      adapter: mockAdapter,
      scope: "shared",
    });
    if (!backendResult.ok) throw new Error(backendResult.error.message);

    const providerResult = createWorkspaceProvider({
      backend: backendResult.value,
      cleanupPolicy: "always",
    });
    if (!providerResult.ok) throw new Error(providerResult.error.message);

    const runtime = await createKoi({
      manifest: testManifest("safe-shared-agent"),
      adapter: createLoopAdapter({ modelCall: createModelHandler(), maxTurns: 1 }),
      providers: [providerResult.value],
      loopDetection: false,
      limits: { maxTurns: 1, maxDurationMs: 30_000, maxTokens: 5_000 },
    });

    // Shared scope with safe name → workspace created
    const ws = requireWs(runtime.agent.component<WorkspaceComponent>(WORKSPACE));
    expect(ws.path).toContain("/workspace/");

    // Real LLM call succeeds
    const events = await collectEvents(runtime.run({ kind: "text", text: "Say: safe_ok" }));
    expect(findDoneOutput(events)?.stopReason).toBe("completed");

    await runtime.dispose();
  }, 60_000);

  test("per-agent scope does NOT apply blocked path check (non-shared)", async () => {
    const mockAdapter = createE2EMockAdapter(tempDir);
    const backendResult = createDockerWorkspaceBackend({
      adapter: mockAdapter,
      scope: "per-agent",
    });
    if (!backendResult.ok) throw new Error(backendResult.error.message);

    // Per-agent scope doesn't use sub-paths, so blocked patterns don't apply
    const result = await backendResult.value.create(agentId("agent-.ssh-keys"), {
      cleanupPolicy: "on_success",
      cleanupTimeoutMs: 5_000,
    });
    // Should succeed — blocked patterns only apply to shared scope sub-paths
    expect(result.ok).toBe(true);
  });
});

// ===========================================================================
// Feature 2: ContainerScope — session + shared via createLoopAdapter
// ===========================================================================

describeE2E("e2e: ContainerScope through full Koi runtime", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "koi-e2e-scope-"));
    await mkdir(join(tempDir, "workspace"), { recursive: true });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  // ── Session scope ───────────────────────────────────────────────────────

  test(
    "session scope: fresh container per agent, real LLM calls succeed",
    async () => {
      const mockAdapter = createE2EMockAdapter(tempDir);
      const backendResult = createDockerWorkspaceBackend({
        adapter: mockAdapter,
        scope: "session",
      });
      if (!backendResult.ok) throw new Error(backendResult.error.message);

      // Agent 1
      const provider1Result = createWorkspaceProvider({
        backend: backendResult.value,
        cleanupPolicy: "always",
      });
      if (!provider1Result.ok) throw new Error(provider1Result.error.message);

      const runtime1 = await createKoi({
        manifest: testManifest("session-agent-1"),
        adapter: createLoopAdapter({ modelCall: createModelHandler(), maxTurns: 1 }),
        providers: [provider1Result.value],
        loopDetection: false,
        limits: { maxTurns: 1, maxDurationMs: 30_000, maxTokens: 5_000 },
      });

      // Agent 2
      const provider2Result = createWorkspaceProvider({
        backend: backendResult.value,
        cleanupPolicy: "always",
      });
      if (!provider2Result.ok) throw new Error(provider2Result.error.message);

      const runtime2 = await createKoi({
        manifest: testManifest("session-agent-2"),
        adapter: createLoopAdapter({ modelCall: createModelHandler(), maxTurns: 1 }),
        providers: [provider2Result.value],
        loopDetection: false,
        limits: { maxTurns: 1, maxDurationMs: 30_000, maxTokens: 5_000 },
      });

      // Session scope → two adapter.create calls (no reuse)
      expect(mockAdapter.createCalls.length).toBe(2);

      // Both get standard workspace path
      const ws1 = requireWs(runtime1.agent.component<WorkspaceComponent>(WORKSPACE));
      const ws2 = requireWs(runtime2.agent.component<WorkspaceComponent>(WORKSPACE));
      expect(ws1.path).toBe("/workspace");
      expect(ws2.path).toBe("/workspace");
      expect(ws1.id).not.toBe(ws2.id);

      // Real LLM calls in parallel
      const [events1, events2] = await Promise.all([
        collectEvents(runtime1.run({ kind: "text", text: "Say: session1" })),
        collectEvents(runtime2.run({ kind: "text", text: "Say: session2" })),
      ]);
      expect(findDoneOutput(events1)?.stopReason).toBe("completed");
      expect(findDoneOutput(events2)?.stopReason).toBe("completed");

      await Promise.all([runtime1.dispose(), runtime2.dispose()]);
    },
    TIMEOUT_MS,
  );

  test("session scope: dispose destroys container immediately", async () => {
    const mockAdapter = createE2EMockAdapter(tempDir);
    const backendResult = createDockerWorkspaceBackend({
      adapter: mockAdapter,
      scope: "session",
    });
    if (!backendResult.ok) throw new Error(backendResult.error.message);

    const providerResult = createWorkspaceProvider({
      backend: backendResult.value,
      cleanupPolicy: "always",
    });
    if (!providerResult.ok) throw new Error(providerResult.error.message);

    const runtime = await createKoi({
      manifest: testManifest("session-dispose"),
      adapter: createLoopAdapter({ modelCall: createModelHandler(), maxTurns: 1 }),
      providers: [providerResult.value],
      loopDetection: false,
      limits: { maxTurns: 1, maxDurationMs: 30_000, maxTokens: 5_000 },
    });

    expect(mockAdapter.destroyCalls.length).toBe(0);

    const events = await collectEvents(runtime.run({ kind: "text", text: "OK" }));
    expect(findDoneOutput(events)?.stopReason).toBe("completed");

    // Detach with "always" policy → container destroyed
    if (providerResult.value.detach) {
      await providerResult.value.detach(runtime.agent);
    }
    expect(mockAdapter.destroyCalls.length).toBe(1);

    await runtime.dispose();
  }, 60_000);

  // ── Shared scope ────────────────────────────────────────────────────────

  test(
    "shared scope: two agents share one container with unique sub-paths, real LLM calls succeed",
    async () => {
      const mockAdapter = createE2EMockAdapter(tempDir);
      const backendResult = createDockerWorkspaceBackend({
        adapter: mockAdapter,
        scope: "shared",
      });
      if (!backendResult.ok) throw new Error(backendResult.error.message);

      // Agent 1
      const provider1Result = createWorkspaceProvider({
        backend: backendResult.value,
        cleanupPolicy: "always",
      });
      if (!provider1Result.ok) throw new Error(provider1Result.error.message);

      const runtime1 = await createKoi({
        manifest: testManifest("shared-agent-1"),
        adapter: createLoopAdapter({ modelCall: createModelHandler(), maxTurns: 1 }),
        providers: [provider1Result.value],
        loopDetection: false,
        limits: { maxTurns: 1, maxDurationMs: 30_000, maxTokens: 5_000 },
      });

      // Agent 2
      const provider2Result = createWorkspaceProvider({
        backend: backendResult.value,
        cleanupPolicy: "always",
      });
      if (!provider2Result.ok) throw new Error(provider2Result.error.message);

      const runtime2 = await createKoi({
        manifest: testManifest("shared-agent-2"),
        adapter: createLoopAdapter({ modelCall: createModelHandler(), maxTurns: 1 }),
        providers: [provider2Result.value],
        loopDetection: false,
        limits: { maxTurns: 1, maxDurationMs: 30_000, maxTokens: 5_000 },
      });

      // Shared scope → only ONE adapter.create call
      expect(mockAdapter.createCalls.length).toBe(1);

      // Each agent gets unique sub-path
      const ws1 = requireWs(runtime1.agent.component<WorkspaceComponent>(WORKSPACE));
      const ws2 = requireWs(runtime2.agent.component<WorkspaceComponent>(WORKSPACE));
      expect(ws1.path).toContain("/workspace/");
      expect(ws2.path).toContain("/workspace/");
      expect(ws1.path).not.toBe(ws2.path);

      // Marker files exist on host at different sub-paths
      const marker1 = join(tempDir, ws1.path, ".koi-workspace");
      const marker2 = join(tempDir, ws2.path, ".koi-workspace");
      expect(existsSync(marker1)).toBe(true);
      expect(existsSync(marker2)).toBe(true);

      // Real LLM calls in parallel
      const [events1, events2] = await Promise.all([
        collectEvents(runtime1.run({ kind: "text", text: "Say: shared1" })),
        collectEvents(runtime2.run({ kind: "text", text: "Say: shared2" })),
      ]);
      expect(findDoneOutput(events1)?.stopReason).toBe("completed");
      expect(findDoneOutput(events2)?.stopReason).toBe("completed");

      await Promise.all([runtime1.dispose(), runtime2.dispose()]);
    },
    TIMEOUT_MS,
  );

  test(
    "shared scope: last dispose destroys the container",
    async () => {
      const mockAdapter = createE2EMockAdapter(tempDir);
      const backendResult = createDockerWorkspaceBackend({
        adapter: mockAdapter,
        scope: "shared",
      });
      if (!backendResult.ok) throw new Error(backendResult.error.message);
      const backend = backendResult.value;

      // Agent 1
      const provider1Result = createWorkspaceProvider({
        backend,
        cleanupPolicy: "always",
      });
      if (!provider1Result.ok) throw new Error(provider1Result.error.message);

      const runtime1 = await createKoi({
        manifest: testManifest("shared-refcount-1"),
        adapter: createLoopAdapter({ modelCall: createModelHandler(), maxTurns: 1 }),
        providers: [provider1Result.value],
        loopDetection: false,
        limits: { maxTurns: 1, maxDurationMs: 30_000, maxTokens: 5_000 },
      });

      // Agent 2
      const provider2Result = createWorkspaceProvider({
        backend,
        cleanupPolicy: "always",
      });
      if (!provider2Result.ok) throw new Error(provider2Result.error.message);

      const runtime2 = await createKoi({
        manifest: testManifest("shared-refcount-2"),
        adapter: createLoopAdapter({ modelCall: createModelHandler(), maxTurns: 1 }),
        providers: [provider2Result.value],
        loopDetection: false,
        limits: { maxTurns: 1, maxDurationMs: 30_000, maxTokens: 5_000 },
      });

      // Run both
      await Promise.all([
        collectEvents(runtime1.run({ kind: "text", text: "Say: ref1" })),
        collectEvents(runtime2.run({ kind: "text", text: "Say: ref2" })),
      ]);

      // First detach → container NOT destroyed (ref count > 0)
      if (provider1Result.value.detach) {
        await provider1Result.value.detach(runtime1.agent);
      }
      expect(mockAdapter.destroyCalls.length).toBe(0);

      // Second detach → container destroyed (last ref)
      if (provider2Result.value.detach) {
        await provider2Result.value.detach(runtime2.agent);
      }
      expect(mockAdapter.destroyCalls.length).toBe(1);

      await Promise.all([runtime1.dispose(), runtime2.dispose()]);
    },
    TIMEOUT_MS,
  );
});

// ===========================================================================
// Feature 3: requireSandbox + isSandboxed
// ===========================================================================

describeE2E("e2e: requireSandbox through full Koi runtime", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "koi-e2e-sandbox-"));
    await mkdir(join(tempDir, "workspace"), { recursive: true });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test(
    "requireSandbox: true + docker backend (isSandboxed: true) → full runtime succeeds",
    async () => {
      const mockAdapter = createE2EMockAdapter(tempDir);
      const backendResult = createDockerWorkspaceBackend({ adapter: mockAdapter });
      if (!backendResult.ok) throw new Error(backendResult.error.message);

      // Verify isSandboxed flag
      expect(backendResult.value.isSandboxed).toBe(true);

      const providerResult = createWorkspaceProvider({
        backend: backendResult.value,
        requireSandbox: true,
        cleanupPolicy: "always",
      });
      // Should succeed — docker backend is sandboxed
      expect(providerResult.ok).toBe(true);
      if (!providerResult.ok) throw new Error(providerResult.error.message);

      const runtime = await createKoi({
        manifest: testManifest("require-sandbox-pass"),
        adapter: createPiAdapter({
          model: E2E_MODEL,
          systemPrompt: "Reply with exactly: sandbox_ok",
          getApiKey: async () => ANTHROPIC_KEY,
        }),
        providers: [providerResult.value],
        loopDetection: false,
      });

      const ws = requireWs(runtime.agent.component<WorkspaceComponent>(WORKSPACE));
      expect(ws.path).toBe("/workspace");

      const events = await collectEvents(
        runtime.run({ kind: "text", text: "Reply with exactly: sandbox_ok" }),
      );
      expect(findDoneOutput(events)?.stopReason).toBe("completed");
      expect(extractText(events).toLowerCase()).toContain("sandbox_ok");

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );

  test("requireSandbox: true + non-sandboxed backend → provider creation fails", () => {
    const fakeBackend: WorkspaceBackend = {
      name: "tmpdir",
      isSandboxed: false,
      create: async () => ({
        ok: true,
        value: { id: workspaceId("x"), path: "/tmp", createdAt: 0, metadata: {} },
      }),
      dispose: async () => ({ ok: true, value: undefined }),
      isHealthy: () => false,
    };

    const providerResult = createWorkspaceProvider({
      backend: fakeBackend,
      requireSandbox: true,
    });

    expect(providerResult.ok).toBe(false);
    if (providerResult.ok) return;
    expect(providerResult.error.code).toBe("VALIDATION");
    expect(providerResult.error.message).toContain("requireSandbox");
    expect(providerResult.error.message).toContain("container isolation");
  });

  test("requireSandbox: false (default) allows non-sandboxed backends", () => {
    const fakeBackend: WorkspaceBackend = {
      name: "tmpdir",
      isSandboxed: false,
      create: async () => ({
        ok: true,
        value: { id: workspaceId("x"), path: "/tmp", createdAt: 0, metadata: {} },
      }),
      dispose: async () => ({ ok: true, value: undefined }),
      isHealthy: () => false,
    };

    // No requireSandbox → should succeed
    const providerResult = createWorkspaceProvider({ backend: fakeBackend });
    expect(providerResult.ok).toBe(true);
  });
});

// ===========================================================================
// Combined: MountMode + Scope + Middleware chain via createPiAdapter
// ===========================================================================

describeE2E("e2e: all features combined through full runtime with middleware", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "koi-e2e-combined-"));
    await mkdir(join(tempDir, "workspace"), { recursive: true });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test(
    'mountMode "ro" + session scope + requireSandbox + middleware: full integration',
    async () => {
      const mockAdapter = createE2EMockAdapter(tempDir);
      const backendResult = createDockerWorkspaceBackend({
        adapter: mockAdapter,
        mountMode: "ro",
        scope: "session",
      });
      if (!backendResult.ok) throw new Error(backendResult.error.message);

      const providerResult = createWorkspaceProvider({
        backend: backendResult.value,
        requireSandbox: true,
        cleanupPolicy: "always",
      });
      if (!providerResult.ok) throw new Error(providerResult.error.message);

      // Middleware: observe model calls
      // let justified: test tracking counter
      let modelCallCount = 0;
      const observer: import("@koi/core").KoiMiddleware = {
        name: "e2e-model-observer",
        describeCapabilities: () => undefined,
        wrapModelCall: async (_ctx, request, next) => {
          modelCallCount += 1;
          return next(request);
        },
      };

      const runtime = await createKoi({
        manifest: testManifest("combined-all-features"),
        adapter: createLoopAdapter({ modelCall: createModelHandler(), maxTurns: 1 }),
        middleware: [observer],
        providers: [providerResult.value],
        loopDetection: false,
        limits: { maxTurns: 1, maxDurationMs: 30_000, maxTokens: 5_000 },
      });

      // Verify: mountMode "ro" applied
      const profile = mockAdapter.createCalls[0];
      if (!profile) throw new Error("expected adapter.create call");
      expect(profile.filesystem.allowRead).toEqual(["/workspace"]);
      expect(profile.filesystem.allowWrite).toEqual([]);

      // Verify: workspace attached
      const ws = requireWs(runtime.agent.component<WorkspaceComponent>(WORKSPACE));
      expect(ws.path).toBe("/workspace");

      // Verify: isSandboxed flag
      expect(backendResult.value.isSandboxed).toBe(true);

      // Real LLM call through middleware chain
      const events = await collectEvents(
        runtime.run({ kind: "text", text: "Reply with exactly: combined_ok" }),
      );
      expect(findDoneOutput(events)?.stopReason).toBe("completed");

      // Middleware was exercised
      expect(modelCallCount).toBeGreaterThanOrEqual(1);

      // Session scope → container created once
      expect(mockAdapter.createCalls.length).toBe(1);

      // Cleanup
      if (providerResult.value.detach) {
        await providerResult.value.detach(runtime.agent);
      }
      // Session scope → destroyed on detach
      expect(mockAdapter.destroyCalls.length).toBe(1);

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );
});
