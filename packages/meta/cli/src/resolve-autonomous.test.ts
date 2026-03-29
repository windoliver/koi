/**
 * Tests for resolveAutonomousOrWarn — verifies autonomous mode resolution
 * including skipped/active/failed paths, Nexus-backed stores, and manifest
 * agent wiring.
 *
 * Uses mock.module() for dynamic import mocking (Bun-native pattern).
 */

import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import type {
  ComponentProvider,
  KoiError,
  KoiMiddleware,
  ManifestAgentEntry,
  Result,
  SpawnFn,
} from "@koi/core";

// ---------------------------------------------------------------------------
// Shared mock factories
// ---------------------------------------------------------------------------

function mockMiddleware(name: string): KoiMiddleware {
  return { name } as unknown as KoiMiddleware;
}

function mockProvider(name: string): ComponentProvider {
  return { name } as unknown as ComponentProvider;
}

const mockDispose = mock(async () => {});

const mockAutonomousAgent = {
  harness: { status: () => ({ state: "idle" }) },
  scheduler: {},
  middleware: () => [mockMiddleware("autonomous-mw")],
  providers: () => [mockProvider("autonomous-prov")],
  dispose: mockDispose,
};

const mockHarness = {
  status: () => ({ state: "idle", metrics: { completedTaskCount: 0, pendingTaskCount: 0 } }),
  pause: mock(async () => ({ ok: true as const, value: undefined })),
};

const mockScheduler = {};

// ---------------------------------------------------------------------------
// Module mocks — intercept dynamic import() calls
// ---------------------------------------------------------------------------

const mockCreateAutonomousAgent = mock(() => mockAutonomousAgent);
const mockCreateCompletionNotifier = mock(() => ({
  onCompleted: mock(async () => {}),
  onFailed: mock(async () => {}),
}));

mock.module("@koi/autonomous", () => ({
  createAutonomousAgent: mockCreateAutonomousAgent,
  createCompletionNotifier: mockCreateCompletionNotifier,
}));

mock.module("@koi/long-running", () => ({
  createLongRunningHarness: mock(() => mockHarness),
}));

mock.module("@koi/harness-scheduler", () => ({
  createHarnessScheduler: mock(() => mockScheduler),
}));

mock.module("@koi/snapshot-chain-store", () => ({
  createInMemorySnapshotChainStore: mock(() => ({
    get: mock(() => undefined),
    set: mock(() => {}),
  })),
  createThreadStore: mock(() => ({})),
}));

mock.module("@koi/errors", () => ({
  withRetry: mock(async (fn: () => Promise<unknown>) => fn()),
}));

const mockCreateNexusSnapshotStore = mock(() => ({ get: mock(() => undefined) }));
const mockCreateNexusSessionStore = mock(() => ({
  saveSession: mock(() => ({ ok: true, value: undefined })),
  close: mock(() => {}),
}));
const mockCreateNexusRegistry = mock(async () => ({
  [Symbol.asyncDispose]: mock(async () => {}),
}));

mock.module("@koi/nexus-store", () => ({
  createNexusSnapshotStore: mockCreateNexusSnapshotStore,
  createNexusSessionStore: mockCreateNexusSessionStore,
}));

mock.module("@koi/registry-nexus", () => ({
  createNexusRegistry: mockCreateNexusRegistry,
}));

const mockValidateManifestAgents = mock(
  (): Result<void, KoiError> => ({ ok: true, value: undefined }),
);
const mockCreateAdapterSpawnFn = mock((_adapter: unknown): SpawnFn => {
  return async () => ({ ok: true as const, output: "mock" });
});

mock.module("@koi/agent-spawner", () => ({
  validateManifestAgents: mockValidateManifestAgents,
  createAdapterSpawnFn: mockCreateAdapterSpawnFn,
}));

mock.module("@koi/engine-acp", () => ({
  createAcpAdapter: mock(() => ({
    stream: async function* () {
      /* noop */
    },
    dispose: mock(async () => {}),
  })),
}));

