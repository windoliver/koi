import { beforeEach, describe, expect, it, spyOn } from "bun:test";
import type { HookConfig, HookEvent } from "@koi/core";
import * as executorModule from "./executor.js";
import type { HookRegistry } from "./registry.js";
import { createHookRegistry } from "./registry.js";

const baseEvent: HookEvent = {
  event: "session.started",
  agentId: "agent-1",
  sessionId: "session-1",
};

const commandHook: HookConfig = {
  kind: "command",
  name: "test-cmd",
  cmd: ["echo", "hello"],
};

const httpHook: HookConfig = {
  kind: "http",
  name: "test-http",
  url: "https://example.com/hook",
};

describe("createHookRegistry", () => {
  let registry: HookRegistry;

  beforeEach(() => {
    registry = createHookRegistry();
  });

  describe("register", () => {
    it("registers hooks for a session", () => {
      registry.register("s1", "agent-1", [commandHook]);
      expect(registry.has("s1")).toBe(true);
    });

    it("replaces existing registration", () => {
      registry.register("s1", "agent-1", [commandHook]);
      registry.register("s1", "agent-1", [httpHook]);
      expect(registry.has("s1")).toBe(true);
      expect(registry.size()).toBe(1);
    });

    it("supports multiple sessions", () => {
      registry.register("s1", "agent-1", [commandHook]);
      registry.register("s2", "agent-2", [httpHook]);
      expect(registry.size()).toBe(2);
    });
  });

  describe("has", () => {
    it("returns false for unregistered session", () => {
      expect(registry.has("nonexistent")).toBe(false);
    });

    it("returns false after cleanup", () => {
      registry.register("s1", "agent-1", [commandHook]);
      registry.cleanup("s1");
      expect(registry.has("s1")).toBe(false);
    });
  });

  describe("size", () => {
    it("returns 0 for empty registry", () => {
      expect(registry.size()).toBe(0);
    });

    it("returns correct count after registrations", () => {
      registry.register("s1", "agent-1", [commandHook]);
      registry.register("s2", "agent-2", [httpHook]);
      expect(registry.size()).toBe(2);
    });

    it("returns correct count after cleanup", () => {
      registry.register("s1", "agent-1", [commandHook]);
      registry.register("s2", "agent-2", [httpHook]);
      registry.cleanup("s1");
      expect(registry.size()).toBe(1);
    });
  });

  describe("cleanup", () => {
    it("is idempotent — double cleanup is a no-op", () => {
      registry.register("s1", "agent-1", [commandHook]);
      registry.cleanup("s1");
      registry.cleanup("s1"); // Should not throw
      expect(registry.has("s1")).toBe(false);
    });

    it("cleanup of unknown session is a no-op", () => {
      registry.cleanup("nonexistent"); // Should not throw
    });

    it("does not affect other sessions", () => {
      registry.register("s1", "agent-1", [commandHook]);
      registry.register("s2", "agent-2", [httpHook]);
      registry.cleanup("s1");
      expect(registry.has("s1")).toBe(false);
      expect(registry.has("s2")).toBe(true);
    });
  });

  describe("execute", () => {
    it("returns empty array for unregistered session", async () => {
      const results = await registry.execute("nonexistent", baseEvent);
      expect(results).toEqual([]);
    });

    it("returns empty array for cleaned-up session", async () => {
      registry.register("s1", "agent-1", [commandHook]);
      registry.cleanup("s1");
      const results = await registry.execute("s1", baseEvent);
      expect(results).toEqual([]);
    });
  });

  describe("once-hook auto-removal", () => {
    it("removes once-hook after first successful execution", async () => {
      const onceHook: HookConfig = {
        kind: "command",
        name: "setup-check",
        cmd: ["echo", "setup"],
        once: true,
      };
      const spy = spyOn(executorModule, "executeHooks").mockResolvedValue([
        { ok: true, hookName: "setup-check", durationMs: 1, decision: { kind: "continue" } },
      ]);

      registry.register("s1", "agent-1", [onceHook, commandHook]);
      await registry.execute("s1", baseEvent);

      // First call should still include both hooks
      const firstCallHooks = spy.mock.calls[0]?.[0] as readonly HookConfig[];
      expect(firstCallHooks).toHaveLength(2);

      // Second call: only commandHook remains (once-hook consumed)
      await registry.execute("s1", baseEvent);
      const secondCallHooks = spy.mock.calls[1]?.[0] as readonly HookConfig[];
      expect(secondCallHooks).toHaveLength(1);
      expect(secondCallHooks[0]?.name).toBe("test-cmd");

      spy.mockRestore();
    });

    it("retains once-hook when execution fails", async () => {
      const onceHook: HookConfig = {
        kind: "command",
        name: "setup-check",
        cmd: ["echo"],
        once: true,
      };
      const spy = spyOn(executorModule, "executeHooks").mockResolvedValue([
        { ok: false, hookName: "setup-check", error: "timeout", durationMs: 1 },
      ]);

      registry.register("s1", "agent-1", [onceHook]);
      await registry.execute("s1", baseEvent);

      // Hook should still be present after failure (restored by rollback)
      await registry.execute("s1", baseEvent);
      const secondCallHooks = spy.mock.calls[1]?.[0] as readonly HookConfig[];
      expect(secondCallHooks).toHaveLength(1);
      expect(secondCallHooks[0]?.name).toBe("setup-check");

      spy.mockRestore();
    });

    it("does not remove non-once hooks on success", async () => {
      const spy = spyOn(executorModule, "executeHooks").mockResolvedValue([
        { ok: true, hookName: "test-cmd", durationMs: 1, decision: { kind: "continue" } },
      ]);

      registry.register("s1", "agent-1", [commandHook]);
      await registry.execute("s1", baseEvent);

      // Hook should still be present (no once flag)
      await registry.execute("s1", baseEvent);
      const secondCallHooks = spy.mock.calls[1]?.[0] as readonly HookConfig[];
      expect(secondCallHooks).toHaveLength(1);

      spy.mockRestore();
    });

    it("preserves declaration order — once-hooks run in their original position", async () => {
      const earlyGuard: HookConfig = {
        kind: "command",
        name: "early-guard",
        cmd: ["check"],
        once: true,
        serial: true,
      };
      const lateHook: HookConfig = {
        kind: "command",
        name: "late-hook",
        cmd: ["run"],
      };
      const spy = spyOn(executorModule, "executeHooks").mockResolvedValue([
        { ok: true, hookName: "early-guard", durationMs: 1, decision: { kind: "continue" } },
        { ok: true, hookName: "late-hook", durationMs: 1, decision: { kind: "continue" } },
      ]);

      // Register: early-guard BEFORE late-hook
      registry.register("s1", "agent-1", [earlyGuard, lateHook]);
      await registry.execute("s1", baseEvent);

      const hooks = spy.mock.calls[0]?.[0] as readonly HookConfig[];
      expect(hooks).toHaveLength(2);
      // Order preserved: early-guard first, late-hook second
      expect(hooks[0]?.name).toBe("early-guard");
      expect(hooks[1]?.name).toBe("late-hook");

      spy.mockRestore();
    });

    it("concurrent execute() calls do not double-fire a once-hook", async () => {
      const onceHook: HookConfig = {
        kind: "command",
        name: "migrate-check",
        cmd: ["echo"],
        once: true,
      };
      // Simulate slow execution — the mock resolves after a microtask yield
      const spy = spyOn(executorModule, "executeHooks").mockImplementation(async () => {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 10);
        });
        return [
          { ok: true, hookName: "migrate-check", durationMs: 1, decision: { kind: "continue" } },
        ];
      });

      registry.register("s1", "agent-1", [onceHook]);

      // Fire two concurrent executions — only the first should see the once-hook
      const [r1, r2] = await Promise.all([
        registry.execute("s1", baseEvent),
        registry.execute("s1", baseEvent),
      ]);

      const firstCallHooks = spy.mock.calls[0]?.[0] as readonly HookConfig[];
      const secondCallHooks = spy.mock.calls[1]?.[0] as readonly HookConfig[];
      const totalOnceExecutions =
        firstCallHooks.filter((h) => h.name === "migrate-check").length +
        secondCallHooks.filter((h) => h.name === "migrate-check").length;
      expect(totalOnceExecutions).toBe(1);

      expect(r1.length).toBeGreaterThanOrEqual(0);
      expect(r2.length).toBeGreaterThanOrEqual(0);

      spy.mockRestore();
    });

    it("duplicate-named once-hooks: failure restores only the failing instance", async () => {
      // Two once-hooks with the same name but different objects
      const onceA: HookConfig = {
        kind: "command",
        name: "check",
        cmd: ["echo", "a"],
        once: true,
      };
      const onceB: HookConfig = {
        kind: "command",
        name: "check",
        cmd: ["echo", "b"],
        once: true,
      };
      // First hook succeeds, second hook fails
      const spy = spyOn(executorModule, "executeHooks").mockResolvedValue([
        { ok: true, hookName: "check", durationMs: 1, decision: { kind: "continue" } },
        { ok: false, hookName: "check", error: "timeout", durationMs: 1 },
      ]);

      registry.register("s1", "agent-1", [onceA, onceB]);
      await registry.execute("s1", baseEvent);

      // Second call: onceA was consumed (succeeded), onceB was restored (failed)
      await registry.execute("s1", baseEvent);
      const secondCallHooks = spy.mock.calls[1]?.[0] as readonly HookConfig[];
      expect(secondCallHooks).toHaveLength(1);
      // The restored hook should be onceB (the one that failed)
      expect(secondCallHooks[0]).toBe(onceB);

      spy.mockRestore();
    });

    it("normal hook sharing name with once-hook does not misattribute results", async () => {
      const normalCheck: HookConfig = {
        kind: "command",
        name: "check",
        cmd: ["echo", "normal"],
      };
      const onceCheck: HookConfig = {
        kind: "command",
        name: "check",
        cmd: ["echo", "once"],
        once: true,
      };
      // Normal hook succeeds, once-hook fails
      const spy = spyOn(executorModule, "executeHooks").mockResolvedValue([
        { ok: true, hookName: "check", durationMs: 1, decision: { kind: "continue" } },
        { ok: false, hookName: "check", error: "timeout", durationMs: 1 },
      ]);

      registry.register("s1", "agent-1", [normalCheck, onceCheck]);
      await registry.execute("s1", baseEvent);

      // Once-hook failed → should be un-consumed (available for retry)
      await registry.execute("s1", baseEvent);
      const secondCallHooks = spy.mock.calls[1]?.[0] as readonly HookConfig[];
      expect(secondCallHooks).toHaveLength(2);
      expect(secondCallHooks[0]).toBe(normalCheck);
      expect(secondCallHooks[1]).toBe(onceCheck);

      spy.mockRestore();
    });

    it("once-hook with executionFailed (swallowed failure) is un-consumed for retry", async () => {
      const onceHook: HookConfig = {
        kind: "command",
        name: "transient-check",
        cmd: ["echo"],
        once: true,
      };
      // Simulate a swallowed failure (fail-open agent hook)
      const spy = spyOn(executorModule, "executeHooks").mockResolvedValue([
        {
          ok: true,
          hookName: "transient-check",
          durationMs: 1,
          decision: { kind: "continue" },
          executionFailed: true,
        },
      ]);

      registry.register("s1", "agent-1", [onceHook]);
      await registry.execute("s1", baseEvent);

      // Hook should still be available — swallowed failure does not consume
      await registry.execute("s1", baseEvent);
      const secondCallHooks = spy.mock.calls[1]?.[0] as readonly HookConfig[];
      expect(secondCallHooks).toHaveLength(1);
      expect(secondCallHooks[0]?.name).toBe("transient-check");

      spy.mockRestore();
    });

    it("filtered once-hook is not consumed by unrelated events", async () => {
      const filteredOnce: HookConfig = {
        kind: "command",
        name: "tool-gate",
        cmd: ["check"],
        once: true,
        filter: { events: ["tool.before"], tools: ["Bash"] },
      };
      const spy = spyOn(executorModule, "executeHooks").mockResolvedValue([]);

      registry.register("s1", "agent-1", [filteredOnce]);

      // Fire an unrelated event — the once-hook should NOT be consumed
      const unrelatedEvent: HookEvent = {
        ...baseEvent,
        event: "session.started",
        toolName: undefined,
      };
      await registry.execute("s1", unrelatedEvent);

      // Now fire the matching event — the once-hook should still be present
      const matchingEvent: HookEvent = {
        ...baseEvent,
        event: "tool.before",
        toolName: "Bash",
      };
      spy.mockResolvedValue([
        { ok: true, hookName: "tool-gate", durationMs: 1, decision: { kind: "continue" } },
      ]);
      await registry.execute("s1", matchingEvent);

      const secondCallHooks = spy.mock.calls[1]?.[0] as readonly HookConfig[];
      expect(secondCallHooks).toHaveLength(1);
      expect(secondCallHooks[0]?.name).toBe("tool-gate");

      // Third call with the same matching event — consumed, should be gone
      await registry.execute("s1", matchingEvent);
      const thirdCallHooks = spy.mock.calls[2]?.[0] as readonly HookConfig[];
      expect(thirdCallHooks).toHaveLength(0);

      spy.mockRestore();
    });

    it("duplicate object references are treated as distinct instances", async () => {
      const onceHook: HookConfig = {
        kind: "command",
        name: "setup",
        cmd: ["echo"],
        once: true,
      };
      // Same object registered at two positions
      const spy = spyOn(executorModule, "executeHooks").mockResolvedValue([
        { ok: true, hookName: "setup", durationMs: 1, decision: { kind: "continue" } },
        { ok: true, hookName: "setup", durationMs: 1, decision: { kind: "continue" } },
      ]);

      registry.register("s1", "agent-1", [onceHook, onceHook]);
      await registry.execute("s1", baseEvent);

      // Both positions should have been claimed and executed
      const firstCallHooks = spy.mock.calls[0]?.[0] as readonly HookConfig[];
      expect(firstCallHooks).toHaveLength(2);

      // Second call: both consumed, none remain
      await registry.execute("s1", baseEvent);
      const secondCallHooks = spy.mock.calls[1]?.[0] as readonly HookConfig[];
      expect(secondCallHooks).toHaveLength(0);

      spy.mockRestore();
    });

    it("concurrent failure does not let second event skip a once-hook", async () => {
      const onceHook: HookConfig = {
        kind: "command",
        name: "gate",
        cmd: ["check"],
        once: true,
      };
      // let justified: mutable call counter to vary behavior per call
      let callCount = 0;
      const spy = spyOn(executorModule, "executeHooks").mockImplementation(async () => {
        callCount++;
        const thisCall = callCount;
        await new Promise<void>((resolve) => {
          setTimeout(resolve, thisCall === 1 ? 20 : 5);
        });
        if (thisCall === 1) {
          // First call fails
          return [{ ok: false, hookName: "gate", error: "timeout", durationMs: 1 }];
        }
        // Second call succeeds
        return [{ ok: true, hookName: "gate", durationMs: 1, decision: { kind: "continue" } }];
      });

      registry.register("s1", "agent-1", [onceHook]);

      // Fire two concurrent executions — serialization ensures the second
      // waits for the first. First fails → hook un-consumed → second sees it.
      const [r1, r2] = await Promise.all([
        registry.execute("s1", baseEvent),
        registry.execute("s1", baseEvent),
      ]);

      // First call should have the hook (and it fails)
      const firstCallHooks = spy.mock.calls[0]?.[0] as readonly HookConfig[];
      expect(firstCallHooks).toHaveLength(1);
      expect(r1[0]?.ok).toBe(false);

      // Second call should ALSO have the hook (restored after first failure)
      const secondCallHooks = spy.mock.calls[1]?.[0] as readonly HookConfig[];
      expect(secondCallHooks).toHaveLength(1);
      expect(r2[0]?.ok).toBe(true);

      spy.mockRestore();
    });

    it("once-hook is permanently consumed after MAX_ONCE_RETRIES (3) failures", async () => {
      const onceHook: HookConfig = {
        kind: "command",
        name: "flaky-check",
        cmd: ["echo"],
        once: true,
      };
      const spy = spyOn(executorModule, "executeHooks").mockResolvedValue([
        {
          ok: true,
          hookName: "flaky-check",
          durationMs: 1,
          decision: { kind: "continue" },
          executionFailed: true,
        },
      ]);

      registry.register("s1", "agent-1", [onceHook]);

      // Retries 1, 2, 3 — hook is still present (un-consumed after each failure)
      for (const attempt of [1, 2, 3]) {
        await registry.execute("s1", baseEvent);
        const hooks = spy.mock.calls[attempt - 1]?.[0] as readonly HookConfig[];
        expect(hooks).toHaveLength(1);
      }

      // Attempt 4 — retry budget exhausted. Fail-closed once-hook becomes
      // a permanent blocker: returns synthetic block without calling executeHooks.
      const r4 = await registry.execute("s1", baseEvent);
      // executeHooks NOT called for attempt 4 (synthetic block returned early)
      expect(spy).toHaveBeenCalledTimes(3);
      expect(r4).toHaveLength(1);
      expect(r4[0]?.ok).toBe(true);
      if (r4[0]?.ok) {
        expect(r4[0].decision.kind).toBe("block");
      }

      spy.mockRestore();
    });

    it("executeHooks rejection rolls back claimed once-hooks", async () => {
      const onceHook: HookConfig = {
        kind: "command",
        name: "crash-check",
        cmd: ["echo"],
        once: true,
      };
      const spy = spyOn(executorModule, "executeHooks")
        .mockRejectedValueOnce(new Error("unexpected crash"))
        .mockResolvedValue([
          { ok: true, hookName: "crash-check", durationMs: 1, decision: { kind: "continue" } },
        ]);

      registry.register("s1", "agent-1", [onceHook]);

      // First call — executeHooks rejects
      await expect(registry.execute("s1", baseEvent)).rejects.toThrow("unexpected crash");

      // Second call — hook should still be available (rolled back)
      await registry.execute("s1", baseEvent);
      const secondCallHooks = spy.mock.calls[1]?.[0] as readonly HookConfig[];
      expect(secondCallHooks).toHaveLength(1);
      expect(secondCallHooks[0]?.name).toBe("crash-check");

      spy.mockRestore();
    });
  });

  describe("session isolation", () => {
    it("sessions have independent hook sets", () => {
      registry.register("s1", "agent-1", [commandHook]);
      registry.register("s2", "agent-2", [httpHook]);
      registry.cleanup("s1");
      expect(registry.has("s2")).toBe(true);
      expect(registry.size()).toBe(1);
    });

    it("re-registration aborts previous session's controller", () => {
      registry.register("s1", "agent-1", [commandHook]);
      registry.register("s1", "agent-1", [httpHook]);
      expect(registry.has("s1")).toBe(true);
      expect(registry.size()).toBe(1);
    });

    it("overwrites mismatched event.sessionId to prevent cross-session injection", async () => {
      const spy = spyOn(executorModule, "executeHooks").mockResolvedValue([]);

      registry.register("correct-session", "agent-1", [commandHook]);

      const mismatchedEvent: HookEvent = {
        ...baseEvent,
        sessionId: "wrong-session",
      };

      await registry.execute("correct-session", mismatchedEvent);

      expect(spy).toHaveBeenCalledTimes(1);
      const passedEvent = spy.mock.calls[0]?.[1] as HookEvent;
      expect(passedEvent.sessionId).toBe("correct-session");
      expect(passedEvent.agentId).toBe("agent-1");

      spy.mockRestore();
    });

    it("overwrites mismatched event.agentId to prevent cross-agent injection", async () => {
      const spy = spyOn(executorModule, "executeHooks").mockResolvedValue([]);

      registry.register("session-1", "trusted-agent", [commandHook]);

      const mismatchedEvent: HookEvent = {
        ...baseEvent,
        sessionId: "session-1",
        agentId: "spoofed-agent",
      };

      await registry.execute("session-1", mismatchedEvent);

      expect(spy).toHaveBeenCalledTimes(1);
      const passedEvent = spy.mock.calls[0]?.[1] as HookEvent;
      expect(passedEvent.agentId).toBe("trusted-agent");
      expect(passedEvent.sessionId).toBe("session-1");

      spy.mockRestore();
    });

    it("does not copy event when both sessionId and agentId match", async () => {
      const spy = spyOn(executorModule, "executeHooks").mockResolvedValue([]);

      registry.register("session-1", "agent-1", [commandHook]);

      await registry.execute("session-1", baseEvent);

      expect(spy).toHaveBeenCalledTimes(1);
      const passedEvent = spy.mock.calls[0]?.[1];
      // Same object reference — no copy needed
      expect(passedEvent).toBe(baseEvent);

      spy.mockRestore();
    });
  });
});
