/**
 * Tests for createAgentDispatcher.
 *
 * Uses mock modules to avoid loading real agent resolution / engine dependencies.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { agentId } from "@koi/core";
import type { AgentDispatcherResult } from "./agent-dispatcher.js";

// ---------------------------------------------------------------------------
// Mock dependencies
// ---------------------------------------------------------------------------

const TEST_AGENT_ID = agentId("test-dispatched-001");
const mockDispose = mock(async () => {});
const mockRun = mock(function* () {
  yield { kind: "done" as const, output: { text: "ok", metrics: { turns: 1, totalTokens: 100 } } };
});

type ManifestResult =
  | {
      readonly ok: true;
      readonly value: {
        readonly manifest: {
          readonly name: string;
          readonly version: string;
          readonly model: { readonly name: string };
        };
        readonly warnings: readonly never[];
      };
    }
  | {
      readonly ok: false;
      readonly error: {
        readonly code: string;
        readonly message: string;
        readonly retryable: boolean;
      };
    };

const mockLoadManifest = mock(
  async (_path: string): Promise<ManifestResult> => ({
    ok: true,
    value: {
      manifest: {
        name: "test-agent",
        version: "0.1.0",
        model: { name: "anthropic:test" },
      },
      warnings: [],
    },
  }),
);

type ResolveResult =
  | {
      readonly ok: true;
      readonly value: {
        readonly middleware: readonly never[];
        readonly engine: undefined;
        readonly model: undefined;
        readonly channels: undefined;
      };
    }
  | {
      readonly ok: false;
      readonly error: {
        readonly code: string;
        readonly message: string;
        readonly retryable: boolean;
      };
    };

const mockResolveAgent = mock(
  async (_opts: unknown): Promise<ResolveResult> => ({
    ok: true,
    value: {
      middleware: [],
      engine: undefined,
      model: undefined,
      channels: undefined,
    },
  }),
);

const mockCreatePiAdapter = mock((_opts: unknown) => ({
  stream: mock(() => (async function* () {})()),
}));

const mockCreateForgeConfiguredKoi = mock(async (_opts: unknown) => ({
  runtime: {
    agent: { pid: { id: TEST_AGENT_ID } },
    run: mockRun,
    dispose: mockDispose,
    conflicts: [],
  },
  forgeSystem: undefined,
  dispose: () => {},
}));

mock.module("@koi/manifest", () => ({
  loadManifest: mockLoadManifest,
}));

mock.module("./resolve-agent.js", () => ({
  resolveAgent: mockResolveAgent,
}));

mock.module("@koi/engine-pi", () => ({
  createPiAdapter: mockCreatePiAdapter,
}));

mock.module("@koi/forge", () => ({
  createForgeConfiguredKoi: mockCreateForgeConfiguredKoi,
}));

// Import AFTER mocks are installed
const { createAgentDispatcher } = await import("./agent-dispatcher.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createDispatcher(
  overrides?: Partial<{ readonly defaultManifestPath: string; readonly verbose: boolean }>,
): AgentDispatcherResult {
  return createAgentDispatcher({
    defaultManifestPath: "/tmp/koi.yaml",
    ...overrides,
  });
}

afterEach(() => {
  mockLoadManifest.mockClear();
  mockResolveAgent.mockClear();
  mockCreatePiAdapter.mockClear();
  mockCreateForgeConfiguredKoi.mockClear();
  mockDispose.mockClear();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createAgentDispatcher", () => {
  test("dispatchAgent returns ok with agentId and name", async () => {
    const { dispatchAgent } = createDispatcher();
    const result = await dispatchAgent({ name: "my-agent" });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.agentId).toBe(TEST_AGENT_ID);
      expect(result.value.name).toBe("my-agent");
    }
  });

  test("dispatchAgent uses default manifest when not specified", async () => {
    const { dispatchAgent } = createDispatcher({ defaultManifestPath: "/default/koi.yaml" });
    await dispatchAgent({ name: "agent-1" });

    expect(mockLoadManifest).toHaveBeenCalledWith("/default/koi.yaml");
  });

  test("dispatchAgent uses request manifest when specified", async () => {
    const { dispatchAgent } = createDispatcher();
    await dispatchAgent({ name: "agent-1", manifest: "/custom/koi.yaml" });

    expect(mockLoadManifest).toHaveBeenCalledWith("/custom/koi.yaml");
  });

  test("dispatchAgent tracks dispatched agent in registry", async () => {
    const dispatcher = createDispatcher();
    await dispatcher.dispatchAgent({ name: "tracked" });

    expect(dispatcher.dispatched.size).toBe(1);
    const entry = dispatcher.dispatched.get(TEST_AGENT_ID);
    expect(entry?.name).toBe("tracked");
    expect(entry?.agentId).toBe(TEST_AGENT_ID);
  });

  test("dispatchAgent returns error when manifest fails to load", async () => {
    mockLoadManifest.mockImplementationOnce(async () => ({
      ok: false as const,
      error: { code: "NOT_FOUND", message: "File not found", retryable: false },
    }));

    const { dispatchAgent } = createDispatcher();
    const result = await dispatchAgent({ name: "bad" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NOT_FOUND");
    }
  });

  test("dispatchAgent returns error when resolution fails", async () => {
    mockResolveAgent.mockImplementationOnce(async () => ({
      ok: false as const,
      error: { code: "INTERNAL", message: "Missing API key", retryable: false },
    }));

    const { dispatchAgent } = createDispatcher();
    const result = await dispatchAgent({ name: "bad" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INTERNAL");
    }
  });

  test("dispose cleans up all dispatched agents", async () => {
    const dispatcher = createDispatcher();
    await dispatcher.dispatchAgent({ name: "agent-1" });

    expect(dispatcher.dispatched.size).toBe(1);

    await dispatcher.dispose();

    expect(dispatcher.dispatched.size).toBe(0);
    expect(mockDispose).toHaveBeenCalledTimes(1);
  });

  test("dispatchAgent catches unexpected errors", async () => {
    mockLoadManifest.mockImplementationOnce(async () => {
      throw new Error("Unexpected boom");
    });

    const { dispatchAgent } = createDispatcher();
    const result = await dispatchAgent({ name: "boom" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INTERNAL");
      expect(result.error.message).toBe("Unexpected boom");
    }
  });
});
