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
