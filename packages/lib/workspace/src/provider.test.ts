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
      async findByAgentId(_aid: AgentId): Promise<ReadonlyArray<WorkspaceInfo>> {
        return [survivorInfo];
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

  it("attach throws instead of creating when crash-survivor disposal times out on sandboxed backend (non-never policy)", async () => {
    // Sandboxed backends enforce the single-workspace-per-agent invariant strictly:
    // disposal timeout blocks creation because we cannot prove the old workspace is gone.
    const survivorId = workspaceId("ws-stuck-survivor");
    const survivorInfo: WorkspaceInfo = {
      id: survivorId,
      path: "/tmp/ws-stuck",
      createdAt: Date.now(),
      metadata: {},
    };
    const backendWithStuckDispose = makeBackend({
      isSandboxed: true,
      async findByAgentId(_aid: AgentId): Promise<ReadonlyArray<WorkspaceInfo>> {
        return [survivorInfo];
      },
      async dispose(_wsId: WorkspaceId): Promise<Result<void, KoiError>> {
        return {
          ok: false,
          error: { code: "EXTERNAL", message: "removal timed out", retryable: false },
        };
      },
    });
    const provider = createWorkspaceProvider({
      backend: backendWithStuckDispose,
      cleanupPolicy: "always",
      cleanupTimeoutMs: 1,
    });
    const agent = makeAgent();

    await expect(provider.attach(agent)).rejects.toThrow(
      "crash-survivor ws-stuck-survivor could not be disposed",
    );
    // No new workspace must have been created
    expect(backendWithStuckDispose.created.length).toBe(0);
  });

  it("attach proceeds on unsandboxed backend when crash-survivor disposal fails but exists() confirms workspace is gone (non-never policy)", async () => {
    // Unsandboxed: disposal timeout is only treated as transient when exists() confirms
    // the workspace is actually gone. isHealthy() is not a reliable liveness oracle (it
    // returns false for branch-drifted workspaces that are still registered with git).
    const survivorId = workspaceId("ws-unsandboxed-stuck");
    const survivorInfo: WorkspaceInfo = {
      id: survivorId,
      path: "/tmp/ws-stuck-unsandboxed",
      createdAt: Date.now(),
      metadata: {},
    };
    const backendWithStuckDispose = makeBackend({
      isSandboxed: false,
      async findByAgentId(_aid: AgentId): Promise<ReadonlyArray<WorkspaceInfo>> {
        return [survivorInfo];
      },
      async dispose(_wsId: WorkspaceId): Promise<Result<void, KoiError>> {
        return {
          ok: false,
          error: { code: "EXTERNAL", message: "removal timed out", retryable: false },
        };
      },
      isHealthy(_wsId: WorkspaceId): boolean {
        return false; // unhealthy (e.g. branch-drifted) — not a reliable "gone" signal
      },
      exists(_wsId: WorkspaceId): boolean {
        return false; // exists() is the authoritative gone-oracle: workspace is truly gone
      },
    });
    const provider = createWorkspaceProvider({
      backend: backendWithStuckDispose,
      cleanupPolicy: "always",
      cleanupTimeoutMs: 1,
    });
    const agent = makeAgent();

    // Must NOT throw — exists() confirmed workspace is gone, invariant is safe
    const result = await provider.attach(agent);
    expect(result.components.size).toBe(1);
    expect(backendWithStuckDispose.created.length).toBe(1);
    await provider.detach?.(agent);
  });

  it("attach throws on unsandboxed backend when crash-survivor disposal fails and exists() confirms workspace is still alive (non-never policy)", async () => {
    // Unsandboxed: when exists() confirms the old workspace is still alive after a
    // disposal failure, attach must block — creating a second workspace would break the invariant.
    // Backends without exists() also fail closed (isGone returns false).
    const survivorId = workspaceId("ws-still-alive");
    const survivorInfo: WorkspaceInfo = {
      id: survivorId,
      path: "/tmp/ws-still-alive",
      createdAt: Date.now(),
      metadata: {},
    };
    const backendStillAlive = makeBackend({
      isSandboxed: false,
      async findByAgentId(_aid: AgentId): Promise<ReadonlyArray<WorkspaceInfo>> {
        return [survivorInfo];
      },
      async dispose(_wsId: WorkspaceId): Promise<Result<void, KoiError>> {
        return {
          ok: false,
          error: { code: "EXTERNAL", message: "still running", retryable: false },
        };
      },
      isHealthy(_wsId: WorkspaceId): boolean {
        return true; // workspace confirmed still alive
      },
      exists(_wsId: WorkspaceId): boolean {
        return true; // exists() authoritative: workspace is still present
      },
    });
    const provider = createWorkspaceProvider({
      backend: backendStillAlive,
      cleanupPolicy: "always",
      cleanupTimeoutMs: 1,
    });
    const agent = makeAgent();

    await expect(provider.attach(agent)).rejects.toThrow(
      "crash-survivor ws-still-alive could not be disposed",
    );
    expect(backendStillAlive.created.length).toBe(0);
  });

  it("cleanupPolicy=never reruns postCreate on in-process preserved workspace to repair drift", async () => {
    // Workspace preserved via "never" policy (staleInfo in attached map) must also rerun
    // postCreate on subsequent attach to repair any setup drift between turns.
    let postCreateCallCount = 0;
    const provider = createWorkspaceProvider({
      backend,
      cleanupPolicy: "never",
      postCreate: async (_ws) => {
        postCreateCallCount++;
      },
    });
    const agent = makeAgent();

    // First attach — creates workspace, runs postCreate
    await provider.attach(agent);
    expect(postCreateCallCount).toBe(1);
    expect(backend.created.length).toBe(1);

    // Detach with "never" — workspace preserved in attached map
    await provider.detach?.(agent);
    expect(backend.disposed).toHaveLength(0);

    // Second attach — workspace reused, postCreate reruns for drift repair
    await provider.attach(agent);
    expect(postCreateCallCount).toBe(2);
    expect(backend.created.length).toBe(1); // no new workspace created

    await provider.detach?.(agent);
  });

  it("cleanupPolicy=never reuses in-process workspace on unsandboxed backend without attestation", async () => {
    // Regression: isSetupComplete() always returns false for unsandboxed backends (by design,
    // to prevent forged crash-survivor attestation). But in-process preserved workspaces are
    // tracked in-memory and must not require attestation — only health.
    let postCreateCalls = 0;
    const unsandboxedBackend = makeBackend({
      isSandboxed: false,
      // no attestSetupComplete / verifySetupComplete — isSetupComplete() returns false
    });
    const provider = createWorkspaceProvider({
      backend: unsandboxedBackend,
      cleanupPolicy: "never",
      postCreate: async (_ws) => {
        postCreateCalls++;
      },
    });
    const agent = makeAgent();

    await provider.attach(agent);
    expect(unsandboxedBackend.created.length).toBe(1);
    expect(postCreateCalls).toBe(1);

    await provider.detach?.(agent);
    expect(unsandboxedBackend.disposed).toHaveLength(0);

    // Second attach — must reuse, not create a new workspace
    await provider.attach(agent);
    expect(unsandboxedBackend.created.length).toBe(1); // still 1
    expect(postCreateCalls).toBe(2); // postCreate reruns for drift repair
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
      async findByAgentId(_aid: AgentId): Promise<ReadonlyArray<WorkspaceInfo>> {
        return [survivorInfo];
      },
      isHealthy(_wsId: WorkspaceId): boolean {
        return true;
      },
      async verifySetupComplete(_wsId: WorkspaceId): Promise<boolean> {
        return true;
      },
      async invalidateSetupComplete(_wsId: WorkspaceId): Promise<void> {},
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
      async findByAgentId(_aid: AgentId): Promise<ReadonlyArray<WorkspaceInfo>> {
        return [survivorInfo];
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
      async findByAgentId(_aid: AgentId): Promise<ReadonlyArray<WorkspaceInfo>> {
        return [survivorInfo];
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
      async findByAgentId(_aid: AgentId): Promise<ReadonlyArray<WorkspaceInfo>> {
        return [survivorInfo];
      },
      isHealthy(_wsId: WorkspaceId): boolean {
        return true;
      },
      async verifySetupComplete(_wsId: WorkspaceId): Promise<boolean> {
        return true;
      },
      async invalidateSetupComplete(_wsId: WorkspaceId): Promise<void> {},
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
      findByAgentId: async () => [
        { id: survivorId, path: `/tmp/${survivorId}`, createdAt: Date.now() - 1000, metadata: {} },
      ],
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

  it("unsandboxed backend with verifySetupComplete is still NOT trusted for crash-survivor reuse", async () => {
    // Even if the backend implements verifySetupComplete, an unsandboxed backend cannot
    // prevent the agent from forging the attestation. Provider must require isSandboxed:true.
    const survivorId = workspaceId("ws-survivor-unsandboxed-attest");
    const unsandboxedWithAttest = makeBackend({
      isSandboxed: false,
      findByAgentId: async () => [
        { id: survivorId, path: `/tmp/${survivorId}`, createdAt: Date.now() - 1000, metadata: {} },
      ],
      isHealthy(_wsId: WorkspaceId): boolean {
        return true;
      },
      async verifySetupComplete(_wsId: WorkspaceId): Promise<boolean> {
        return true;
      },
    });
    const provider = createWorkspaceProvider({
      backend: unsandboxedWithAttest,
      cleanupPolicy: "never",
    });
    await provider.attach(makeAgent());
    // Survivor must be disposed even though verifySetupComplete returns true
    expect(unsandboxedWithAttest.disposed).toContain(survivorId);
    expect(unsandboxedWithAttest.created.length).toBe(1);
  });

  it("cleanupPolicy=never tries older survivor when newest is unhealthy", async () => {
    // Multiple crash survivors: newest is unhealthy, older one is valid.
    // Provider should dispose the newest, reuse the older one.
    const newerBadId = workspaceId("ws-newer-bad");
    const olderGoodId = workspaceId("ws-older-good");
    const newerBad: WorkspaceInfo = {
      id: newerBadId,
      path: "/tmp/ws-newer-bad",
      createdAt: Date.now(),
      metadata: {},
    };
    const olderGood: WorkspaceInfo = {
      id: olderGoodId,
      path: "/tmp/ws-older-good",
      createdAt: Date.now() - 5000,
      metadata: {},
    };
    const backendWithFind = makeBackend({
      async findByAgentId(_aid: AgentId): Promise<ReadonlyArray<WorkspaceInfo>> {
        // Return newest-first (as the backend contract requires)
        return [newerBad, olderGood];
      },
      isHealthy(wsId: WorkspaceId): boolean {
        return wsId === olderGoodId; // newer is unhealthy
      },
      async verifySetupComplete(_wsId: WorkspaceId): Promise<boolean> {
        return true;
      },
      async invalidateSetupComplete(_wsId: WorkspaceId): Promise<void> {},
    });
    const provider = createWorkspaceProvider({
      backend: backendWithFind,
      cleanupPolicy: "never",
    });
    const result = await provider.attach(makeAgent());
    // Newer bad survivor was disposed
    expect(backendWithFind.disposed).toContain(newerBadId);
    // Older good survivor was reused
    expect(backendWithFind.disposed).not.toContain(olderGoodId);
    expect(backendWithFind.created.length).toBe(0);
    const attachResult2 = isAttachResult(result) ? result : { components: result, skipped: [] };
    const ws = attachResult2.components.get(WORKSPACE as string) as WorkspaceInfo;
    expect(ws.id).toBe(olderGoodId);
  });

  it("attach throws when crash-survivor disposal fails and exists() confirms workspace is present (branch-drift scenario)", async () => {
    // Regression: isHealthy() returns false for branch-drifted workspaces even when the
    // worktree physically exists. The provider must use exists() when available to avoid
    // concluding the workspace is "gone" based on a false-negative health check.
    const survivorId = workspaceId("ws-branch-drifted");
    const survivorInfo: WorkspaceInfo = {
      id: survivorId,
      path: "/tmp/ws-drifted",
      createdAt: Date.now(),
      metadata: {},
    };
    const backendDrifted = makeBackend({
      isSandboxed: false,
      async findByAgentId(_aid: AgentId): Promise<ReadonlyArray<WorkspaceInfo>> {
        return [survivorInfo];
      },
      async dispose(_wsId: WorkspaceId): Promise<Result<void, KoiError>> {
        return {
          ok: false,
          error: { code: "EXTERNAL", message: "removal failed", retryable: false },
        };
      },
      isHealthy(_wsId: WorkspaceId): boolean {
        return false; // unhealthy due to branch drift
      },
      exists(_wsId: WorkspaceId): boolean {
        return true; // worktree is physically present despite branch drift
      },
    });
    const provider = createWorkspaceProvider({
      backend: backendDrifted,
      cleanupPolicy: "always",
      cleanupTimeoutMs: 1,
    });
    const agent = makeAgent();

    // Must throw: workspace exists, cannot create a second one
    await expect(provider.attach(agent)).rejects.toThrow(
      "crash-survivor ws-branch-drifted could not be disposed",
    );
    expect(backendDrifted.created.length).toBe(0);
  });

  it("attach proceeds when crash-survivor disposal fails and exists() confirms workspace is gone", async () => {
    // exists() returns false → workspace is truly gone → safe to create a fresh one
    const survivorId = workspaceId("ws-truly-gone");
    const survivorInfo: WorkspaceInfo = {
      id: survivorId,
      path: "/tmp/ws-truly-gone",
      createdAt: Date.now(),
      metadata: {},
    };
    const backendGone = makeBackend({
      isSandboxed: false,
      async findByAgentId(_aid: AgentId): Promise<ReadonlyArray<WorkspaceInfo>> {
        return [survivorInfo];
      },
      async dispose(_wsId: WorkspaceId): Promise<Result<void, KoiError>> {
        return {
          ok: false,
          error: { code: "EXTERNAL", message: "already gone", retryable: false },
        };
      },
      isHealthy(_wsId: WorkspaceId): boolean {
        return true; // would incorrectly block if used as oracle
      },
      exists(_wsId: WorkspaceId): boolean {
        return false; // workspace is gone — exists() is authoritative
      },
    });
    const provider = createWorkspaceProvider({
      backend: backendGone,
      cleanupPolicy: "always",
      cleanupTimeoutMs: 1,
    });
    const agent = makeAgent();

    // Must NOT throw — exists() confirmed the workspace is gone
    const result = await provider.attach(agent);
    expect(result.components.size).toBe(1);
    expect(backendGone.created.length).toBe(1);
    await provider.detach?.(agent);
  });

  it("cleanupPolicy=never reattach keeps workspace tracked when dispose fails (atomicity)", async () => {
    // Regression: attached.delete was called before tryDispose, leaving the workspace
    // orphaned from provider tracking when disposal timed out. A subsequent attach would
    // see no stale workspace in `attached` and create a duplicate. With the fix, the
    // workspace stays tracked so a later attach can reuse or retry cleanup.
    let healthy = true;
    let disposeFails = false;
    const backend = makeBackend({
      isHealthy(_wsId: WorkspaceId): boolean {
        return healthy;
      },
      async dispose(): Promise<Result<void, KoiError>> {
        if (disposeFails) {
          return {
            ok: false,
            error: { code: "EXTERNAL", message: "dispose timed out", retryable: false },
          };
        }
        return { ok: true, value: undefined };
      },
    });
    const provider = createWorkspaceProvider({ backend, cleanupPolicy: "never" });
    const agent = makeAgent();

    // First attach + detach (workspace preserved by never policy)
    await provider.attach(agent);
    await provider.detach?.(agent);
    expect(backend.created.length).toBe(1);
    expect(backend.disposed.length).toBe(0);

    // Make the workspace unhealthy so reattach tries to dispose it, but disposal fails
    healthy = false;
    disposeFails = true;

    // Reattach: dispose fails — provider must throw and keep the workspace tracked
    await expect(provider.attach(agent)).rejects.toThrow("could not be disposed");

    // Workspace is still tracked — a subsequent reattach sees the same stale workspace.
    // The stale workspace is now healthy again (transient check or workspace recovered),
    // so the provider REUSES it rather than creating a second one. Without the atomicity
    // fix, attached.delete would have cleared tracking and forced a new (duplicate) creation.
    healthy = true;
    disposeFails = false;

    await provider.attach(agent);
    expect(backend.created.length).toBe(1); // reused — no second workspace created
    await provider.detach?.(agent);
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
