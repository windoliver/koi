import { beforeEach, describe, expect, it } from "bun:test";
import type {
  Agent,
  AgentId,
  KoiError,
  ResolvedWorkspaceConfig,
  Result,
  WorkspaceBackend,
  WorkspaceId,
  WorkspaceInfo,
} from "@koi/core";
import { agentId, isAttachResult, WORKSPACE, workspaceId } from "@koi/core";
import { createWorkspaceProvider } from "./provider.js";

function makeAgent(id = agentId("agent-1")): Agent {
  return {
    pid: { id, name: "test", type: "copilot", depth: 0 },
    state: "running",
    manifest: {} as Agent["manifest"],
    component: () => undefined,
    has: () => false,
    hasAll: () => false,
    query: () => new Map(),
    components: () => new Map(),
  } as unknown as Agent;
}

function makeBackend(
  overrides: Partial<WorkspaceBackend> = {},
): WorkspaceBackend & { created: WorkspaceInfo[]; disposed: WorkspaceId[] } {
  let counter = 0;
  const created: WorkspaceInfo[] = [];
  const disposed: WorkspaceId[] = [];
  return {
    name: "mock",
    isSandboxed: true,
    created,
    disposed,
    async create(
      _agentId: AgentId,
      _config: ResolvedWorkspaceConfig,
    ): Promise<Result<WorkspaceInfo, KoiError>> {
      const id = workspaceId(`ws-${++counter}`);
      const info: WorkspaceInfo = {
        id,
        path: `/tmp/ws-${counter}`,
        createdAt: Date.now(),
        metadata: {},
      };
      created.push(info);
      return { ok: true, value: info };
    },
    async dispose(wsId: WorkspaceId): Promise<Result<void, KoiError>> {
      disposed.push(wsId);
      return { ok: true, value: undefined };
    },
    isHealthy(_wsId: WorkspaceId): boolean {
      return true;
    },
    ...overrides,
  };
}

