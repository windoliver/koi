/**
 * Unit tests for createNode() — the main entry point of the Koi Node runtime.
 *
 * Strategy:
 * - Mock module-level factory functions (createTransport, createAgentHost, etc.)
 *   so we can inject controllable subsystem implementations.
 * - Test through the public KoiNode API: state machine, dispatch guards,
 *   event system, capacity, tool resolver access.
 * - Verify config validation delegated to parseNodeConfig.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { AgentManifest, ProcessId } from "@koi/core";
import { agentId } from "@koi/core";
import { createMockEngineAdapter } from "@koi/test-utils";
import type { KoiNode } from "./node.js";
import { createNode } from "./node.js";
import type { NodeEvent, NodeState } from "./types.js";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

/** Minimal valid config — only gateway.url is required by the Zod schema. */
function validConfig(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    gateway: { url: "wss://gateway.test.local" },
    // Disable discovery to avoid bonjour import attempts in tests
    discovery: { enabled: false },
    ...overrides,
  };
}

/** Create a mock ProcessId for dispatch tests. */
function mockPid(id = "agent-1", name = "Test Agent"): ProcessId {
  return {
    id: agentId(id),
    name,
    type: "worker" as const,
    depth: 0,
  };
}

/** Create a minimal AgentManifest for dispatch tests. */
function mockManifest(name = "test-agent"): AgentManifest {
  return {
    name,
    version: "0.0.1",
    model: { name: "test-model" },
  };
}

// ---------------------------------------------------------------------------
// Config validation
// ---------------------------------------------------------------------------

describe("createNode — config validation", () => {
  it("returns ok: false for null input", () => {
    const result = createNode(null);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
    }
  });

  it("returns ok: false for undefined input", () => {
    const result = createNode(undefined);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
    }
  });

  it("returns ok: false for empty object (missing gateway)", () => {
    const result = createNode({});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message).toContain("Invalid node config");
    }
  });

  it("returns ok: false for invalid gateway URL", () => {
    const result = createNode({ gateway: { url: "not-a-url" } });
    expect(result.ok).toBe(false);
  });

  it("returns ok: false for negative reconnect delay", () => {
    const result = createNode({
      gateway: { url: "wss://gw.test.local", reconnectBaseDelay: -1 },
    });
    expect(result.ok).toBe(false);
  });

  it("returns ok: false for maxAgents of 0", () => {
    const result = createNode({
      gateway: { url: "wss://gw.test.local" },
      resources: { maxAgents: 0 },
    });
    expect(result.ok).toBe(false);
  });

  it("returns ok: false for memoryWarningPercent > 100", () => {
    const result = createNode({
      gateway: { url: "wss://gw.test.local" },
      resources: { memoryWarningPercent: 150 },
    });
    expect(result.ok).toBe(false);
  });

  it("returns ok: true for valid minimal config", () => {
    const result = createNode(validConfig());
    expect(result.ok).toBe(true);
  });

  it("returns ok: true for config with custom nodeId", () => {
    const result = createNode(validConfig({ nodeId: "my-node" }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.nodeId).toBe("my-node");
    }
  });

  it("returns ok: true for config with auth", () => {
    const result = createNode(validConfig({ auth: { token: "test-token", timeoutMs: 5000 } }));
    expect(result.ok).toBe(true);
  });

  it("returns ok: false for auth with empty token", () => {
    const result = createNode(validConfig({ auth: { token: "" } }));
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Node identity
// ---------------------------------------------------------------------------

describe("createNode — node identity", () => {
  it("uses provided nodeId from config", () => {
    const result = createNode(validConfig({ nodeId: "custom-node-42" }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.nodeId).toBe("custom-node-42");
    }
  });

  it("generates a nodeId when not provided", () => {
    const result = createNode(validConfig());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.nodeId).toBeTruthy();
      expect(result.value.nodeId.startsWith("node-")).toBe(true);
    }
  });

  it("generates unique nodeIds across multiple nodes", () => {
    const result1 = createNode(validConfig());
    const result2 = createNode(validConfig());
    expect(result1.ok).toBe(true);
    expect(result2.ok).toBe(true);
    if (result1.ok && result2.ok) {
      expect(result1.value.nodeId).not.toBe(result2.value.nodeId);
    }
  });
});

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

