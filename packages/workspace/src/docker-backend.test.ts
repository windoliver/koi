import { beforeEach, describe, expect, it } from "bun:test";
import type {
  AgentId,
  ResolvedWorkspaceConfig,
  SandboxAdapter,
  SandboxAdapterResult,
  SandboxInstance,
  SandboxProfile,
  WorkspaceBackend,
} from "@koi/core";
import { agentId, workspaceId } from "@koi/core";
import { createDockerWorkspaceBackend, createFilesystemPolicy } from "./docker-backend.js";
import { validateWorkspaceConfig } from "./validate-config.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: ResolvedWorkspaceConfig = {
  cleanupPolicy: "on_success",
  cleanupTimeoutMs: 5_000,
};

const OK_EXEC_RESULT: SandboxAdapterResult = {
  exitCode: 0,
  stdout: "",
  stderr: "",
  durationMs: 1,
  timedOut: false,
  oomKilled: false,
};

function createMockInstance(overrides?: {
  readonly exec?: SandboxInstance["exec"];
  readonly writeFile?: SandboxInstance["writeFile"];
  readonly destroy?: SandboxInstance["destroy"];
}): SandboxInstance & {
  readonly destroyCalls: readonly unknown[];
  readonly writtenFiles: readonly { readonly path: string; readonly content: Uint8Array }[];
  readonly execCalls: readonly { readonly command: string; readonly args: readonly string[] }[];
} {
  // Mutable arrays justified: test-only tracking state, not production code.
  const destroyCalls: unknown[] = [];
  const writtenFiles: { readonly path: string; readonly content: Uint8Array }[] = [];
  const execCalls: { readonly command: string; readonly args: readonly string[] }[] = [];

  return {
    destroyCalls,
    writtenFiles,
    execCalls,
    exec:
      overrides?.exec ??
      (async (command, args) => {
        execCalls.push({ command, args });
        return OK_EXEC_RESULT;
      }),
    readFile: async () => new Uint8Array(0),
    writeFile:
      overrides?.writeFile ??
      (async (path, content) => {
        writtenFiles.push({ path, content });
      }),
    destroy:
      overrides?.destroy ??
      (async () => {
        destroyCalls.push(Date.now());
      }),
  };
}

function createMockAdapter(
  instance?: SandboxInstance,
): SandboxAdapter & { readonly createCalls: readonly SandboxProfile[] } {
  // Mutable array justified: test-only tracking state.
  const createCalls: SandboxProfile[] = [];
  const defaultInstance = instance ?? createMockInstance();

  return {
    name: "mock-docker",
    createCalls,
    create: async (profile: SandboxProfile) => {
      createCalls.push(profile);
      return defaultInstance;
    },
  };
}

const aid: AgentId = agentId("test-agent-1");

// ---------------------------------------------------------------------------
// Factory tests
// ---------------------------------------------------------------------------

describe("createDockerWorkspaceBackend", () => {
  it("returns VALIDATION error when adapter is missing", () => {
    // @ts-expect-error — testing runtime validation of missing adapter
    const result = createDockerWorkspaceBackend({});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("VALIDATION");
    expect(result.error.message).toContain("adapter");
  });

  it("returns ok with valid config", () => {
    const adapter = createMockAdapter();
    const result = createDockerWorkspaceBackend({ adapter });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.name).toBe("docker");
  });

  it("uses default workDir when not specified", async () => {
    const adapter = createMockAdapter();
    const result = createDockerWorkspaceBackend({ adapter });
    if (!result.ok) throw new Error("factory failed");

    const createResult = await result.value.create(aid, DEFAULT_CONFIG);
    expect(createResult.ok).toBe(true);
    if (!createResult.ok) return;
    expect(createResult.value.path).toBe("/workspace");
    expect(createResult.value.metadata.workDir).toBe("/workspace");
  });

  it("uses custom workDir when specified", async () => {
    const adapter = createMockAdapter();
    const result = createDockerWorkspaceBackend({ adapter, workDir: "/custom" });
    if (!result.ok) throw new Error("factory failed");

    const createResult = await result.value.create(aid, DEFAULT_CONFIG);
    expect(createResult.ok).toBe(true);
    if (!createResult.ok) return;
    expect(createResult.value.path).toBe("/custom");
    expect(createResult.value.metadata.workDir).toBe("/custom");
  });
});

// ---------------------------------------------------------------------------
// Backend method tests
// ---------------------------------------------------------------------------

