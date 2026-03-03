import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { AgentId, BrickId, NameChangeEvent, NameServiceBackend } from "@koi/core";
import { createInMemoryNameService } from "./in-memory-backend.js";

describe("createInMemoryNameService", () => {
  let ns: NameServiceBackend;

  beforeEach(() => {
    ns = createInMemoryNameService({ defaultTtlMs: 0 }); // no expiry by default
  });

  afterEach(() => {
    ns.dispose?.();
  });

  // -------------------------------------------------------------------------
  // Happy path
  // -------------------------------------------------------------------------

  describe("register", () => {
    test("registers an agent binding", async () => {
      const result = await ns.register({
        name: "reviewer",
        binding: { kind: "agent", agentId: "a1" as AgentId },
        scope: "agent",
        registeredBy: "test",
      });

      expect(result).toEqual(expect.objectContaining({ ok: true }));
      if (result.ok) {
        expect(result.value.name).toBe("reviewer");
        expect(result.value.binding).toEqual({ kind: "agent", agentId: "a1" as AgentId });
        expect(result.value.scope).toBe("agent");
        expect(result.value.expiresAt).toBe(0);
      }
    });

    test("registers a brick binding", async () => {
      const result = await ns.register({
        name: "my-tool",
        binding: { kind: "brick", brickId: "b1" as BrickId, brickKind: "tool" },
        scope: "global",
        registeredBy: "test",
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.binding).toEqual({
          kind: "brick",
          brickId: "b1" as BrickId,
          brickKind: "tool",
        });
      }
    });

    test("registers with aliases", async () => {
      const result = await ns.register({
        name: "code-reviewer",
        binding: { kind: "agent", agentId: "a1" as AgentId },
        scope: "agent",
        aliases: ["cr", "rev"],
        registeredBy: "test",
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.aliases).toEqual(["cr", "rev"]);
      }
    });

    test("is idempotent for same binding", async () => {
      const binding = { kind: "agent" as const, agentId: "a1" as AgentId };
      await ns.register({ name: "reviewer", binding, scope: "agent", registeredBy: "test" });
      const result = await ns.register({
        name: "reviewer",
        binding,
        scope: "agent",
        registeredBy: "test",
      });
      expect(result.ok).toBe(true);
    });
  });

  describe("resolve", () => {
    test("resolves by canonical name", async () => {
      await ns.register({
        name: "reviewer",
        binding: { kind: "agent", agentId: "a1" as AgentId },
        scope: "agent",
        registeredBy: "test",
      });

      const result = await ns.resolve("reviewer");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.record.name).toBe("reviewer");
        expect(result.value.matchedAlias).toBe(false);
      }
    });

    test("resolves by alias", async () => {
      await ns.register({
        name: "code-reviewer",
        binding: { kind: "agent", agentId: "a1" as AgentId },
        scope: "agent",
        aliases: ["cr"],
        registeredBy: "test",
      });

      const result = await ns.resolve("cr");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.record.name).toBe("code-reviewer");
        expect(result.value.matchedAlias).toBe(true);
        expect(result.value.matchedName).toBe("cr");
      }
    });
  });

  describe("search", () => {
    test("searches by scope", async () => {
      await ns.register({
        name: "a",
        binding: { kind: "agent", agentId: "a1" as AgentId },
        scope: "agent",
        registeredBy: "test",
      });
      await ns.register({
        name: "b",
        binding: { kind: "agent", agentId: "a2" as AgentId },
        scope: "global",
        registeredBy: "test",
      });

      const results = await ns.search({ scope: "agent" });
      expect(results).toHaveLength(1);
      expect(results[0]?.name).toBe("a");
    });

    test("searches by binding kind", async () => {
      await ns.register({
        name: "agent-a",
        binding: { kind: "agent", agentId: "a1" as AgentId },
        scope: "agent",
        registeredBy: "test",
      });
      await ns.register({
        name: "tool-a",
        binding: { kind: "brick", brickId: "b1" as BrickId, brickKind: "tool" },
        scope: "agent",
        registeredBy: "test",
      });

      const results = await ns.search({ bindingKind: "brick" });
      expect(results).toHaveLength(1);
      expect(results[0]?.name).toBe("tool-a");
    });

    test("searches by text", async () => {
      await ns.register({
        name: "code-reviewer",
        binding: { kind: "agent", agentId: "a1" as AgentId },
        scope: "agent",
        registeredBy: "test",
      });
      await ns.register({
        name: "planner",
        binding: { kind: "agent", agentId: "a2" as AgentId },
        scope: "agent",
        registeredBy: "test",
      });

      const results = await ns.search({ text: "review" });
      expect(results).toHaveLength(1);
      expect(results[0]?.name).toBe("code-reviewer");
    });

    test("respects limit", async () => {
      await ns.register({
        name: "a",
        binding: { kind: "agent", agentId: "a1" as AgentId },
        scope: "agent",
        registeredBy: "test",
      });
      await ns.register({
        name: "b",
        binding: { kind: "agent", agentId: "a2" as AgentId },
        scope: "agent",
        registeredBy: "test",
      });
      await ns.register({
        name: "c",
        binding: { kind: "agent", agentId: "a3" as AgentId },
        scope: "agent",
        registeredBy: "test",
      });

      const results = await ns.search({ limit: 2 });
      expect(results).toHaveLength(2);
    });
  });

  describe("suggest", () => {
    test("returns fuzzy suggestions", async () => {
      await ns.register({
        name: "reviewer",
        binding: { kind: "agent", agentId: "a1" as AgentId },
        scope: "agent",
        registeredBy: "test",
      });
      const suggestions = await ns.suggest("reviewr");
      expect(suggestions.length).toBeGreaterThan(0);
      expect(suggestions[0]?.name).toBe("reviewer");
    });
  });

  describe("unregister", () => {
    test("returns true for existing name", async () => {
      await ns.register({
        name: "reviewer",
        binding: { kind: "agent", agentId: "a1" as AgentId },
        scope: "agent",
        registeredBy: "test",
      });
      expect(await ns.unregister("reviewer", "agent")).toBe(true);
    });

    test("returns false for unknown name", async () => {
      expect(await ns.unregister("nonexistent", "agent")).toBe(false);
    });

    test("removes aliases too", async () => {
      await ns.register({
        name: "code-reviewer",
        binding: { kind: "agent", agentId: "a1" as AgentId },
        scope: "agent",
        aliases: ["cr"],
        registeredBy: "test",
      });
      await ns.unregister("code-reviewer", "agent");

      const result = await ns.resolve("cr");
      expect(result.ok).toBe(false);
    });
  });

  describe("renew", () => {
    test("updates expiresAt", async () => {
      await ns.register({
        name: "reviewer",
        binding: { kind: "agent", agentId: "a1" as AgentId },
        scope: "agent",
        ttlMs: 1000,
        registeredBy: "test",
      });

      const result = await ns.renew("reviewer", "agent", 5000);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.expiresAt).toBeGreaterThan(Date.now());
      }
    });

    test("returns NOT_FOUND for unknown name", async () => {
      const result = await ns.renew("nonexistent", "agent");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("NOT_FOUND");
      }
    });
  });

  describe("onChange", () => {
    test("emits registered event", async () => {
      const events: NameChangeEvent[] = [];
      ns.onChange?.((e) => events.push(e));

      await ns.register({
        name: "reviewer",
        binding: { kind: "agent", agentId: "a1" as AgentId },
        scope: "agent",
        registeredBy: "test",
      });

      expect(events).toHaveLength(1);
      expect(events[0]?.kind).toBe("registered");
      expect(events[0]?.name).toBe("reviewer");
    });

    test("emits unregistered event", async () => {
      const events: NameChangeEvent[] = [];
      await ns.register({
        name: "reviewer",
        binding: { kind: "agent", agentId: "a1" as AgentId },
        scope: "agent",
        registeredBy: "test",
      });

      ns.onChange?.((e) => events.push(e));
      await ns.unregister("reviewer", "agent");

      expect(events).toHaveLength(1);
      expect(events[0]?.kind).toBe("unregistered");
    });

    test("emits renewed event", async () => {
      const events: NameChangeEvent[] = [];
      await ns.register({
        name: "reviewer",
        binding: { kind: "agent", agentId: "a1" as AgentId },
        scope: "agent",
        ttlMs: 1000,
        registeredBy: "test",
      });

      ns.onChange?.((e) => events.push(e));
      await ns.renew("reviewer", "agent", 5000);

      expect(events).toHaveLength(1);
      expect(events[0]?.kind).toBe("renewed");
    });

    test("unsubscribe stops events", async () => {
      const events: NameChangeEvent[] = [];
      const unsub = ns.onChange?.((e) => events.push(e));
      expect(unsub).toBeDefined();

      await ns.register({
        name: "a",
        binding: { kind: "agent", agentId: "a1" as AgentId },
        scope: "agent",
        registeredBy: "test",
      });
      expect(events).toHaveLength(1);

      unsub?.();
      await ns.register({
        name: "b",
        binding: { kind: "agent", agentId: "a2" as AgentId },
        scope: "agent",
        registeredBy: "test",
      });
      expect(events).toHaveLength(1); // no new event
    });
  });

  // -------------------------------------------------------------------------
  // Edge cases (all 8 critical cases)
  // -------------------------------------------------------------------------

  describe("edge cases", () => {
    // 1. Same name, different scopes — resolution priority
    test("same name in different scopes resolves by priority", async () => {
      await ns.register({
        name: "reviewer",
        binding: { kind: "agent", agentId: "agent-local" as AgentId },
        scope: "agent",
        registeredBy: "test",
      });
      await ns.register({
        name: "reviewer",
        binding: { kind: "agent", agentId: "agent-zone" as AgentId },
        scope: "zone",
        registeredBy: "test",
      });
      await ns.register({
        name: "reviewer",
        binding: { kind: "agent", agentId: "agent-global" as AgentId },
        scope: "global",
        registeredBy: "test",
      });

      const result = await ns.resolve("reviewer");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.record.binding).toEqual({
          kind: "agent",
          agentId: "agent-local" as AgentId,
        });
      }
    });

    // 2. Alias collision — CONFLICT error
    test("alias collision returns CONFLICT", async () => {
      await ns.register({
        name: "code-reviewer",
        binding: { kind: "agent", agentId: "a1" as AgentId },
        scope: "agent",
        aliases: ["cr"],
        registeredBy: "test",
      });

      const result = await ns.register({
        name: "custom-runner",
        binding: { kind: "agent", agentId: "a2" as AgentId },
        scope: "agent",
        aliases: ["cr"], // collision!
        registeredBy: "test",
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("CONFLICT");
        expect(result.error.message).toContain("cr");
      }
    });

    // 3. TTL expiry during resolve — NOT_FOUND + event
    test("TTL expiry results in NOT_FOUND and expired event", async () => {
      const nsWithTtl = createInMemoryNameService({ defaultTtlMs: 50 });
      const events: NameChangeEvent[] = [];
      nsWithTtl.onChange?.((e) => events.push(e));

      await nsWithTtl.register({
        name: "ephemeral",
        binding: { kind: "agent", agentId: "a1" as AgentId },
        scope: "agent",
        registeredBy: "test",
      });

      // Wait for expiry
      await new Promise((resolve) => setTimeout(resolve, 100));

      const result = await nsWithTtl.resolve("ephemeral");
      expect(result.ok).toBe(false);

      expect(events.some((e) => e.kind === "expired")).toBe(true);

      nsWithTtl.dispose?.();
    });

    // 4. Renew resets timer — still found after original TTL
    test("renew resets TTL so record survives original expiry", async () => {
      const nsWithTtl = createInMemoryNameService({ defaultTtlMs: 60 });

      await nsWithTtl.register({
        name: "renewable",
        binding: { kind: "agent", agentId: "a1" as AgentId },
        scope: "agent",
        registeredBy: "test",
      });

      // Renew with longer TTL
      await nsWithTtl.renew("renewable", "agent", 300);

      // Wait past original TTL
      await new Promise((resolve) => setTimeout(resolve, 100));

      const result = await nsWithTtl.resolve("renewable");
      expect(result.ok).toBe(true);

      nsWithTtl.dispose?.();
    });

    // 5. Concurrent register/unregister — NOT_FOUND
    test("unregister then resolve returns NOT_FOUND", async () => {
      await ns.register({
        name: "temp",
        binding: { kind: "agent", agentId: "a1" as AgentId },
        scope: "agent",
        registeredBy: "test",
      });
      await ns.unregister("temp", "agent");

      const result = await ns.resolve("temp");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("NOT_FOUND");
      }
    });

    // 6. Dispose clears all timers — no leaked callbacks
    test("dispose clears all state", async () => {
      const nsWithTtl = createInMemoryNameService({ defaultTtlMs: 50 });
      const events: NameChangeEvent[] = [];
      nsWithTtl.onChange?.((e) => events.push(e));

      await nsWithTtl.register({
        name: "temp",
        binding: { kind: "agent", agentId: "a1" as AgentId },
        scope: "agent",
        registeredBy: "test",
      });

      nsWithTtl.dispose?.();

      // Wait for timer that would have fired
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Only the registration event, no expiry event
      expect(events.filter((e) => e.kind === "expired")).toHaveLength(0);
    });

    // 7. Invalid names — validation error
    test("rejects invalid names", async () => {
      const result = await ns.register({
        name: "Invalid-Name",
        binding: { kind: "agent", agentId: "a1" as AgentId },
        scope: "agent",
        registeredBy: "test",
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("VALIDATION");
      }
    });

    test("rejects invalid alias names", async () => {
      const result = await ns.register({
        name: "valid-name",
        binding: { kind: "agent", agentId: "a1" as AgentId },
        scope: "agent",
        aliases: ["BAD"],
        registeredBy: "test",
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("VALIDATION");
      }
    });

    // 8. Fuzzy suggestions with no matches — empty array
    test("fuzzy suggestions returns empty for totally unrelated names", async () => {
      await ns.register({
        name: "abcdefghijklmnop",
        binding: { kind: "agent", agentId: "a1" as AgentId },
        scope: "agent",
        registeredBy: "test",
      });

      const suggestions = await ns.suggest("xyz");
      expect(suggestions).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // Capacity
  // -------------------------------------------------------------------------

  describe("capacity", () => {
    test("rejects registration when maxRecords reached", async () => {
      const smallNs = createInMemoryNameService({ defaultTtlMs: 0, maxRecords: 2 });

      await smallNs.register({
        name: "a",
        binding: { kind: "agent", agentId: "a1" as AgentId },
        scope: "agent",
        registeredBy: "test",
      });
      await smallNs.register({
        name: "b",
        binding: { kind: "agent", agentId: "a2" as AgentId },
        scope: "agent",
        registeredBy: "test",
      });

      const result = await smallNs.register({
        name: "c",
        binding: { kind: "agent", agentId: "a3" as AgentId },
        scope: "agent",
        registeredBy: "test",
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("RATE_LIMIT");
      }

      smallNs.dispose?.();
    });
  });

  // -------------------------------------------------------------------------
  // Conflict: name vs alias
  // -------------------------------------------------------------------------

  describe("name-alias conflicts", () => {
    test("rejects name that conflicts with existing alias", async () => {
      await ns.register({
        name: "code-reviewer",
        binding: { kind: "agent", agentId: "a1" as AgentId },
        scope: "agent",
        aliases: ["cr"],
        registeredBy: "test",
      });

      // Try to register "cr" as a canonical name
      const result = await ns.register({
        name: "cr",
        binding: { kind: "agent", agentId: "a2" as AgentId },
        scope: "agent",
        registeredBy: "test",
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("CONFLICT");
      }
    });

    test("same name different scope is allowed", async () => {
      await ns.register({
        name: "reviewer",
        binding: { kind: "agent", agentId: "a1" as AgentId },
        scope: "agent",
        registeredBy: "test",
      });

      const result = await ns.register({
        name: "reviewer",
        binding: { kind: "agent", agentId: "a2" as AgentId },
        scope: "zone",
        registeredBy: "test",
      });

      expect(result.ok).toBe(true);
    });
  });
});
