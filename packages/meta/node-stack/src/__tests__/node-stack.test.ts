import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { AgentRegistry, ComponentProvider, KoiError, KoiMiddleware, ProcFs } from "@koi/core";
import type { KoiNode } from "@koi/node";

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

const mockNode = {
  mode: "full" as const,
  nodeId: "test-node",
  state: () => "stopped" as const,
  start: mock(() => Promise.resolve()),
  stop: mock(() => Promise.resolve()),
  onEvent: mock(() => () => {}),
  toolResolver: {} as never,
  dispatch: mock(() => Promise.resolve({ ok: true, value: {} }) as never),
  terminate: mock(() => ({ ok: true, value: undefined }) as never),
  getAgent: mock(() => undefined),
  listAgents: mock(() => []),
  capacity: mock(() => ({ total: 10, used: 0, available: 10 }) as never),
  drainInbox: mock(() => []),
  inboxDepth: mock(() => 0),
};

const mockThinNode = {
  mode: "thin" as const,
  nodeId: "test-node",
  state: () => "stopped" as const,
  start: mock(() => Promise.resolve()),
  stop: mock(() => Promise.resolve()),
  onEvent: mock(() => () => {}),
  toolResolver: {} as never,
};

const mockCreateNode = mock(
  ():
    | { readonly ok: true; readonly value: KoiNode }
    | { readonly ok: false; readonly error: KoiError } => ({ ok: true, value: mockNode }),
);

const mockDiscoveryProvider: ComponentProvider = {
  name: "agent-discovery",
  attach: mock(() => Promise.resolve(new Map())),
};
const mockCreateDiscoveryProvider = mock(() => mockDiscoveryProvider);

const mockProcFs: ProcFs = {
  mount: mock(() => {}),
  unmount: mock(() => {}),
  read: mock(() => ""),
  write: mock(() => ({ ok: true, value: undefined }) as never),
  list: mock(() => []),
  entries: mock(() => []),
};
const mockCreateProcFs = mock(() => mockProcFs);

const mockMounterDispose = mock(() => {});
const mockCreateAgentMounter = mock(() => ({
  dispose: mockMounterDispose,
}));

const mockTracingMiddleware: KoiMiddleware = {
  name: "tracing",
  priority: 450,
  describeCapabilities: () => undefined,
};
const mockCreateTracingMiddleware = mock(() => mockTracingMiddleware);

// ---------------------------------------------------------------------------
// Wire mocks
// ---------------------------------------------------------------------------

mock.module("@koi/node", () => ({
  createNode: mockCreateNode,
}));
mock.module("@koi/agent-discovery", () => ({
  createDiscoveryProvider: mockCreateDiscoveryProvider,
}));
mock.module("@koi/agent-procfs", () => ({
  createProcFs: mockCreateProcFs,
  createAgentMounter: mockCreateAgentMounter,
}));
mock.module("@koi/tracing", () => ({
  createTracingMiddleware: mockCreateTracingMiddleware,
}));

// Import after mocking
const { createNodeStack } = await import("../create-node-stack.js");

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createNodeStack", () => {
  beforeEach(() => {
    mockCreateNode.mockReturnValue({ ok: true, value: mockNode });
    mockNode.start.mockClear();
    mockNode.stop.mockClear();
    mockCreateDiscoveryProvider.mockClear();
    mockCreateProcFs.mockClear();
    mockCreateAgentMounter.mockClear();
    mockMounterDispose.mockClear();
    mockCreateTracingMiddleware.mockClear();
  });

  test("minimal config returns NodeStack with undefined optional fields", () => {
    const stack = createNodeStack({ node: {} });

    expect(stack.node).toBe(mockNode);
    expect(stack.discoveryProvider).toBeUndefined();
    expect(stack.tracingMiddleware).toBeUndefined();
    expect(stack.procFs).toBeUndefined();
  });

  test("invalid node config throws", () => {
    const err: KoiError = {
      code: "VALIDATION",
      message: "bad config",
      retryable: false,
      context: {},
    };
    mockCreateNode.mockReturnValue({ ok: false, error: err });

    expect(() => createNodeStack({ node: "bad" })).toThrow("Invalid node config: bad config");
  });

  test("tracing config yields middleware with name 'tracing' and priority 450", () => {
    const stack = createNodeStack({ node: {}, tracing: {} });

    expect(mockCreateTracingMiddleware).toHaveBeenCalledWith({});
    expect(stack.tracingMiddleware).toBe(mockTracingMiddleware);
    expect(stack.tracingMiddleware?.name).toBe("tracing");
    expect(stack.tracingMiddleware?.priority).toBe(450);
  });

  test("discovery config yields discoveryProvider", () => {
    const discoveryConfig = { cacheTtlMs: 5000 };
    const stack = createNodeStack({ node: {}, discovery: discoveryConfig });

    expect(mockCreateDiscoveryProvider).toHaveBeenCalledWith(discoveryConfig);
    expect(stack.discoveryProvider).toBe(mockDiscoveryProvider);
  });

  test("procfs without registry yields procFs but no mounter", async () => {
    const stack = createNodeStack({ node: {}, procfs: {} });

    expect(mockCreateProcFs).toHaveBeenCalledWith({});
    expect(stack.procFs).toBe(mockProcFs);
    expect(mockCreateAgentMounter).not.toHaveBeenCalled();

    // stop() should not crash without mounter
    await stack.stop();
    expect(mockNode.stop).toHaveBeenCalled();
  });

  test("procfs + registry + full mode wires agent mounter", () => {
    const mockRegistry = {} as AgentRegistry;
    createNodeStack({ node: {}, procfs: {} }, { registry: mockRegistry });

    expect(mockCreateAgentMounter).toHaveBeenCalledWith({
      registry: mockRegistry,
      procFs: mockProcFs,
      agentProvider: mockNode.getAgent,
    });
  });

  test("procfs + registry + thin mode skips agent mounter", () => {
    mockCreateNode.mockReturnValue({ ok: true, value: mockThinNode });
    const mockRegistry = {} as AgentRegistry;
    createNodeStack({ node: {}, procfs: {} }, { registry: mockRegistry });

    expect(mockCreateAgentMounter).not.toHaveBeenCalled();
  });

  test("start() delegates to node.start()", async () => {
    const stack = createNodeStack({ node: {} });
    await stack.start();
    expect(mockNode.start).toHaveBeenCalled();
  });

  test("stop() disposes mounter then stops node", async () => {
    const mockRegistry = {} as AgentRegistry;
    const stack = createNodeStack({ node: {}, procfs: {} }, { registry: mockRegistry });

    await stack.stop();

    expect(mockMounterDispose).toHaveBeenCalled();
    expect(mockNode.stop).toHaveBeenCalled();
  });
});