describe("DockerWorkspaceBackend", () => {
  let backend: WorkspaceBackend;
  let mockInstance: ReturnType<typeof createMockInstance>;
  let mockAdapter: ReturnType<typeof createMockAdapter>;

  beforeEach(() => {
    mockInstance = createMockInstance();
    mockAdapter = createMockAdapter(mockInstance);
    const result = createDockerWorkspaceBackend({ adapter: mockAdapter });
    if (!result.ok) throw new Error(`Backend creation failed: ${result.error.message}`);
    backend = result.value;
  });

  // -------------------------------------------------------------------------
  // create
  // -------------------------------------------------------------------------

  describe("create", () => {
    it("returns correct WorkspaceInfo", async () => {
      const result = await backend.create(aid, DEFAULT_CONFIG);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.id).toMatch(/^docker-test-agent-1-\d+$/);
      expect(result.value.path).toBe("/workspace");
      expect(typeof result.value.createdAt).toBe("number");
      expect(result.value.metadata.adapterName).toBe("mock-docker");
    });

    it("writes marker file inside container", async () => {
      const result = await backend.create(aid, DEFAULT_CONFIG);
      if (!result.ok) throw new Error("create failed");

      expect(mockInstance.writtenFiles.length).toBe(1);
      const written = mockInstance.writtenFiles[0];
      if (!written) throw new Error("expected written file");
      expect(written.path).toBe("/workspace/.koi-workspace");

      const marker = JSON.parse(new TextDecoder().decode(written.content));
      expect(marker.agentId).toBe(String(aid));
      expect(marker.workDir).toBe("/workspace");
    });

    it("returns EXTERNAL error when adapter.create throws", async () => {
      const failAdapter: SandboxAdapter = {
        name: "fail-docker",
        create: async () => {
          throw new Error("Docker daemon unavailable");
        },
      };
      const failResult = createDockerWorkspaceBackend({ adapter: failAdapter });
      if (!failResult.ok) throw new Error("factory failed");

      const result = await failResult.value.create(aid, DEFAULT_CONFIG);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("EXTERNAL");
      expect(result.error.retryable).toBe(true);
      expect(result.error.message).toContain("Docker daemon unavailable");
    });

    it("returns EXTERNAL error when marker write fails", async () => {
      const failInstance = createMockInstance({
        writeFile: async () => {
          throw new Error("Read-only filesystem");
        },
      });
      const adapter = createMockAdapter(failInstance);
      const factoryResult = createDockerWorkspaceBackend({ adapter });
      if (!factoryResult.ok) throw new Error("factory failed");

      const result = await factoryResult.value.create(aid, DEFAULT_CONFIG);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("EXTERNAL");
      expect(result.error.message).toContain("marker file");
    });

    it("cleans up container when marker write fails", async () => {
      const failInstance = createMockInstance({
        writeFile: async () => {
          throw new Error("Read-only filesystem");
        },
      });
      const adapter = createMockAdapter(failInstance);
      const factoryResult = createDockerWorkspaceBackend({ adapter });
      if (!factoryResult.ok) throw new Error("factory failed");

      await factoryResult.value.create(aid, DEFAULT_CONFIG);
      expect(failInstance.destroyCalls.length).toBe(1);
    });

    it("defaults to mountMode 'none' (most restrictive)", async () => {
      const adapter = createMockAdapter();
      const factoryResult = createDockerWorkspaceBackend({ adapter });
      if (!factoryResult.ok) throw new Error("factory failed");

      await factoryResult.value.create(aid, DEFAULT_CONFIG);
      const call = adapter.createCalls[0];
      if (!call) throw new Error("expected adapter.create call");
      expect(call.filesystem.allowRead).toEqual([]);
      expect(call.filesystem.allowWrite).toEqual([]);
    });

    it("passes profile overrides to adapter", async () => {
      const adapter = createMockAdapter();
      const factoryResult = createDockerWorkspaceBackend({
        adapter,
        profileOverrides: { network: { allow: true } },
      });
      if (!factoryResult.ok) throw new Error("factory failed");

      await factoryResult.value.create(aid, DEFAULT_CONFIG);
      expect(adapter.createCalls.length).toBe(1);
      const call = adapter.createCalls[0];
      if (!call) throw new Error("expected adapter.create call");
      expect(call.network.allow).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // dispose
  // -------------------------------------------------------------------------

  describe("dispose", () => {
    it("destroys container and returns ok", async () => {
      const createResult = await backend.create(aid, DEFAULT_CONFIG);
      if (!createResult.ok) throw new Error("create failed");

      const disposeResult = await backend.dispose(createResult.value.id);
      expect(disposeResult.ok).toBe(true);
      expect(mockInstance.destroyCalls.length).toBe(1);
    });

    it("returns NOT_FOUND for unknown workspace ID", async () => {
      const result = await backend.dispose(workspaceId("unknown-id"));
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("NOT_FOUND");
    });

    it("returns EXTERNAL error when destroy throws", async () => {
      const failInstance = createMockInstance({
        destroy: async () => {
          throw new Error("Container stuck");
        },
      });
      const adapter = createMockAdapter(failInstance);
      const factoryResult = createDockerWorkspaceBackend({ adapter });
      if (!factoryResult.ok) throw new Error("factory failed");

      const createResult = await factoryResult.value.create(aid, DEFAULT_CONFIG);
      if (!createResult.ok) throw new Error("create failed");

      const result = await factoryResult.value.dispose(createResult.value.id);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("EXTERNAL");
      expect(result.error.retryable).toBe(false);
    });

    it("removes workspace from tracking after dispose", async () => {
      const createResult = await backend.create(aid, DEFAULT_CONFIG);
      if (!createResult.ok) throw new Error("create failed");

      await backend.dispose(createResult.value.id);

      // Second dispose should return NOT_FOUND
      const second = await backend.dispose(createResult.value.id);
      expect(second.ok).toBe(false);
      if (second.ok) return;
      expect(second.error.code).toBe("NOT_FOUND");
    });
  });

  // -------------------------------------------------------------------------
  // isHealthy
  // -------------------------------------------------------------------------

  describe("isHealthy", () => {
    it("returns true when exec probe succeeds", async () => {
      const createResult = await backend.create(aid, DEFAULT_CONFIG);
      if (!createResult.ok) throw new Error("create failed");

      const healthy = await backend.isHealthy(createResult.value.id);
      expect(healthy).toBe(true);
    });

    it("returns false for unknown workspace ID", async () => {
      const healthy = await backend.isHealthy(workspaceId("nonexistent"));
      expect(healthy).toBe(false);
    });

    it("returns false when exec returns non-zero exit code", async () => {
      const unhealthyInstance = createMockInstance({
        exec: async () => ({ ...OK_EXEC_RESULT, exitCode: 1 }),
      });
      const adapter = createMockAdapter(unhealthyInstance);
      const factoryResult = createDockerWorkspaceBackend({ adapter });
      if (!factoryResult.ok) throw new Error("factory failed");

      const createResult = await factoryResult.value.create(aid, DEFAULT_CONFIG);
      if (!createResult.ok) throw new Error("create failed");

      const healthy = await factoryResult.value.isHealthy(createResult.value.id);
      expect(healthy).toBe(false);
    });

    it("returns false when exec throws", async () => {
      const throwInstance = createMockInstance({
        exec: async () => {
          throw new Error("Connection refused");
        },
      });
      const adapter = createMockAdapter(throwInstance);
      const factoryResult = createDockerWorkspaceBackend({ adapter });
      if (!factoryResult.ok) throw new Error("factory failed");

      const createResult = await factoryResult.value.create(aid, DEFAULT_CONFIG);
      if (!createResult.ok) throw new Error("create failed");

      const healthy = await factoryResult.value.isHealthy(createResult.value.id);
      expect(healthy).toBe(false);
    });

    it("returns false after dispose", async () => {
      const createResult = await backend.create(aid, DEFAULT_CONFIG);
      if (!createResult.ok) throw new Error("create failed");

      await backend.dispose(createResult.value.id);
      const healthy = await backend.isHealthy(createResult.value.id);
      expect(healthy).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// MountMode tests
// ---------------------------------------------------------------------------

describe("createFilesystemPolicy", () => {
  it('mountMode "none" sets empty allowRead/allowWrite', () => {
    const policy = createFilesystemPolicy("none", "/workspace");
    expect(policy.allowRead).toEqual([]);
    expect(policy.allowWrite).toEqual([]);
  });

  it('mountMode "ro" sets allowRead only', () => {
    const policy = createFilesystemPolicy("ro", "/workspace");
    expect(policy.allowRead).toEqual(["/workspace"]);
    expect(policy.allowWrite).toEqual([]);
  });

  it('mountMode "rw" matches default behavior', () => {
    const policy = createFilesystemPolicy("rw", "/workspace");
    expect(policy.allowRead).toEqual(["/workspace"]);
    expect(policy.allowWrite).toEqual(["/workspace"]);
  });
});

describe("mountMode config integration", () => {
  it("applies mountMode to the profile passed to adapter", async () => {
    const adapter = createMockAdapter();
    const result = createDockerWorkspaceBackend({ adapter, mountMode: "ro" });
    if (!result.ok) throw new Error("factory failed");

    await result.value.create(aid, DEFAULT_CONFIG);
    expect(adapter.createCalls.length).toBe(1);
    const call = adapter.createCalls[0];
    if (!call) throw new Error("expected adapter.create call");
    expect(call.filesystem.allowRead).toEqual(["/workspace"]);
    expect(call.filesystem.allowWrite).toEqual([]);
  });

  it("profileOverrides.filesystem takes precedence over mountMode", async () => {
    const adapter = createMockAdapter();
    const result = createDockerWorkspaceBackend({
      adapter,
      mountMode: "none",
      profileOverrides: {
        filesystem: { allowRead: ["/custom"], allowWrite: ["/custom"] },
      },
    });
    if (!result.ok) throw new Error("factory failed");

    await result.value.create(aid, DEFAULT_CONFIG);
    const call = adapter.createCalls[0];
    if (!call) throw new Error("expected adapter.create call");
    expect(call.filesystem.allowRead).toEqual(["/custom"]);
    expect(call.filesystem.allowWrite).toEqual(["/custom"]);
  });
});

// ---------------------------------------------------------------------------
// ContainerScope tests
// ---------------------------------------------------------------------------

describe("shared scope", () => {
  it("reuses same container for two agents", async () => {
    const mockInstance = createMockInstance();
    const adapter = createMockAdapter(mockInstance);
    const result = createDockerWorkspaceBackend({ adapter, scope: "shared" });
    if (!result.ok) throw new Error("factory failed");

    const agent1: AgentId = agentId("agent-1");
    const agent2: AgentId = agentId("agent-2");
    await result.value.create(agent1, DEFAULT_CONFIG);
    await result.value.create(agent2, DEFAULT_CONFIG);

    // adapter.create should only be called once for shared scope
    expect(adapter.createCalls.length).toBe(1);
  });

  it("creates unique sub-paths per agent", async () => {
    const mockInstance = createMockInstance();
    const adapter = createMockAdapter(mockInstance);
    const result = createDockerWorkspaceBackend({ adapter, scope: "shared" });
    if (!result.ok) throw new Error("factory failed");

    const agent1: AgentId = agentId("agent-1");
    const agent2: AgentId = agentId("agent-2");
    const r1 = await result.value.create(agent1, DEFAULT_CONFIG);
    const r2 = await result.value.create(agent2, DEFAULT_CONFIG);

    if (!r1.ok || !r2.ok) throw new Error("create failed");
    expect(r1.value.path).toBe("/workspace/agent-1");
    expect(r2.value.path).toBe("/workspace/agent-2");
  });

  it("destroys container when last agent disposes", async () => {
    const mockInstance = createMockInstance();
    const adapter = createMockAdapter(mockInstance);
    const result = createDockerWorkspaceBackend({ adapter, scope: "shared" });
    if (!result.ok) throw new Error("factory failed");

    const agent1: AgentId = agentId("agent-1");
    const agent2: AgentId = agentId("agent-2");
    const r1 = await result.value.create(agent1, DEFAULT_CONFIG);
    const r2 = await result.value.create(agent2, DEFAULT_CONFIG);
    if (!r1.ok || !r2.ok) throw new Error("create failed");

    // First dispose: should NOT destroy
    await result.value.dispose(r1.value.id);
    expect(mockInstance.destroyCalls.length).toBe(0);

    // Second dispose: should destroy
    await result.value.dispose(r2.value.id);
    expect(mockInstance.destroyCalls.length).toBe(1);
  });

  it("isHealthy works for shared scope", async () => {
    const mockInstance = createMockInstance();
    const adapter = createMockAdapter(mockInstance);
    const result = createDockerWorkspaceBackend({ adapter, scope: "shared" });
    if (!result.ok) throw new Error("factory failed");

    const agent1: AgentId = agentId("agent-1");
    const r1 = await result.value.create(agent1, DEFAULT_CONFIG);
    if (!r1.ok) throw new Error("create failed");

    const healthy = await result.value.isHealthy(r1.value.id);
    expect(healthy).toBe(true);
  });

  it("rejects path-traversal agentId", async () => {
    const mockInstance = createMockInstance();
    const adapter = createMockAdapter(mockInstance);
    const result = createDockerWorkspaceBackend({ adapter, scope: "shared" });
    if (!result.ok) throw new Error("factory failed");

    const malicious: AgentId = agentId("../../etc/passwd");
    const r = await result.value.create(malicious, DEFAULT_CONFIG);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("VALIDATION");
    expect(r.error.message).toContain("escape workDir");
  });

  it.each([
    ".ssh",
    ".gnupg",
    ".aws",
    ".azure",
    ".gcloud",
    ".kube",
    ".docker",
    ".env",
    ".netrc",
    ".npmrc",
    ".secret",
    "credentials",
    "id_rsa",
    "id_ed25519",
    "private_key",
  ])("rejects agentId containing blocked segment '%s'", async (segment) => {
    const mockInstance = createMockInstance();
    const adapter = createMockAdapter(mockInstance);
    const result = createDockerWorkspaceBackend({ adapter, scope: "shared" });
    if (!result.ok) throw new Error("factory failed");

    const r = await result.value.create(agentId(`agent-${segment}-x`), DEFAULT_CONFIG);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("VALIDATION");
    expect(r.error.message).toContain("blocked path segment");
    expect(r.error.message).toContain(segment);
  });

  it("allows safe agentId in shared scope", async () => {
    const mockInstance = createMockInstance();
    const adapter = createMockAdapter(mockInstance);
    const result = createDockerWorkspaceBackend({ adapter, scope: "shared" });
    if (!result.ok) throw new Error("factory failed");

    const r = await result.value.create(agentId("safe-agent-42"), DEFAULT_CONFIG);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.path).toBe("/workspace/safe-agent-42");
  });

  it("serializes concurrent creates to single container", async () => {
    const mockInstance = createMockInstance();
    const adapter = createMockAdapter(mockInstance);
    const result = createDockerWorkspaceBackend({ adapter, scope: "shared" });
    if (!result.ok) throw new Error("factory failed");

    const agent1: AgentId = agentId("agent-1");
    const agent2: AgentId = agentId("agent-2");
    const [r1, r2] = await Promise.all([
      result.value.create(agent1, DEFAULT_CONFIG),
      result.value.create(agent2, DEFAULT_CONFIG),
    ]);

    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    // Only one container should be created
    expect(adapter.createCalls.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// requireSandbox tests
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Session scope tests
// ---------------------------------------------------------------------------

describe("session scope", () => {
  it("creates a fresh container for every create call", async () => {
    const mockInstance = createMockInstance();
    const adapter = createMockAdapter(mockInstance);
    const result = createDockerWorkspaceBackend({ adapter, scope: "session" });
    if (!result.ok) throw new Error("factory failed");

    const agent1: AgentId = agentId("agent-1");
    await result.value.create(agent1, DEFAULT_CONFIG);
    await result.value.create(agent1, DEFAULT_CONFIG);

    // Two create calls → two adapter.create calls (no reuse)
    expect(adapter.createCalls.length).toBe(2);
  });

  it("destroys container immediately on dispose", async () => {
    const mockInstance = createMockInstance();
    const adapter = createMockAdapter(mockInstance);
    const result = createDockerWorkspaceBackend({ adapter, scope: "session" });
    if (!result.ok) throw new Error("factory failed");

    const r = await result.value.create(agentId("agent-1"), DEFAULT_CONFIG);
    if (!r.ok) throw new Error("create failed");

    const disposeResult = await result.value.dispose(r.value.id);
    expect(disposeResult.ok).toBe(true);
    expect(mockInstance.destroyCalls.length).toBe(1);
  });

  it("uses workDir directly (not sub-path)", async () => {
    const mockInstance = createMockInstance();
    const adapter = createMockAdapter(mockInstance);
    const result = createDockerWorkspaceBackend({ adapter, scope: "session" });
    if (!result.ok) throw new Error("factory failed");

    const r = await result.value.create(agentId("agent-1"), DEFAULT_CONFIG);
    if (!r.ok) throw new Error("create failed");
    expect(r.value.path).toBe("/workspace");
  });
});

// ---------------------------------------------------------------------------
// requireSandbox tests
// ---------------------------------------------------------------------------

describe("requireSandbox", () => {
  it("passes with sandboxed backend (isSandboxed: true)", () => {
    const adapter = createMockAdapter();
    const backendResult = createDockerWorkspaceBackend({ adapter });
    if (!backendResult.ok) throw new Error("factory failed");

    const result = validateWorkspaceConfig({
      backend: backendResult.value,
      requireSandbox: true,
    });
    expect(result.ok).toBe(true);
  });

  it("fails with non-sandboxed backend (isSandboxed: false)", () => {
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

    const result = validateWorkspaceConfig({
      backend: fakeBackend,
      requireSandbox: true,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("VALIDATION");
    expect(result.error.message).toContain("requireSandbox");
    expect(result.error.message).toContain("container isolation");
  });

  it("defaults to false — allows any backend", () => {
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

    const result = validateWorkspaceConfig({ backend: fakeBackend });
    expect(result.ok).toBe(true);
  });
});