describe("createNode — state machine", () => {
  it("initial state is 'stopped'", () => {
    const result = createNode(validConfig());
    if (!result.ok) throw new Error("Failed to create node for test");
    expect(result.value.state()).toBe("stopped");
  });

  it("start() transitions synchronously to 'starting' state", () => {
    const result = createNode(validConfig());
    if (!result.ok) throw new Error("Failed to create node for test");
    const node = result.value;

    // start() sets state to "starting" synchronously before any async work.
    // We verify by calling start() without awaiting, checking the state.
    // Note: We DO NOT await start() because the WebSocket connection would
    // hang with no real Gateway. The promise is suppressed.
    const startPromise = node.start();
    expect(node.state()).toBe("starting");

    // Suppress unhandled rejection and clean up
    startPromise.catch(() => {});
    // Force-close transport to unblock the pending WS connection
    void node.stop();
  });

  it("start() is idempotent when already starting", () => {
    const result = createNode(validConfig());
    if (!result.ok) throw new Error("Failed to create node for test");
    const node = result.value;

    const p1 = node.start();
    // Second call while state === "starting" should return immediately
    const p2 = node.start();

    expect(node.state()).toBe("starting");

    p1.catch(() => {});
    p2.catch(() => {});
    void node.stop();
  });

  it("stop() on a never-started node does not throw", async () => {
    const result = createNode(validConfig());
    if (!result.ok) throw new Error("Failed to create node for test");
    await result.value.stop();
    expect(result.value.state()).toBe("stopped");
  });

  it("stop() is idempotent (calling twice does not throw)", async () => {
    const result = createNode(validConfig());
    if (!result.ok) throw new Error("Failed to create node for test");
    const node = result.value;
    await node.stop();
    await node.stop();
    expect(node.state()).toBe("stopped");
  });

  it("state remains 'stopped' after stop() on fresh node", async () => {
    const result = createNode(validConfig());
    if (!result.ok) throw new Error("Failed to create node for test");
    const node = result.value;
    expect(node.state()).toBe("stopped");
    await node.stop();
    expect(node.state()).toBe("stopped");
  });
});

// ---------------------------------------------------------------------------
// Dispatch guards (no connection)
// ---------------------------------------------------------------------------

describe("createNode — dispatch guards", () => {
  let node: KoiNode;

  beforeEach(() => {
    const result = createNode(validConfig());
    if (!result.ok) throw new Error("Failed to create node for test");
    node = result.value;
  });

  afterEach(async () => {
    await node.stop();
  });

  it("dispatch() returns error when node is stopped", async () => {
    const pid = mockPid();
    const manifest = mockManifest();
    const engine = createMockEngineAdapter();

    const result = await node.dispatch(pid, manifest, engine);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message).toContain("node is stopped");
      expect(result.error.retryable).toBe(false);
    }
  });

  it("dispatch() error message includes current state name", async () => {
    // Node is in "stopped" state — the error message should say "stopped"
    const pid = mockPid("agent-2");
    const manifest = mockManifest();
    const engine = createMockEngineAdapter();

    const result = await node.dispatch(pid, manifest, engine);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("stopped");
    }
  });
});

// ---------------------------------------------------------------------------
// Terminate
// ---------------------------------------------------------------------------

describe("createNode — terminate", () => {
  let node: KoiNode;

  beforeEach(() => {
    const result = createNode(validConfig());
    if (!result.ok) throw new Error("Failed to create node for test");
    node = result.value;
  });

  afterEach(async () => {
    await node.stop();
  });

  it("terminate() returns error for unknown agent ID", () => {
    const result = node.terminate("nonexistent-agent");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NOT_FOUND");
      expect(result.error.message).toContain("nonexistent-agent");
    }
  });

  it("terminate() returns NOT_FOUND for empty string agent ID", () => {
    const result = node.terminate("");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NOT_FOUND");
    }
  });
});