mock.module("@koi/engine-external", () => ({
  createExternalAdapter: mock(() => ({
    stream: async function* () {
      /* noop */
    },
    dispose: mock(async () => {}),
  })),
}));

// Import after mocks are registered
const { resolveAutonomousOrWarn } = await import("./resolve-autonomous.js");

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

let stderrSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  stderrSpy = spyOn(process.stderr, "write").mockReturnValue(true);
  mockDispose.mockClear();
  mockCreateAutonomousAgent.mockClear();
  mockCreateCompletionNotifier.mockClear();
  mockCreateNexusSnapshotStore.mockClear();
  mockCreateNexusSessionStore.mockClear();
  mockCreateNexusRegistry.mockClear();
  mockValidateManifestAgents.mockClear();
  mockCreateAdapterSpawnFn.mockClear();
});

afterEach(() => {
  stderrSpy.mockRestore();
});

// ---------------------------------------------------------------------------
// resolveAutonomousOrWarn
// ---------------------------------------------------------------------------

describe("resolveAutonomousOrWarn", () => {
  test("returns skipped when autonomous.enabled not set", async () => {
    const { result, contribution } = await resolveAutonomousOrWarn({ name: "test" });

    expect(result).toBeUndefined();
    expect(contribution.status).toBe("skipped");
    expect(contribution.enabled).toBe(false);
    expect(contribution.reason).toBe("autonomous.enabled not set");
  });

  test("returns skipped when autonomous is not an object", async () => {
    const { result, contribution } = await resolveAutonomousOrWarn({
      name: "test",
      autonomous: "true",
    });

    expect(result).toBeUndefined();
    expect(contribution.status).toBe("skipped");
    expect(contribution.enabled).toBe(false);
  });

  test("returns active with in-memory stores when no nexus", async () => {
    const { result, contribution } = await resolveAutonomousOrWarn({
      name: "test",
      autonomous: { enabled: true },
    });

    expect(result).toBeDefined();
    expect(result?.middleware).toBeDefined();
    expect(result?.providers).toBeDefined();
    expect(typeof result?.dispose).toBe("function");
    expect(contribution.status).toBe("active");
    expect(contribution.enabled).toBe(true);
  });

  test("returns failed when initialization throws", async () => {
    // Temporarily override the autonomous mock to throw
    mockCreateAutonomousAgent.mockImplementationOnce(() => {
      throw new Error("init boom");
    });

    const { result, contribution } = await resolveAutonomousOrWarn({
      name: "test",
      autonomous: { enabled: true },
    });

    expect(result).toBeUndefined();
    expect(contribution.status).toBe("failed");
    expect(contribution.reason).toBe("init boom");
  });

  test("dispose cleans up session persistence", async () => {
    const { result } = await resolveAutonomousOrWarn({
      name: "test",
      autonomous: { enabled: true },
    });

    expect(result).toBeDefined();
    // dispose should not throw
    await expect(result?.dispose()).resolves.toBeUndefined();
  });

  test("bindSpawn sets spawn function", async () => {
    const { result } = await resolveAutonomousOrWarn({
      name: "test",
      autonomous: { enabled: true },
    });

    expect(result).toBeDefined();

    const mockSpawn: SpawnFn = async () => ({
      ok: true as const,
      output: "spawned",
    });

    // bindSpawn should not throw
    result?.bindSpawn(mockSpawn);

    // Verify the getSpawn callback was wired — autonomous agent factory
    // receives getSpawn, so the bound spawn is accessible through it
    expect(mockCreateAutonomousAgent).toHaveBeenCalled();
    const calls = mockCreateAutonomousAgent.mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    const callArgs = calls[calls.length - 1] as unknown as [
      { readonly getSpawn: () => SpawnFn | undefined },
    ];
    expect(typeof callArgs[0].getSpawn).toBe("function");
  });

  test("contribution includes middleware and provider packages", async () => {
    const { contribution } = await resolveAutonomousOrWarn({
      name: "test",
      autonomous: { enabled: true },
    });

    expect(contribution.status).toBe("active");
    const packageIds = contribution.packages.map((p) => p.id);
    expect(packageIds).toContain("@koi/autonomous");
    expect(packageIds).toContain("@koi/long-running");
    expect(packageIds).toContain("@koi/harness-scheduler");
    expect(packageIds).toContain("@koi/snapshot-chain-store");
  });
});

