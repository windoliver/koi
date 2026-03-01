import { describe, expect, test } from "bun:test";
import type { AgentId, NameRecord } from "@koi/core";
import { compositeKey } from "./composite-key.js";
import { resolveByScope } from "./scope-resolver.js";

function makeRecord(
  overrides: Partial<NameRecord> & { readonly name: string; readonly scope: NameRecord["scope"] },
): NameRecord {
  return {
    binding: { kind: "agent", agentId: "agent-1" as AgentId },
    aliases: [],
    registeredAt: Date.now(),
    expiresAt: 0,
    registeredBy: "test",
    ...overrides,
  };
}

describe("resolveByScope", () => {
  test("resolves canonical name in agent scope", () => {
    const records = new Map([
      [compositeKey("agent", "reviewer"), makeRecord({ name: "reviewer", scope: "agent" })],
    ]);
    const result = resolveByScope("reviewer", undefined, records, new Map());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.record.name).toBe("reviewer");
      expect(result.value.matchedAlias).toBe(false);
      expect(result.value.matchedName).toBe("reviewer");
    }
  });

  test("resolves by alias", () => {
    const canonicalKey = compositeKey("agent", "code-reviewer");
    const records = new Map([
      [canonicalKey, makeRecord({ name: "code-reviewer", scope: "agent", aliases: ["cr"] })],
    ]);
    const aliases = new Map([[compositeKey("agent", "cr"), canonicalKey]]);

    const result = resolveByScope("cr", undefined, records, aliases);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.record.name).toBe("code-reviewer");
      expect(result.value.matchedAlias).toBe(true);
      expect(result.value.matchedName).toBe("cr");
    }
  });

  test("agent scope shadows zone scope", () => {
    const records = new Map([
      [
        compositeKey("agent", "reviewer"),
        makeRecord({
          name: "reviewer",
          scope: "agent",
          binding: { kind: "agent", agentId: "agent-local" as AgentId },
        }),
      ],
      [
        compositeKey("zone", "reviewer"),
        makeRecord({
          name: "reviewer",
          scope: "zone",
          binding: { kind: "agent", agentId: "agent-zone" as AgentId },
        }),
      ],
    ]);

    const result = resolveByScope("reviewer", undefined, records, new Map());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.record.binding).toEqual({
        kind: "agent",
        agentId: "agent-local" as AgentId,
      });
    }
  });

  test("zone scope shadows global scope", () => {
    const records = new Map([
      [
        compositeKey("zone", "reviewer"),
        makeRecord({
          name: "reviewer",
          scope: "zone",
          binding: { kind: "agent", agentId: "agent-zone" as AgentId },
        }),
      ],
      [
        compositeKey("global", "reviewer"),
        makeRecord({
          name: "reviewer",
          scope: "global",
          binding: { kind: "agent", agentId: "agent-global" as AgentId },
        }),
      ],
    ]);

    const result = resolveByScope("reviewer", undefined, records, new Map());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.record.binding).toEqual({
        kind: "agent",
        agentId: "agent-zone" as AgentId,
      });
    }
  });

  test("restricts to specific scope when provided", () => {
    const records = new Map([
      [
        compositeKey("agent", "reviewer"),
        makeRecord({
          name: "reviewer",
          scope: "agent",
          binding: { kind: "agent", agentId: "agent-local" as AgentId },
        }),
      ],
      [
        compositeKey("global", "reviewer"),
        makeRecord({
          name: "reviewer",
          scope: "global",
          binding: { kind: "agent", agentId: "agent-global" as AgentId },
        }),
      ],
    ]);

    const result = resolveByScope("reviewer", "global", records, new Map());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.record.binding).toEqual({
        kind: "agent",
        agentId: "agent-global" as AgentId,
      });
    }
  });

  test("skips expired records", () => {
    const records = new Map([
      [
        compositeKey("agent", "reviewer"),
        makeRecord({
          name: "reviewer",
          scope: "agent",
          expiresAt: Date.now() - 1000, // expired 1 second ago
        }),
      ],
    ]);

    const result = resolveByScope("reviewer", undefined, records, new Map());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NOT_FOUND");
    }
  });

  test("does not skip records with expiresAt = 0 (no expiry)", () => {
    const records = new Map([
      [
        compositeKey("agent", "reviewer"),
        makeRecord({
          name: "reviewer",
          scope: "agent",
          expiresAt: 0,
        }),
      ],
    ]);

    const result = resolveByScope("reviewer", undefined, records, new Map());
    expect(result.ok).toBe(true);
  });

  test("returns NOT_FOUND for unknown name", () => {
    const result = resolveByScope("nonexistent", undefined, new Map(), new Map());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NOT_FOUND");
      expect(result.error.message).toContain("nonexistent");
    }
  });

  test("returns NOT_FOUND with scope context when scope specified", () => {
    const result = resolveByScope("nonexistent", "agent", new Map(), new Map());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("agent");
    }
  });

  test("falls through to next scope when current scope record is expired", () => {
    const records = new Map([
      [
        compositeKey("agent", "reviewer"),
        makeRecord({
          name: "reviewer",
          scope: "agent",
          expiresAt: Date.now() - 1000,
          binding: { kind: "agent", agentId: "expired" as AgentId },
        }),
      ],
      [
        compositeKey("zone", "reviewer"),
        makeRecord({
          name: "reviewer",
          scope: "zone",
          binding: { kind: "agent", agentId: "zone-valid" as AgentId },
        }),
      ],
    ]);

    const result = resolveByScope("reviewer", undefined, records, new Map());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.record.binding).toEqual({
        kind: "agent",
        agentId: "zone-valid" as AgentId,
      });
    }
  });
});