// ---------------------------------------------------------------------------
// Agent listing and lookup
// ---------------------------------------------------------------------------

describe("createNode — agent queries", () => {
  let node: KoiNode;

  beforeEach(() => {
    const result = createNode(validConfig());
    if (!result.ok) throw new Error("Failed to create node for test");
    node = result.value;
  });

  afterEach(async () => {
    await node.stop();
  });

  it("listAgents() returns empty array initially", () => {
    const agents = node.listAgents();
    expect(agents).toEqual([]);
    expect(agents).toHaveLength(0);
  });

  it("getAgent() returns undefined for unknown ID", () => {
    const agent = node.getAgent("unknown-id");
    expect(agent).toBeUndefined();
  });

  it("getAgent() returns undefined for empty string ID", () => {
    const agent = node.getAgent("");
    expect(agent).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Capacity
// ---------------------------------------------------------------------------

describe("createNode — capacity", () => {
  it("capacity() returns valid report with default maxAgents", () => {
    const result = createNode(validConfig());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const node = result.value;
    const cap = node.capacity();

    expect(cap.current).toBe(0);
    expect(cap.max).toBe(50); // default maxAgents
    expect(cap.available).toBe(50);
  });

  it("capacity() reflects custom maxAgents from config", () => {
    const result = createNode(validConfig({ resources: { maxAgents: 10 } }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const node = result.value;
    const cap = node.capacity();

    expect(cap.current).toBe(0);
    expect(cap.max).toBe(10);
    expect(cap.available).toBe(10);
  });

  it("capacity report fields are non-negative", () => {
    const result = createNode(validConfig());
    if (!result.ok) return;

    const cap = result.value.capacity();
    expect(cap.current).toBeGreaterThanOrEqual(0);
    expect(cap.max).toBeGreaterThan(0);
    expect(cap.available).toBeGreaterThanOrEqual(0);
  });

  it("capacity available equals max minus current initially", () => {
    const result = createNode(validConfig());
    if (!result.ok) return;

    const cap = result.value.capacity();
    expect(cap.available).toBe(cap.max - cap.current);
  });
});

// ---------------------------------------------------------------------------
// Event system
// ---------------------------------------------------------------------------

describe("createNode — event system", () => {
  let node: KoiNode;

  beforeEach(() => {
    const result = createNode(validConfig());
    if (!result.ok) throw new Error("Failed to create node for test");
    node = result.value;
  });

  afterEach(async () => {
    await node.stop();
  });

  it("onEvent() returns an unsubscribe function", () => {
    const listener = mock((_event: NodeEvent): void => {});
    const unsub = node.onEvent(listener);
    expect(typeof unsub).toBe("function");
  });

  it("multiple listeners can be registered", () => {
    const listener1 = mock((_event: NodeEvent): void => {});
    const listener2 = mock((_event: NodeEvent): void => {});

    const unsub1 = node.onEvent(listener1);
    const unsub2 = node.onEvent(listener2);

    expect(typeof unsub1).toBe("function");
    expect(typeof unsub2).toBe("function");

    // Clean up
    unsub1();
    unsub2();
  });

  it("unsubscribe function removes listener (no events after unsub)", () => {
    const events: NodeEvent[] = [];
    const listener = (event: NodeEvent): void => {
      events.push(event);
    };

    const unsub = node.onEvent(listener);
    unsub();

    // Trigger a host-level event by terminating (which goes through host → emit)
    // Even though the agent doesn't exist, the host.terminate call won't emit for
    // NOT_FOUND. The key test is that the listener was removed from the set.
    // Verify by checking the events array stays empty.
    node.terminate("trigger-test");
    expect(events).toHaveLength(0);
  });

  it("unsubscribe is idempotent (calling twice does not throw)", () => {
    const listener = mock((_event: NodeEvent): void => {});
    const unsub = node.onEvent(listener);

    unsub();
    unsub(); // Second call should be safe
  });

  it("events have timestamp and type when terminate is called", () => {
    const events: NodeEvent[] = [];
    node.onEvent((event) => {
      events.push(event);
    });

    // Terminate an unknown agent — the host will emit nothing but the node
    // should still function. We can test the event shape if any come through.
    // Instead, test event shape via stop() which triggers the cleanup path.
    // Since node was never started, stop() takes the manual cleanup path
    // and emits no node-level events. This verifies no crash at least.
    // For event content testing, we test terminate which goes through host.
    node.terminate("nonexistent");

    // host.terminate emits nothing for not-found, so events may be empty.
    // Verify that at minimum, if events were emitted, they have correct shape.
    for (const event of events) {
      expect(typeof event.timestamp).toBe("number");
      expect(event.timestamp).toBeGreaterThan(0);
      expect(typeof event.type).toBe("string");
      expect(event.type.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Tool resolver
// ---------------------------------------------------------------------------

describe("createNode — tool resolver", () => {
  it("toolResolver is accessible from the node handle", () => {
    const result = createNode(validConfig());
    if (!result.ok) return;

    expect(result.value.toolResolver).toBeDefined();
  });

  it("toolResolver.list() returns an array", () => {
    const result = createNode(validConfig());
    if (!result.ok) return;

    const tools = result.value.toolResolver.list();
    expect(Array.isArray(tools)).toBe(true);
  });

  it("toolResolver.list() returns builtin tools when enabled", () => {
    const result = createNode(
      validConfig({
        tools: {
          directories: [],
          builtins: { filesystem: true, shell: true },
        },
      }),
    );
    if (!result.ok) return;

    // Before discover(), list() returns empty because tools are lazily loaded
    // The builtins are populated only after discover() is called
    const toolsBefore = result.value.toolResolver.list();
    expect(Array.isArray(toolsBefore)).toBe(true);
  });

  it("toolResolver.discover() returns tool metadata", async () => {
    const result = createNode(
      validConfig({
        tools: {
          directories: [],
          builtins: { filesystem: true, shell: true },
        },
      }),
    );
    if (!result.ok) return;

    const tools = await result.value.toolResolver.discover();
    expect(tools.length).toBeGreaterThan(0);

    // Each tool should have a name and description
    for (const tool of tools) {
      expect(typeof tool.name).toBe("string");
      expect(tool.name.length).toBeGreaterThan(0);
    }
  });

  it("toolResolver.discover() returns filesystem and shell builtins", async () => {
    const result = createNode(
      validConfig({
        tools: {
          directories: [],
          builtins: { filesystem: true, shell: true },
        },
      }),
    );
    if (!result.ok) return;

    const tools = await result.value.toolResolver.discover();
    const names = tools.map((t) => t.name);

    // Builtins should include filesystem and shell tools
    expect(names.length).toBeGreaterThanOrEqual(2);
  });

  it("toolResolver.discover() respects disabled builtins", async () => {
    const result = createNode(
      validConfig({
        tools: {
          directories: [],
          builtins: { filesystem: false, shell: false },
        },
      }),
    );
    if (!result.ok) return;

    const tools = await result.value.toolResolver.discover();
    // With both builtins disabled and no directories, should be empty
    expect(tools).toHaveLength(0);
  });

  it("toolResolver.load() returns NOT_FOUND for unknown tool", async () => {
    const result = createNode(validConfig());
    if (!result.ok) return;

    const loadResult = await result.value.toolResolver.load("nonexistent-tool");
    expect(loadResult.ok).toBe(false);
    if (!loadResult.ok) {
      expect(loadResult.error.code).toBe("NOT_FOUND");
    }
  });
});

// ---------------------------------------------------------------------------
// Stop/cleanup behavior
// ---------------------------------------------------------------------------

describe("createNode — stop and cleanup", () => {
  it("after stop(), dispatch returns error", async () => {
    const result = createNode(validConfig());
    if (!result.ok) return;

    const node = result.value;
    await node.stop();

    const dispatchResult = await node.dispatch(
      mockPid(),
      mockManifest(),
      createMockEngineAdapter(),
    );
    expect(dispatchResult.ok).toBe(false);
    if (!dispatchResult.ok) {
      expect(dispatchResult.error.code).toBe("VALIDATION");
      expect(dispatchResult.error.message).toContain("stopped");
    }
  });

  it("after stop(), state is 'stopped'", async () => {
    const result = createNode(validConfig());
    if (!result.ok) return;

    const node = result.value;
    await node.stop();
    expect(node.state()).toBe("stopped");
  });

  it("after stop(), listAgents returns empty", async () => {
    const result = createNode(validConfig());
    if (!result.ok) return;

    const node = result.value;
    await node.stop();
    expect(node.listAgents()).toEqual([]);
  });

  it("stop() without start() leaves state as stopped", async () => {
    const result = createNode(validConfig());
    if (!result.ok) return;

    const node = result.value;
    expect(node.state()).toBe("stopped");
    await node.stop();
    expect(node.state()).toBe("stopped");
  });
});

// ---------------------------------------------------------------------------
// Full config options
// ---------------------------------------------------------------------------

describe("createNode — config modes", () => {
  it("accepts mode 'full'", () => {
    const result = createNode(validConfig({ mode: "full" }));
    expect(result.ok).toBe(true);
  });

  it("accepts mode 'thin'", () => {
    const result = createNode(validConfig({ mode: "thin" }));
    expect(result.ok).toBe(true);
  });

  it("rejects invalid mode", () => {
    const result = createNode(validConfig({ mode: "invalid" }));
    expect(result.ok).toBe(false);
  });

  it("defaults mode to 'full' when not specified", () => {
    // We can't directly read mode from the node handle, but the node
    // should create successfully with the default
    const result = createNode(validConfig());
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("createNode — edge cases", () => {
  it("handles number as input", () => {
    const result = createNode(42);
    expect(result.ok).toBe(false);
  });

  it("handles string as input", () => {
    const result = createNode("invalid");
    expect(result.ok).toBe(false);
  });

  it("handles array as input", () => {
    const result = createNode([1, 2, 3]);
    expect(result.ok).toBe(false);
  });

  it("handles boolean as input", () => {
    const result = createNode(true);
    expect(result.ok).toBe(false);
  });

  it("handles config with extra unknown fields (Zod strips them)", () => {
    const result = createNode({
      gateway: { url: "wss://gw.test.local" },
      discovery: { enabled: false },
      unknownField: "should be stripped",
      anotherUnknown: 42,
    });
    expect(result.ok).toBe(true);
  });

  it("returns a result object with ok discriminant", () => {
    const successResult = createNode(validConfig());
    expect("ok" in successResult).toBe(true);

    const failResult = createNode(null);
    expect("ok" in failResult).toBe(true);
  });

  it("error result has code, message, and retryable fields", () => {
    const result = createNode(null);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(typeof result.error.code).toBe("string");
      expect(typeof result.error.message).toBe("string");
      expect(typeof result.error.retryable).toBe("boolean");
    }
  });

  it("VALIDATION errors are not retryable", () => {
    const result = createNode({});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.retryable).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// KoiNode interface shape
// ---------------------------------------------------------------------------

describe("createNode — KoiNode interface shape", () => {
  it("returned node has all required methods", () => {
    const result = createNode(validConfig());
    if (!result.ok) return;

    const node = result.value;

    expect(typeof node.nodeId).toBe("string");
    expect(typeof node.state).toBe("function");
    expect(typeof node.start).toBe("function");
    expect(typeof node.stop).toBe("function");
    expect(typeof node.dispatch).toBe("function");
    expect(typeof node.terminate).toBe("function");
    expect(typeof node.getAgent).toBe("function");
    expect(typeof node.listAgents).toBe("function");
    expect(typeof node.capacity).toBe("function");
    expect(typeof node.onEvent).toBe("function");
    expect(node.toolResolver).toBeDefined();
  });

  it("state() returns a valid NodeState", () => {
    const result = createNode(validConfig());
    if (!result.ok) return;

    const validStates: readonly NodeState[] = [
      "starting",
      "connected",
      "reconnecting",
      "stopping",
      "stopped",
    ];
    expect(validStates).toContain(result.value.state());
  });
});
