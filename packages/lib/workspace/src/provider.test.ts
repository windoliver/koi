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
    isSandboxed: false,
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

  it("provider.name is set", () => {
    const provider = createWorkspaceProvider({ backend });
    expect(provider.name).toBe("workspace");
  });
});
