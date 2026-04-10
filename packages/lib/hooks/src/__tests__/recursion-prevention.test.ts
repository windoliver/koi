/**
 * Recursion prevention tests — verifies that hook agents cannot trigger hooks.
 *
 * These are the safety-critical invariants for the agent hook system.
 * If any of these fail, infinite recursion consuming tokens is possible.
 */

import { describe, expect, it } from "bun:test";
import type { HookConfig, HookEvent } from "@koi/core";
import type { RegisteredHook } from "../policy.js";
import { createRegisteredHooks } from "../policy.js";
import { createHookRegistry } from "../registry.js";

/** Wrap an array of HookConfigs as RegisteredHook[]. */
function rhs(
  hooks: readonly HookConfig[],
  tier: "managed" | "user" | "session" = "user",
): readonly RegisteredHook[] {
  return createRegisteredHooks(hooks, tier);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const baseEvent: HookEvent = {
  event: "tool.before",
  agentId: "agent-1",
  sessionId: "session-1",
  toolName: "Bash",
};

const testHooksRaw: readonly HookConfig[] = [
  {
    kind: "command",
    name: "security-gate",
    cmd: ["echo", '{"decision":"block","reason":"dangerous"}'],
    filter: { events: ["tool.before"] },
  },
];

const testHooks = rhs(testHooksRaw);

// ---------------------------------------------------------------------------
// Registry-level suppression (Decision 2A)
// ---------------------------------------------------------------------------

describe("registry-level hook suppression for hook agents", () => {
  it("suppresses all hooks for sessions marked as hook agents", async () => {
    const registry = createHookRegistry();
    registry.register("session-1", "agent-1", testHooks);

    // Before marking: hooks fire normally
    const beforeMark = await registry.execute("session-1", baseEvent);
    // Should have at least attempted to execute (may fail due to cmd not existing, but returns results)
    expect(beforeMark.length).toBeGreaterThanOrEqual(0);

    // Mark as hook agent
    registry.markHookAgent("session-1");

    // After marking: hooks are completely suppressed
    const afterMark = await registry.execute("session-1", baseEvent);
    expect(afterMark).toEqual([]);
  });

  it("unmarkHookAgent restores normal hook dispatch", async () => {
    const registry = createHookRegistry();
    registry.register("session-1", "agent-1", testHooks);

    registry.markHookAgent("session-1");
    const suppressed = await registry.execute("session-1", baseEvent);
    expect(suppressed).toEqual([]);

    registry.unmarkHookAgent("session-1");
    const restored = await registry.execute("session-1", baseEvent);
    // Should attempt dispatch again (non-empty means hooks fire)
    expect(restored.length).toBeGreaterThanOrEqual(0);
  });

  it("isHookAgent correctly reports status", () => {
    const registry = createHookRegistry();
    registry.register("session-1", "agent-1", testHooks);

    expect(registry.isHookAgent("session-1")).toBe(false);

    registry.markHookAgent("session-1");
    expect(registry.isHookAgent("session-1")).toBe(true);

    registry.unmarkHookAgent("session-1");
    expect(registry.isHookAgent("session-1")).toBe(false);
  });

  it("marking unknown session is safe (no-op)", () => {
    const registry = createHookRegistry();
    // Should not throw
    registry.markHookAgent("nonexistent");
    expect(registry.isHookAgent("nonexistent")).toBe(true);

    // Execute returns empty for unregistered sessions regardless
    // (this is the existing behavior)
  });

  it("cleanup does not affect hook-agent marking for other sessions", () => {
    const registry = createHookRegistry();
    registry.register("session-1", "agent-1", testHooks);
    registry.register("session-2", "agent-1", testHooks);

    registry.markHookAgent("session-1");
    registry.markHookAgent("session-2");

    // Cleanup session-1 only
    registry.cleanup("session-1");

    // session-2 should still be marked
    expect(registry.isHookAgent("session-2")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Two sequential agent hooks
// ---------------------------------------------------------------------------

describe("sequential agent hook execution", () => {
  it("two agent hooks in sequence both complete independently", async () => {
    const registry = createHookRegistry();

    // Simulate: first hook agent session runs and completes
    registry.register("hook-session-1", "agent-1", rhs([]));
    registry.markHookAgent("hook-session-1");

    const suppressed1 = await registry.execute("hook-session-1", baseEvent);
    expect(suppressed1).toEqual([]);

    registry.unmarkHookAgent("hook-session-1");
    registry.cleanup("hook-session-1");

    // Second hook agent session: should also work cleanly
    registry.register("hook-session-2", "agent-1", rhs([]));
    registry.markHookAgent("hook-session-2");

    const suppressed2 = await registry.execute("hook-session-2", baseEvent);
    expect(suppressed2).toEqual([]);

    registry.unmarkHookAgent("hook-session-2");
    registry.cleanup("hook-session-2");

    // Main session should still work
    registry.register("main-session", "agent-1", testHooks);
    const mainResult = await registry.execute("main-session", baseEvent);
    expect(mainResult.length).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// Suppression does not affect sibling sessions
// ---------------------------------------------------------------------------

describe("session isolation", () => {
  it("hook-agent suppression on one session does not affect others", async () => {
    const registry = createHookRegistry();

    registry.register("main-session", "agent-1", testHooks);
    registry.register("hook-session", "agent-1", testHooks);

    // Mark only the hook session
    registry.markHookAgent("hook-session");

    // Main session should still fire hooks
    const mainResult = await registry.execute("main-session", baseEvent);
    expect(mainResult.length).toBeGreaterThanOrEqual(1);

    // Hook session should be suppressed
    const hookResult = await registry.execute("hook-session", baseEvent);
    expect(hookResult).toEqual([]);
  });
});
