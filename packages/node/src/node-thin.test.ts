/**
 * Tests for createNode() in thin mode — verifying ThinKoiNode surface,
 * lifecycle, event system, and tool resolver access.
 *
 * Split from node.test.ts to keep both files under the 800-line max.
 */

import { describe, expect, it, mock } from "bun:test";
import type { KoiNode, ThinKoiNode } from "./node.js";
import { createNode } from "./node.js";
import type { NodeEvent } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function validConfig(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    gateway: { url: "wss://gateway.test.local" },
    discovery: { enabled: false },
    ...overrides,
  };
}

function thinConfig(overrides?: Record<string, unknown>): Record<string, unknown> {
  return validConfig({ mode: "thin", ...overrides });
}

function createThinNodeForTest(overrides?: Record<string, unknown>): ThinKoiNode {
  const result = createNode(thinConfig(overrides));
  if (!result.ok) throw new Error("Failed to create thin node for test");
  if (result.value.mode !== "thin") throw new Error("Expected thin mode node");
  return result.value;
}

// ---------------------------------------------------------------------------
// Thin mode behavior
// ---------------------------------------------------------------------------

describe("createNode — thin mode behavior", () => {
  it("thin node creates successfully with mode: thin", () => {
    const result = createNode(thinConfig());
    expect(result.ok).toBe(true);
  });

  it("thin node has mode 'thin' on the returned handle", () => {
    const node = createThinNodeForTest();
    expect(node.mode).toBe("thin");
  });

  it("thin node does not expose dispatch/terminate/getAgent/listAgents/capacity", () => {
    const node = createThinNodeForTest();

    // These are Full-only — verify they are absent on the thin node handle
    expect("dispatch" in node).toBe(false);
    expect("terminate" in node).toBe(false);
    expect("getAgent" in node).toBe(false);
    expect("listAgents" in node).toBe(false);
    expect("capacity" in node).toBe(false);
    expect("checkpoint" in node).toBe(false);
  });

  it("thin node has shared surface: nodeId, mode, state, start, stop, onEvent, toolResolver", () => {
    const node = createThinNodeForTest({ nodeId: "thin-test-1" });

    expect(node.nodeId).toBe("thin-test-1");
    expect(node.mode).toBe("thin");
    expect(typeof node.state).toBe("function");
    expect(typeof node.start).toBe("function");
    expect(typeof node.stop).toBe("function");
    expect(typeof node.onEvent).toBe("function");
    expect(node.toolResolver).toBeDefined();
  });

  it("thin node start/stop lifecycle works", async () => {
    const node = createThinNodeForTest();

    expect(node.state()).toBe("stopped");

    // Start — but will fail because no real gateway; just verify state transitions
    const startPromise = node.start();
    expect(node.state()).toBe("starting");

    startPromise.catch(() => {});
    await node.stop();
    expect(node.state()).toBe("stopped");
  });

  it("thin node start() is idempotent when already starting", () => {
    const node = createThinNodeForTest();

    const p1 = node.start();
    const p2 = node.start();

    expect(node.state()).toBe("starting");

    p1.catch(() => {});
    p2.catch(() => {});
    void node.stop();
  });

  it("thin node stop() on a never-started node does not throw", async () => {
    const node = createThinNodeForTest();
    await node.stop();
    expect(node.state()).toBe("stopped");
  });

  it("thin node stop() is idempotent", async () => {
    const node = createThinNodeForTest();
    await node.stop();
    await node.stop();
    expect(node.state()).toBe("stopped");
  });

  it("thin node onEvent() returns working unsubscribe function", () => {
    const node = createThinNodeForTest();
    const listener = mock((_event: NodeEvent): void => {});
    const unsub = node.onEvent(listener);
    expect(typeof unsub).toBe("function");
    unsub();
  });

  it("thin node toolResolver is functional", async () => {
    const node = createThinNodeForTest({
      tools: {
        directories: [],
        builtins: { filesystem: true, shell: true },
      },
    });

    const tools = await node.toolResolver.discover();
    expect(tools.length).toBeGreaterThan(0);
  });

  it("thin node generates unique nodeId when not provided", () => {
    const node1 = createThinNodeForTest();
    const node2 = createThinNodeForTest();
    expect(node1.nodeId).not.toBe(node2.nodeId);
  });

  it("discriminated union narrows correctly on mode", () => {
    const result = createNode(thinConfig());
    if (!result.ok) return;

    const node: KoiNode = result.value;

    // TypeScript narrows based on mode discriminant
    if (node.mode === "thin") {
      expect(node.mode).toBe("thin");
      // Thin-only surface works
      expect(typeof node.state).toBe("function");
    } else {
      // Full-only surface would be available here
      expect(node.mode).toBe("full");
    }
  });
});