describe("createWorkspaceProvider", () => {
  let backend: ReturnType<typeof makeBackend>;

  beforeEach(() => {
    backend = makeBackend();
  });

  it("attach returns WORKSPACE component", async () => {
    const provider = createWorkspaceProvider({ backend });
    const agent = makeAgent();
    const raw = await provider.attach(agent);
    const result = isAttachResult(raw) ? raw : { components: raw, skipped: [] };

    // WORKSPACE is a branded string — use it directly as the key
    expect(result.components.has(WORKSPACE as string)).toBe(true);
    const ws = result.components.get(WORKSPACE as string) as WorkspaceInfo;
    expect(ws.id).toBeTruthy();
    expect(ws.path).toBeTruthy();
    await provider.detach?.(agent);
  });

  it("attach calls backend.create", async () => {
    const provider = createWorkspaceProvider({ backend });
    const agent = makeAgent();
    await provider.attach(agent);
    expect(backend.created.length).toBe(1);
    await provider.detach?.(agent);
  });

  it("calls postCreate after workspace created", async () => {
    let postCreateCalled = false;
    const provider = createWorkspaceProvider({
      backend,
      postCreate: async (_ws) => {
        postCreateCalled = true;
      },
    });
    const agent = makeAgent();
    await provider.attach(agent);
    expect(postCreateCalled).toBe(true);
    await provider.detach?.(agent);
  });

  it("detach with cleanupPolicy=always disposes workspace", async () => {
    const provider = createWorkspaceProvider({ backend, cleanupPolicy: "always" });
    const agent = makeAgent();
    await provider.attach(agent);
    await provider.detach?.(agent);
    expect(backend.disposed.length).toBe(1);
  });

  it("detach with cleanupPolicy=never skips dispose", async () => {
    const provider = createWorkspaceProvider({ backend, cleanupPolicy: "never" });
    const agent = makeAgent();
    await provider.attach(agent);
    await provider.detach?.(agent);
    expect(backend.disposed.length).toBe(0);
  });

  it("detach with cleanupPolicy=on_success disposes on success outcome", async () => {
    const provider = createWorkspaceProvider({ backend, cleanupPolicy: "on_success" });
    const agent = makeAgent();
    agent.pid as unknown as Record<string, unknown>;
    const successAgent = { ...agent, terminationOutcome: "success" } as unknown as Agent;
    await provider.attach(successAgent);
    await provider.detach?.(successAgent);
    expect(backend.disposed.length).toBe(1);
  });

  it("detach with cleanupPolicy=on_success preserves workspace on error outcome", async () => {
    const provider = createWorkspaceProvider({ backend, cleanupPolicy: "on_success" });
    const agent = makeAgent();
    const failedAgent = { ...agent, terminationOutcome: "error" } as unknown as Agent;
    await provider.attach(failedAgent);
    await provider.detach?.(failedAgent);
    expect(backend.disposed.length).toBe(0);
  });

  it("postCreate failure disposes workspace and rethrows", async () => {
    const provider = createWorkspaceProvider({
      backend,
      postCreate: async () => {
        throw new Error("setup failed");
      },
    });
    const agent = makeAgent();
    await expect(provider.attach(agent)).rejects.toThrow("setup failed");
    expect(backend.disposed.length).toBe(1);
  });

  it("concurrent attach for same agent throws on second call", async () => {
    let resolveCrate!: (info: WorkspaceInfo) => void;
    const slowBackend = makeBackend({
      async create(_aid, _cfg) {
        await new Promise<void>((r) => {
          resolveCrate = (info) => {
            backend.created.push(info);
            r();
          };
        });
        const id = workspaceId("ws-slow");
        return {
          ok: true,
          value: { id, path: "/tmp/ws-slow", createdAt: Date.now(), metadata: {} },
        };
      },
    });
    const provider = createWorkspaceProvider({ backend: slowBackend });
    const agent = makeAgent();

    const first = provider.attach(agent);
    await expect(provider.attach(agent)).rejects.toThrow("Concurrent attach");
    resolveCrate({
      id: workspaceId("ws-slow"),
      path: "/tmp/ws-slow",
      createdAt: Date.now(),
      metadata: {},
    });
    await provider.detach?.(agent);
    await first;
  });

  it("reattach after on_success non-disposal reclaims old workspace", async () => {
    const provider = createWorkspaceProvider({ backend, cleanupPolicy: "on_success" });
    const agent = makeAgent();
    const failedAgent = { ...agent, terminationOutcome: "error" } as unknown as Agent;
    await provider.attach(failedAgent);
    expect(backend.created.length).toBe(1);
    // detach with error outcome — workspace preserved, still tracked
    await provider.detach?.(failedAgent);
    expect(backend.disposed.length).toBe(0);

    // reattach — stale workspace reclaimed before creating a new one
    await provider.attach(agent);
    expect(backend.disposed.length).toBe(1); // old workspace disposed
    expect(backend.created.length).toBe(2); // new workspace created
    await provider.detach?.(agent);
  });

  it("reattach with cleanupPolicy=never reuses preserved workspace, no new create", async () => {
    const provider = createWorkspaceProvider({ backend, cleanupPolicy: "never" });
    const agent = makeAgent();
    const first = await provider.attach(agent);
    await provider.detach?.(agent); // never policy: workspace kept
    expect(backend.disposed.length).toBe(0);

    // Reattach — policy=never must reuse the preserved workspace, not create a new one
    const second = await provider.attach(agent);
    expect(backend.disposed.length).toBe(0); // still not disposed
    expect(backend.created.length).toBe(1); // no second create

    const firstResult = isAttachResult(first) ? first : { components: first, skipped: [] };
    const secondResult = isAttachResult(second) ? second : { components: second, skipped: [] };
    const firstWs = firstResult.components.get(WORKSPACE as string) as WorkspaceInfo;
    const secondWs = secondResult.components.get(WORKSPACE as string) as WorkspaceInfo;
    expect(secondWs.id).toBe(firstWs.id); // same workspace returned

    await provider.detach?.(agent);
  });

  it("cleanupPolicy=never reattach recreates workspace when preserved one is unhealthy", async () => {
    let healthy = true;
    const unhealthyBackend = makeBackend({
      isHealthy(_wsId: WorkspaceId): boolean {
        return healthy;
      },
    });
    const provider = createWorkspaceProvider({ backend: unhealthyBackend, cleanupPolicy: "never" });
    const agent = makeAgent();
    await provider.attach(agent);
    await provider.detach?.(agent);

    // Simulate external deletion of the worktree
    healthy = false;

    // Reattach — preserved workspace is unhealthy, so a new one must be created
    await provider.attach(agent);
    expect(unhealthyBackend.created.length).toBe(2); // new workspace created
    await provider.detach?.(agent);
  });

  it("postCreate + dispose both fail: tracks workspace for retry and throws combined error", async () => {
    const failDisposeBackend = makeBackend({
      async dispose(): Promise<Result<void, KoiError>> {
        return {
          ok: false,
          error: { code: "EXTERNAL", message: "cleanup failed", retryable: false },
        };
      },
    });
    const provider = createWorkspaceProvider({
      backend: failDisposeBackend,
      postCreate: async () => {
        throw new Error("setup failed");
      },
    });
    const agent = makeAgent();
    await expect(provider.attach(agent)).rejects.toThrow("cleanup also timed out or failed");
    // Workspace should still be tracked so a later detach can retry cleanup
    await expect(provider.detach?.(agent)).resolves.toBeUndefined();
  });

  it("failed-setup workspace is not reused on next attach under cleanupPolicy=never", async () => {
    let disposeCount = 0;
    const failOnceDisposeBackend = makeBackend({
      async dispose(): Promise<Result<void, KoiError>> {
        if (disposeCount++ === 0) {
          // First dispose fails (cleanup of failed-setup workspace)
          return {
            ok: false,
            error: { code: "EXTERNAL", message: "cleanup failed", retryable: false },
          };
        }
        return { ok: true, value: undefined };
      },
    });
    const provider = createWorkspaceProvider({
      backend: failOnceDisposeBackend,
      cleanupPolicy: "never",
      postCreate: async () => {
        if (failOnceDisposeBackend.created.length === 1) throw new Error("setup failed");
      },
    });
    const agent = makeAgent();
    // First attach fails setup; cleanup also fails → workspace tracked as setup-failed
    await expect(provider.attach(agent)).rejects.toThrow("cleanup also timed out or failed");
    expect(failOnceDisposeBackend.created.length).toBe(1);

    // Second attach under "never" policy must NOT reuse the broken workspace
    await provider.attach(agent);
    expect(failOnceDisposeBackend.created.length).toBe(2); // new workspace created
    await provider.detach?.(agent);
  });

  it("backend create failure propagates as thrown error", async () => {
    const failBackend = makeBackend({
      async create(): Promise<Result<WorkspaceInfo, KoiError>> {
        return { ok: false, error: { code: "EXTERNAL", message: "disk full", retryable: false } };
      },
    });
    const provider = createWorkspaceProvider({ backend: failBackend });
    const agent = makeAgent();
    await expect(provider.attach(agent)).rejects.toThrow();
  });

  it("attach reclaims crash-survivor workspace found via findByAgentId", async () => {
    // Simulate a workspace that survived a process restart: not in `attached` map
    // but discoverable via backend.findByAgentId (on-disk marker scan).
    const survivorId = workspaceId("ws-survivor");
    const survivorInfo: WorkspaceInfo = {
      id: survivorId,
      path: "/tmp/ws-survivor",
      createdAt: Date.now(),
      metadata: {},
    };
    const backendWithFind = makeBackend({
      async findByAgentId(_aid: AgentId): Promise<WorkspaceInfo | undefined> {
        return survivorInfo;
      },
    });
    const provider = createWorkspaceProvider({ backend: backendWithFind });
    const agent = makeAgent();

    // First attach — no in-memory state, findByAgentId returns survivor
    await provider.attach(agent);
    // Survivor was disposed before creating the new workspace
    expect(backendWithFind.disposed).toContain(survivorId);
    // A new workspace was created
    expect(backendWithFind.created.length).toBe(1);
    await provider.detach?.(agent);
  });

  it("cleanupPolicy=never reuses crash-surviving workspace found via findByAgentId", async () => {
    // After restart, `attached` map is empty but findByAgentId finds survivor.
    // With never policy, it should be reused if healthy and setup was proven complete.
    // The backend must implement verifySetupComplete to provide a trusted recovery signal.
    const survivorId = workspaceId("ws-survivor-never");
    const survivorInfo: WorkspaceInfo = {
      id: survivorId,
      path: "/tmp/ws-survivor-never",
      createdAt: Date.now(),
      metadata: {},
    };
    const backendWithFind = makeBackend({
      async findByAgentId(_aid: AgentId): Promise<WorkspaceInfo | undefined> {
        return survivorInfo;
      },
      isHealthy(_wsId: WorkspaceId): boolean {
        return true;
      },
      async verifySetupComplete(_wsId: WorkspaceId): Promise<boolean> {
        return true;
      },
    });
    const provider = createWorkspaceProvider({
      backend: backendWithFind,
      cleanupPolicy: "never",
    });
    const agent = makeAgent();

    const result = await provider.attach(agent);
    // Survivor should be REUSED, not disposed
    expect(backendWithFind.disposed).not.toContain(survivorId);
    // No new workspace created — existing one reused
    expect(backendWithFind.created.length).toBe(0);
    // Returned workspace is the survivor
    const attachResult = isAttachResult(result) ? result : { components: result, skipped: [] };
    const ws = attachResult.components.get(WORKSPACE as string) as WorkspaceInfo;
    expect(ws.id).toBe(survivorId);
    await provider.detach?.(agent);
  });

  it("cleanupPolicy=never disposes and recreates crash-survivor whose setup was incomplete", async () => {
    // Crash survivor found via findByAgentId but verifySetupComplete returns false
    // (setup never completed before crash) — must not be reused.
    const survivorId = workspaceId("ws-no-setup-complete");
    const survivorInfo: WorkspaceInfo = {
      id: survivorId,
      path: "/tmp/ws-no-setup-complete",
      createdAt: Date.now(),
      metadata: {},
    };
    const backendWithFind = makeBackend({
      async findByAgentId(_aid: AgentId): Promise<WorkspaceInfo | undefined> {
        return survivorInfo;
      },
      isHealthy(_wsId: WorkspaceId): boolean {
        return true;
      },
      async verifySetupComplete(_wsId: WorkspaceId): Promise<boolean> {
        return false;
      },
    });
    const provider = createWorkspaceProvider({ backend: backendWithFind, cleanupPolicy: "never" });
    const agent = makeAgent();

    await provider.attach(agent);
    // Survivor was disposed (setup incomplete) and a new workspace created
    expect(backendWithFind.disposed).toContain(survivorId);
    expect(backendWithFind.created.length).toBe(1);
    await provider.detach?.(agent);
  });

  it("cleanupPolicy=never disposes and recreates crash-survivor when backend has no verifySetupComplete", async () => {
    // Backend without verifySetupComplete cannot provide trusted recovery proof — recreate.
    const survivorId = workspaceId("ws-no-trusted-recovery");
    const survivorInfo: WorkspaceInfo = {
      id: survivorId,
      path: "/tmp/ws-no-trusted-recovery",
      createdAt: Date.now(),
      metadata: {},
    };
    const backendWithFind = makeBackend({
      async findByAgentId(_aid: AgentId): Promise<WorkspaceInfo | undefined> {
        return survivorInfo;
      },
      isHealthy(_wsId: WorkspaceId): boolean {
        return true;
      },
      // No verifySetupComplete — no trusted recovery
    });
    const provider = createWorkspaceProvider({ backend: backendWithFind, cleanupPolicy: "never" });
    const agent = makeAgent();

    await provider.attach(agent);
    expect(backendWithFind.disposed).toContain(survivorId);
    expect(backendWithFind.created.length).toBe(1);
    await provider.detach?.(agent);
  });

  it("cleanupPolicy=never reruns postCreate on crash-surviving workspace to repair drift", async () => {
    const survivorId = workspaceId("ws-survivor-rerun");
    const survivorInfo: WorkspaceInfo = {
      id: survivorId,
      path: "/tmp/ws-survivor-rerun",
      createdAt: Date.now(),
      metadata: {},
    };
    let postCreateCallCount = 0;
    const backendWithFind = makeBackend({
      async findByAgentId(_aid: AgentId): Promise<WorkspaceInfo | undefined> {
        return survivorInfo;
      },
      isHealthy(_wsId: WorkspaceId): boolean {
        return true;
      },
      async verifySetupComplete(_wsId: WorkspaceId): Promise<boolean> {
        return true;
      },
    });
    const provider = createWorkspaceProvider({
      backend: backendWithFind,
      cleanupPolicy: "never",
      postCreate: async (_ws) => {
        postCreateCallCount++;
      },
    });
    const agent = makeAgent();
    const result = await provider.attach(agent);
    // Survivor reused — no new workspace
    expect(backendWithFind.created.length).toBe(0);
    // postCreate was rerun to repair any drift
    expect(postCreateCallCount).toBe(1);
    const attachResult = isAttachResult(result) ? result : { components: result, skipped: [] };
    const ws = attachResult.components.get(WORKSPACE as string) as WorkspaceInfo;
    expect(ws.id).toBe(survivorId);
    await provider.detach?.(agent);
  });

  it("provider.name is set", () => {
    const provider = createWorkspaceProvider({ backend });
    expect(provider.name).toBe("workspace");
  });

  it("cleanupPolicy=never attach succeeds for unsandboxed backend without attestSetupComplete (reuse disabled implicitly)", async () => {
    const unsandboxedBackend = makeBackend({ isSandboxed: false });
    const provider = createWorkspaceProvider({
      backend: unsandboxedBackend,
      cleanupPolicy: "never",
    });
    const result = await provider.attach(makeAgent());
    expect(isAttachResult(result)).toBe(true);
    expect(unsandboxedBackend.created.length).toBe(1);
  });

  it("unsandboxed backend without verifySetupComplete returns false from isSetupComplete so crash-survivor is recreated", async () => {
    const survivorId = workspaceId("ws-survivor-unsandboxed");
    const unsandboxedBackend = makeBackend({
      isSandboxed: false,
      findByAgentId: async () => ({
        id: survivorId,
        path: `/tmp/${survivorId}`,
        createdAt: Date.now() - 1000,
        metadata: {},
      }),
      isHealthy(_wsId: WorkspaceId): boolean {
        return true;
      },
    });
    const provider = createWorkspaceProvider({
      backend: unsandboxedBackend,
      cleanupPolicy: "never",
    });
    await provider.attach(makeAgent());
    // Survivor should be disposed (not trusted) and a new workspace created
    expect(unsandboxedBackend.disposed).toContain(survivorId);
    expect(unsandboxedBackend.created.length).toBe(1);
  });

  it("attestation failure in cleanupPolicy=never disposes workspace and rethrows", async () => {
    const attestError = new Error("git update-ref failed");
    const attestingBackend = makeBackend({
      isSandboxed: true,
      attestSetupComplete: async () => {
        throw attestError;
      },
    });
    const provider = createWorkspaceProvider({
      backend: attestingBackend,
      cleanupPolicy: "never",
    });
    await expect(provider.attach(makeAgent())).rejects.toThrow("git update-ref failed");
    // Workspace should have been disposed during rollback
    expect(attestingBackend.disposed.length).toBe(1);
  });
});
