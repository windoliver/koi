import { describe, expect, test } from "bun:test";
import type { AgentId, NameRecord } from "@koi/core";
import { agentId, brickId } from "@koi/core";
import type { NexusNameRecord } from "./nexus-rpc.js";
import {
  applyList,
  applyRegister,
  applyRenew,
  applyUnregister,
  createProjection,
  mapNexusRecord,
} from "./projection.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeNexusRecord(overrides?: Partial<NexusNameRecord>): NexusNameRecord {
  return {
    name: "reviewer",
    binding_kind: "agent",
    agent_id: "agent-1",
    scope: "agent",
    aliases: [],
    registered_at: 1000,
    expires_at: 0,
    registered_by: "test",
    ...overrides,
  };
}

function makeRecord(overrides?: Partial<NameRecord>): NameRecord {
  return Object.freeze({
    name: "reviewer",
    binding: { kind: "agent" as const, agentId: "agent-1" as AgentId },
    scope: "agent" as const,
    aliases: Object.freeze([] as readonly string[]),
    registeredAt: 1000,
    expiresAt: 0,
    registeredBy: "test",
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// mapNexusRecord
// ---------------------------------------------------------------------------

describe("mapNexusRecord", () => {
  test("maps agent binding", () => {
    const record = mapNexusRecord(makeNexusRecord());
    expect(record).toBeDefined();
    expect(record?.binding).toEqual({ kind: "agent", agentId: agentId("agent-1") });
    expect(record?.name).toBe("reviewer");
    expect(record?.scope).toBe("agent");
  });

  test("maps brick binding", () => {
    const record = mapNexusRecord(
      makeNexusRecord({
        binding_kind: "brick",
        brick_id: "brick-1",
        brick_kind: "tool",
      }),
    );
    expect(record).toBeDefined();
    expect(record?.binding).toEqual({
      kind: "brick",
      brickId: brickId("brick-1"),
      brickKind: "tool",
    });
  });

  test("returns undefined for invalid binding", () => {
    const record = mapNexusRecord(makeNexusRecord({ binding_kind: "brick", brick_id: undefined }));
    expect(record).toBeUndefined();
  });

  test("preserves aliases", () => {
    const record = mapNexusRecord(makeNexusRecord({ aliases: ["rv", "rev"] }));
    expect(record?.aliases).toEqual(["rv", "rev"]);
  });

  test("returns frozen record", () => {
    const record = mapNexusRecord(makeNexusRecord());
    expect(record).toBeDefined();
    expect(Object.isFrozen(record)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// createProjection
// ---------------------------------------------------------------------------

describe("createProjection", () => {
  test("creates empty projection", () => {
    const p = createProjection();
    expect(p.records.size).toBe(0);
    expect(p.aliases.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// applyList
// ---------------------------------------------------------------------------

describe("applyList", () => {
  test("populates empty projection from list", () => {
    const p = createProjection();
    const events = applyList(p, [makeNexusRecord()], 10_000);

    expect(p.records.size).toBe(1);
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("registered");
    expect(events[0]?.name).toBe("reviewer");
  });

  test("detects removed records", () => {
    const p = createProjection();
    applyList(p, [makeNexusRecord()], 10_000);
    expect(p.records.size).toBe(1);

    // Second list is empty → record removed
    const events = applyList(p, [], 10_000);
    expect(p.records.size).toBe(0);
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("unregistered");
  });

  test("detects renewed records (expiresAt changed)", () => {
    const p = createProjection();
    applyList(p, [makeNexusRecord({ expires_at: 1000 })], 10_000);

    const events = applyList(p, [makeNexusRecord({ expires_at: 2000 })], 10_000);
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("renewed");
  });

  test("emits no events when nothing changed", () => {
    const p = createProjection();
    applyList(p, [makeNexusRecord()], 10_000);

    const events = applyList(p, [makeNexusRecord()], 10_000);
    expect(events).toHaveLength(0);
  });

  test("respects maxEntries limit for new records", () => {
    const p = createProjection();
    const records = [
      makeNexusRecord({ name: "a" }),
      makeNexusRecord({ name: "b" }),
      makeNexusRecord({ name: "c" }),
    ];

    const events = applyList(p, records, 2);
    expect(p.records.size).toBe(2);
    expect(events).toHaveLength(2);
  });

  test("handles mixed add/remove scenario", () => {
    const p = createProjection();
    applyList(p, [makeNexusRecord({ name: "old" })], 10_000);

    const events = applyList(p, [makeNexusRecord({ name: "new" })], 10_000);

    // "old" removed, "new" added
    expect(events).toHaveLength(2);
    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain("registered");
    expect(kinds).toContain("unregistered");
    expect(p.records.size).toBe(1);
  });

  test("inserts aliases for new records", () => {
    const p = createProjection();
    applyList(p, [makeNexusRecord({ aliases: ["rv"] })], 10_000);
    expect(p.aliases.size).toBe(1);
    expect(p.aliases.has("agent:rv")).toBe(true);
  });

  test("removes aliases for removed records", () => {
    const p = createProjection();
    applyList(p, [makeNexusRecord({ aliases: ["rv"] })], 10_000);
    expect(p.aliases.size).toBe(1);

    applyList(p, [], 10_000);
    expect(p.aliases.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// applyRegister
// ---------------------------------------------------------------------------

describe("applyRegister", () => {
  test("adds record to projection", () => {
    const p = createProjection();
    const record = makeRecord();
    const events = applyRegister(p, record);

    expect(p.records.size).toBe(1);
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("registered");
  });

  test("inserts aliases", () => {
    const p = createProjection();
    const record = makeRecord({ aliases: Object.freeze(["rv", "rev"]) });
    applyRegister(p, record);

    expect(p.aliases.size).toBe(2);
    expect(p.aliases.get("agent:rv")).toBe("agent:reviewer");
    expect(p.aliases.get("agent:rev")).toBe("agent:reviewer");
  });
});

// ---------------------------------------------------------------------------
// applyUnregister
// ---------------------------------------------------------------------------

describe("applyUnregister", () => {
  test("removes record from projection", () => {
    const p = createProjection();
    applyRegister(p, makeRecord());
    expect(p.records.size).toBe(1);

    const events = applyUnregister(p, "reviewer", "agent");
    expect(p.records.size).toBe(0);
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("unregistered");
  });

  test("removes aliases", () => {
    const p = createProjection();
    applyRegister(p, makeRecord({ aliases: Object.freeze(["rv"]) }));
    expect(p.aliases.size).toBe(1);

    applyUnregister(p, "reviewer", "agent");
    expect(p.aliases.size).toBe(0);
  });

  test("returns empty events for non-existent record", () => {
    const p = createProjection();
    const events = applyUnregister(p, "nonexistent", "agent");
    expect(events).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// applyRenew
// ---------------------------------------------------------------------------

describe("applyRenew", () => {
  test("updates expiresAt on existing record", () => {
    const p = createProjection();
    applyRegister(p, makeRecord({ expiresAt: 1000 }));

    const events = applyRenew(p, "reviewer", "agent", 5000);
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("renewed");
    expect(p.records.get("agent:reviewer")?.expiresAt).toBe(5000);
  });

  test("returns empty events for non-existent record", () => {
    const p = createProjection();
    const events = applyRenew(p, "nonexistent", "agent", 5000);
    expect(events).toHaveLength(0);
  });
});