// ---------------------------------------------------------------------------
// Nexus-backed stores
// ---------------------------------------------------------------------------

describe("Nexus-backed stores", () => {
  const nexusConfig = { baseUrl: "http://localhost:2026", apiKey: "test-key" } as const;

  test("uses Nexus stores when nexus config provided", async () => {
    const { result, contribution } = await resolveAutonomousOrWarn(
      { name: "test", autonomous: { enabled: true } },
      false,
      nexusConfig,
    );

    expect(result).toBeDefined();
    expect(contribution.status).toBe("active");
    expect(mockCreateNexusSnapshotStore).toHaveBeenCalled();
    expect(mockCreateNexusSessionStore).toHaveBeenCalled();
    expect(mockCreateNexusRegistry).toHaveBeenCalled();
  });

  test("falls back with error when Nexus unreachable", async () => {
    mockCreateNexusSnapshotStore.mockImplementationOnce(() => {
      throw new Error("connection refused");
    });

    const { result, contribution } = await resolveAutonomousOrWarn(
      { name: "test", autonomous: { enabled: true } },
      false,
      nexusConfig,
    );

    expect(result).toBeUndefined();
    expect(contribution.status).toBe("failed");
    expect(contribution.reason).toContain("connection refused");
  });

  test("contribution includes Nexus packages when active", async () => {
    const { contribution } = await resolveAutonomousOrWarn(
      { name: "test", autonomous: { enabled: true } },
      false,
      nexusConfig,
    );

    expect(contribution.status).toBe("active");
    const packageIds = contribution.packages.map((p) => p.id);
    expect(packageIds).toContain("@koi/nexus-store");
    expect(packageIds).toContain("@koi/registry-nexus");
  });
});

// ---------------------------------------------------------------------------
// Manifest agents
// ---------------------------------------------------------------------------

describe("manifest agents", () => {
  const validAgent: ManifestAgentEntry = {
    name: "worker",
    transport: "cli",
    command: "claude",
    protocol: "acp",
    capabilities: ["code"],
  };

  test("validates manifest agents at startup", async () => {
    mockValidateManifestAgents.mockReturnValueOnce({
      ok: false as const,
      error: {
        code: "VALIDATION" as const,
        message: "Agent 'bad': CLI agent missing command",
        retryable: false as const,
      },
    });

    const invalidAgent: ManifestAgentEntry = {
      name: "bad",
      transport: "cli",
      // no command — triggers validation warning
    };

    const { result, contribution } = await resolveAutonomousOrWarn({
      name: "test",
      autonomous: { enabled: true },
      agents: [invalidAgent],
    });

    // Should still succeed — validation warning, not a crash
    expect(result).toBeDefined();
    expect(contribution.status).toBe("active");
    // Verify the warning was logged
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("[autonomous] warn:"));
  });

  test("builds namedSpawns from valid manifest agents", async () => {
    mockValidateManifestAgents.mockReturnValueOnce({
      ok: true,
      value: undefined,
    });

    const { result, contribution } = await resolveAutonomousOrWarn({
      name: "test",
      autonomous: { enabled: true },
      agents: [validAgent],
    });

    expect(result).toBeDefined();
    expect(contribution.status).toBe("active");
    // Adapter spawn should have been created for the valid agent
    expect(mockCreateAdapterSpawnFn).toHaveBeenCalled();

    // contribution should include agent-spawner package
    const packageIds = contribution.packages.map((p) => p.id);
    expect(packageIds).toContain("@koi/agent-spawner");
  });
});
