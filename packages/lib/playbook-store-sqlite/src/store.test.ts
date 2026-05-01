import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  Playbook,
  PlaybookEvaluation,
  PlaybookProposal,
  StructuredPlaybook,
  TrajectoryEntry,
  TrajectoryRange,
} from "@koi/ace-types";

import { createSqlitePlaybookStore } from "./store.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function pb(p: Partial<Playbook> & { readonly id: string }): Playbook {
  return {
    id: p.id,
    title: p.title ?? "t",
    strategy: p.strategy ?? "s",
    tags: p.tags ?? [],
    confidence: p.confidence ?? 0.5,
    source: p.source ?? "curated",
    createdAt: p.createdAt ?? 0,
    updatedAt: p.updatedAt ?? 0,
    sessionCount: p.sessionCount ?? 1,
    version: p.version ?? 1,
    ...(p.provenance !== undefined ? { provenance: p.provenance } : {}),
  };
}

function spb(p: Partial<StructuredPlaybook> & { readonly id: string }): StructuredPlaybook {
  return {
    id: p.id,
    title: p.title ?? "t",
    sections: p.sections ?? [
      {
        name: "Errors",
        slug: "errors",
        bullets: [
          {
            id: "b1",
            content: "always check existence",
            helpful: 1,
            harmful: 0,
            createdAt: 0,
            updatedAt: 0,
          },
        ],
      },
    ],
    tags: p.tags ?? [],
    source: p.source ?? "curated",
    createdAt: p.createdAt ?? 0,
    updatedAt: p.updatedAt ?? 0,
    sessionCount: p.sessionCount ?? 1,
    version: p.version ?? 1,
    ...(p.lastReflectedStepIndex !== undefined
      ? { lastReflectedStepIndex: p.lastReflectedStepIndex }
      : {}),
    ...(p.provenance !== undefined ? { provenance: p.provenance } : {}),
  };
}

const trajRange: TrajectoryRange = {
  sessionId: "sess-1",
  fromStepIndex: 0,
  toStepIndex: 4,
};

function makeEntry(turnIndex: number, identifier: string): TrajectoryEntry {
  return {
    turnIndex,
    timestamp: turnIndex * 1000,
    kind: "tool_call",
    identifier,
    outcome: "success",
    durationMs: 12,
  };
}

function makeProposal(id: string, playbookId: string): PlaybookProposal {
  return {
    id,
    playbookId,
    baseVersion: 1,
    operations: [{ kind: "add", section: "errors", content: "check before edit" }],
    sourceTrajectoryRange: trajRange,
    reflection: {
      rootCause: "missed precondition",
      keyInsight: "verify state first",
      bulletTags: [{ id: "b1", tag: "helpful" }],
    },
    createdAt: 100,
  };
}

function makeEvaluation(id: string, proposalId: string): PlaybookEvaluation {
  return {
    id,
    proposalId,
    verdict: "promote",
    metrics: { helpfulRate: 0.7, tokenDelta: 12 },
    notes: "passed thresholds",
    evaluatedAt: 200,
  };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let tmp: string;
let dbPath: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "playbook-sqlite-"));
  dbPath = join(tmp, "ace.sqlite");
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createSqlitePlaybookStore — playbooks", () => {
  test("save, get, list, remove", async () => {
    const store = createSqlitePlaybookStore({ path: dbPath });
    await store.playbooks.save(pb({ id: "a" }));
    await store.playbooks.save(pb({ id: "b", confidence: 0.9, tags: ["x"] }));

    expect((await store.playbooks.get("a"))?.id).toBe("a");
    expect((await store.playbooks.list()).length).toBe(2);
    expect(await store.playbooks.remove("a")).toBe(true);
    expect(await store.playbooks.remove("a")).toBe(false);
    expect(await store.playbooks.get("a")).toBeUndefined();
    store.close();
  });

  test("filters list by minConfidence and tags", async () => {
    const store = createSqlitePlaybookStore({ path: dbPath });
    await store.playbooks.save(pb({ id: "lo", confidence: 0.1, tags: ["x"] }));
    await store.playbooks.save(pb({ id: "hi", confidence: 0.9, tags: ["x", "y"] }));
    await store.playbooks.save(pb({ id: "mid", confidence: 0.5, tags: ["z"] }));

    const high = await store.playbooks.list({ minConfidence: 0.5 });
    expect(high.map((p) => p.id).sort()).toEqual(["hi", "mid"]);

    const tagged = await store.playbooks.list({ tags: ["x", "y"] });
    expect(tagged.map((p) => p.id)).toEqual(["hi"]);
    store.close();
  });

  test("preserves optional provenance roundtrip", async () => {
    const store = createSqlitePlaybookStore({ path: dbPath });
    const provenance = {
      sourceTrajectoryRange: trajRange,
      proposalId: "p-1",
      evaluationId: "e-1",
      committedAt: 999,
    };
    await store.playbooks.save(pb({ id: "with-prov", provenance }));
    const got = await store.playbooks.get("with-prov");
    expect(got?.provenance).toEqual(provenance);
    store.close();
  });
});

describe("createSqlitePlaybookStore — structured playbooks + lineage", () => {
  test("save → list → getVersion preserves prior versions", async () => {
    const store = createSqlitePlaybookStore({ path: dbPath });

    await store.structuredPlaybooks.save(spb({ id: "s1", version: 1 }));
    await store.structuredPlaybooks.save(spb({ id: "s1", version: 2, title: "v2" }));
    await store.structuredPlaybooks.save(spb({ id: "s1", version: 3, title: "v3" }));

    const current = await store.structuredPlaybooks.get("s1");
    expect(current?.version).toBe(3);
    expect(current?.title).toBe("v3");

    const v1 = await store.structuredPlaybooks.getVersion?.("s1", 1);
    const v2 = await store.structuredPlaybooks.getVersion?.("s1", 2);
    expect(v1?.version).toBe(1);
    expect(v2?.title).toBe("v2");

    store.close();
  });

  test("getVersion returns undefined for unknown id/version", async () => {
    const store = createSqlitePlaybookStore({ path: dbPath });
    await store.structuredPlaybooks.save(spb({ id: "s1", version: 1 }));
    expect(await store.structuredPlaybooks.getVersion?.("s1", 99)).toBeUndefined();
    expect(await store.structuredPlaybooks.getVersion?.("nope", 1)).toBeUndefined();
    store.close();
  });

  test("rejects re-commit of same (id, version) with different content", async () => {
    const store = createSqlitePlaybookStore({ path: dbPath });
    await store.structuredPlaybooks.save(spb({ id: "s1", version: 1 }));
    await expect(
      store.structuredPlaybooks.save(spb({ id: "s1", version: 1, title: "tampered" })),
    ).rejects.toThrow();
    store.close();
  });

  test("re-commit of same (id, version) with identical content is idempotent", async () => {
    const store = createSqlitePlaybookStore({ path: dbPath });
    const base = spb({ id: "s1", version: 1 });
    await store.structuredPlaybooks.save(base);
    await store.structuredPlaybooks.save(base);
    expect((await store.structuredPlaybooks.get("s1"))?.version).toBe(1);
    store.close();
  });

  test("filters list by tags", async () => {
    const store = createSqlitePlaybookStore({ path: dbPath });
    await store.structuredPlaybooks.save(spb({ id: "s1", tags: ["foo"] }));
    await store.structuredPlaybooks.save(spb({ id: "s2", tags: ["bar"] }));
    const filtered = await store.structuredPlaybooks.list({ tags: ["foo"] });
    expect(filtered.map((p) => p.id)).toEqual(["s1"]);
    store.close();
  });
});

describe("createSqlitePlaybookStore — trajectories", () => {
  test("appends per session and reads back in order", async () => {
    const store = createSqlitePlaybookStore({ path: dbPath });
    await store.trajectories.append("s1", [makeEntry(0, "x"), makeEntry(1, "y")]);
    await store.trajectories.append("s1", [makeEntry(2, "z")]);
    await store.trajectories.append("s2", [makeEntry(0, "a")]);

    const s1 = await store.trajectories.getSession("s1");
    expect(s1.map((e) => e.identifier)).toEqual(["x", "y", "z"]);

    const sessions = await store.trajectories.listSessions();
    expect([...sessions].sort()).toEqual(["s1", "s2"]);

    const limited = await store.trajectories.listSessions({ limit: 1 });
    expect(limited.length).toBe(1);
    store.close();
  });

  test("preserves metadata + bulletIds", async () => {
    const store = createSqlitePlaybookStore({ path: dbPath });
    const e: TrajectoryEntry = {
      ...makeEntry(0, "x"),
      metadata: { foo: "bar" },
      bulletIds: ["b1", "b2"],
    };
    await store.trajectories.append("s1", [e]);
    const back = await store.trajectories.getSession("s1");
    expect(back[0]?.metadata).toEqual({ foo: "bar" });
    expect(back[0]?.bulletIds).toEqual(["b1", "b2"]);
    store.close();
  });
});

describe("createSqlitePlaybookStore — proposals", () => {
  test("records, fetches, lists by playbookId", async () => {
    const store = createSqlitePlaybookStore({ path: dbPath });
    await store.proposals.recordProposal(makeProposal("p-1", "pb-A"));
    await store.proposals.recordProposal(makeProposal("p-2", "pb-A"));
    await store.proposals.recordProposal(makeProposal("p-3", "pb-B"));

    expect((await store.proposals.getProposal("p-2"))?.playbookId).toBe("pb-A");
    expect(await store.proposals.getProposal("nope")).toBeUndefined();

    const aList = await store.proposals.listProposals("pb-A");
    expect(aList.map((p) => p.id).sort()).toEqual(["p-1", "p-2"]);
    store.close();
  });

  test("records evaluation + roundtrips reflection JSON", async () => {
    const store = createSqlitePlaybookStore({ path: dbPath });
    await store.proposals.recordProposal(makeProposal("p-1", "pb-A"));
    await store.proposals.recordEvaluation(makeEvaluation("e-1", "p-1"));
    const got = await store.proposals.getProposal("p-1");
    expect(got?.reflection.rootCause).toBe("missed precondition");
  });
});

describe("createSqlitePlaybookStore — legacy encoding compatibility", () => {
  test("idempotent retry against row written with non-canonical JSON encoding", async () => {
    // Seed a structured_playbook_versions row with reversed-key non-canonical
    // JSON, simulating a database written before this package canonicalized.
    const seedDb = new Database(dbPath, { create: true });
    seedDb.run(`
      CREATE TABLE IF NOT EXISTS structured_playbooks (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, sections TEXT NOT NULL,
        tags TEXT NOT NULL DEFAULT '[]', source TEXT NOT NULL,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        session_count INTEGER NOT NULL, last_reflected_step_index INTEGER,
        version INTEGER NOT NULL, provenance TEXT
      )
    `);
    seedDb.run(`
      CREATE TABLE IF NOT EXISTS structured_playbook_versions (
        playbook_id TEXT NOT NULL, version INTEGER NOT NULL,
        snapshot TEXT NOT NULL, committed_at INTEGER NOT NULL,
        PRIMARY KEY (playbook_id, version)
      )
    `);
    const pb1 = spb({ id: "s1", version: 1 });
    // Plain JSON.stringify (no key sort) — legacy encoding.
    const legacySnapshot = JSON.stringify({
      version: pb1.version,
      title: pb1.title,
      id: pb1.id,
      sections: pb1.sections,
      tags: pb1.tags,
      source: pb1.source,
      createdAt: pb1.createdAt,
      updatedAt: pb1.updatedAt,
      sessionCount: pb1.sessionCount,
    });
    seedDb.run(
      "INSERT INTO structured_playbook_versions (playbook_id, version, snapshot, committed_at) VALUES (?, ?, ?, ?)",
      [pb1.id, pb1.version, legacySnapshot, 1234],
    );
    seedDb.run(
      "INSERT INTO structured_playbooks (id, title, sections, tags, source, created_at, updated_at, session_count, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        pb1.id,
        pb1.title,
        JSON.stringify(pb1.sections),
        JSON.stringify(pb1.tags),
        pb1.source,
        pb1.createdAt,
        pb1.updatedAt,
        pb1.sessionCount,
        pb1.version,
      ],
    );
    seedDb.close();

    // Idempotent retry under the new (canonical) encoding must succeed.
    const store = createSqlitePlaybookStore({ path: dbPath });
    await store.structuredPlaybooks.save(pb1);
    expect((await store.structuredPlaybooks.get("s1"))?.version).toBe(1);
    store.close();
  });
});

describe("createSqlitePlaybookStore — head-row self-heal", () => {
  test("retry rebuilds missing head row when lineage is intact", async () => {
    const store = createSqlitePlaybookStore({ path: dbPath });
    const base = spb({ id: "s1", version: 1, title: "v1" });
    await store.structuredPlaybooks.save(base);
    expect((await store.structuredPlaybooks.get("s1"))?.title).toBe("v1");
    store.close();

    // Simulate corruption: drop the head row but keep lineage.
    const corrupt = new Database(dbPath);
    corrupt.run("DELETE FROM structured_playbooks WHERE id = ?", ["s1"]);
    corrupt.close();

    const repaired = createSqlitePlaybookStore({ path: dbPath });
    expect(await repaired.structuredPlaybooks.get("s1")).toBeUndefined();
    // Idempotent retry must rebuild the head row, not silently succeed.
    await repaired.structuredPlaybooks.save(base);
    expect((await repaired.structuredPlaybooks.get("s1"))?.title).toBe("v1");
    repaired.close();
  });
});

describe("createSqlitePlaybookStore — provenance/lineage time normalization", () => {
  test("provenance.committedAt is overwritten with server commit time", async () => {
    const before = Date.now();
    const store = createSqlitePlaybookStore({ path: dbPath });
    const stale = {
      sourceTrajectoryRange: trajRange,
      proposalId: "p-1",
      evaluationId: "e-1",
      committedAt: 1, // Caller-supplied stale value
    };
    await store.structuredPlaybooks.save(spb({ id: "s1", version: 1, provenance: stale }));
    const got = await store.structuredPlaybooks.get("s1");
    expect(got?.provenance?.committedAt).toBeGreaterThanOrEqual(before);
    expect(got?.provenance?.proposalId).toBe("p-1");
    store.close();
  });

  test("idempotent retry succeeds even though provenance.committedAt differs", async () => {
    const store = createSqlitePlaybookStore({ path: dbPath });
    const prov = {
      sourceTrajectoryRange: trajRange,
      proposalId: "p-1",
      evaluationId: "e-1",
      committedAt: 0,
    };
    await store.structuredPlaybooks.save(spb({ id: "s1", version: 1, provenance: prov }));
    // Retry with the same payload — server will normalize to a new committedAt
    // but the call must still be idempotent on the substantive content.
    await store.structuredPlaybooks.save(spb({ id: "s1", version: 1, provenance: prov }));
    expect((await store.structuredPlaybooks.get("s1"))?.version).toBe(1);
    store.close();
  });
});

describe("createSqlitePlaybookStore — server-stamped lineage time", () => {
  test("committed_at reflects commit time, not caller's updatedAt", async () => {
    const before = Date.now();
    const store = createSqlitePlaybookStore({ path: dbPath });
    // Save with a deliberately stale updatedAt (e.g., a rollback re-using an
    // old snapshot). Lineage commit time must NOT be backdated to that value.
    await store.structuredPlaybooks.save(spb({ id: "s1", version: 1, updatedAt: 0 }));
    store.close();

    const reader = new Database(dbPath, { readonly: true });
    const row = reader
      .query(
        "SELECT committed_at FROM structured_playbook_versions WHERE playbook_id = ? AND version = ?",
      )
      .get("s1", 1) as { readonly committed_at: number } | null;
    reader.close();
    expect(row).not.toBeNull();
    expect(row?.committed_at).toBeGreaterThanOrEqual(before);
    expect(row?.committed_at).toBeLessThanOrEqual(Date.now());
  });
});

describe("createSqlitePlaybookStore — stale-replay protection", () => {
  test("rejects replay of old identical version after head has advanced", async () => {
    const store = createSqlitePlaybookStore({ path: dbPath });
    const v3 = spb({ id: "s1", version: 3 });
    await store.structuredPlaybooks.save(v3);
    await store.structuredPlaybooks.save(spb({ id: "s1", version: 5, title: "v5" }));
    // Stale worker retries the v3 payload byte-identical: must throw, not
    // silently succeed. The race-loser needs to know head has advanced.
    await expect(store.structuredPlaybooks.save(v3)).rejects.toThrow();
    expect((await store.structuredPlaybooks.get("s1"))?.version).toBe(5);
    store.close();
  });
});

describe("createSqlitePlaybookStore — watermark monotonicity", () => {
  test("save clamps lastReflectedStepIndex to max(current, incoming)", async () => {
    const store = createSqlitePlaybookStore({ path: dbPath });
    await store.structuredPlaybooks.save(spb({ id: "s1", version: 1, lastReflectedStepIndex: 50 }));
    // Rollback re-saves an older snapshot whose watermark was 10.
    // Store must NOT regress to 10; head watermark stays at 50.
    await store.structuredPlaybooks.save(
      spb({ id: "s1", version: 2, title: "rollback", lastReflectedStepIndex: 10 }),
    );
    expect((await store.structuredPlaybooks.get("s1"))?.lastReflectedStepIndex).toBe(50);
  });

  test("save advances watermark when incoming is higher", async () => {
    const store = createSqlitePlaybookStore({ path: dbPath });
    await store.structuredPlaybooks.save(spb({ id: "s1", version: 1, lastReflectedStepIndex: 10 }));
    await store.structuredPlaybooks.save(spb({ id: "s1", version: 2, lastReflectedStepIndex: 25 }));
    expect((await store.structuredPlaybooks.get("s1"))?.lastReflectedStepIndex).toBe(25);
  });
});

describe("createSqlitePlaybookStore — rollback workflow", () => {
  test("rollback by re-committing prior snapshot as new head version", async () => {
    const store = createSqlitePlaybookStore({ path: dbPath });

    await store.structuredPlaybooks.save(spb({ id: "s1", version: 1, title: "v1" }));
    await store.structuredPlaybooks.save(spb({ id: "s1", version: 2, title: "v2-bad" }));
    expect((await store.structuredPlaybooks.get("s1"))?.title).toBe("v2-bad");

    // Recover v1's content and re-commit as a NEW monotonic version.
    const v1 = await store.structuredPlaybooks.getVersion("s1", 1);
    expect(v1?.title).toBe("v1");
    const head = await store.structuredPlaybooks.get("s1");
    await store.structuredPlaybooks.save({
      ...(v1 as NonNullable<typeof v1>),
      version: (head?.version ?? 1) + 1,
    });

    expect((await store.structuredPlaybooks.get("s1"))?.title).toBe("v1");
    expect((await store.structuredPlaybooks.get("s1"))?.version).toBe(3);
    // Original v2 row is preserved in lineage — rollback is reversible.
    expect((await store.structuredPlaybooks.getVersion("s1", 2))?.title).toBe("v2-bad");
    store.close();
  });
});

describe("createSqlitePlaybookStore — canonical JSON idempotency", () => {
  test("recordProposal accepts retry with key-reordered payload", async () => {
    const store = createSqlitePlaybookStore({ path: dbPath });
    const original = makeProposal("p-1", "pb-A");
    await store.proposals.recordProposal(original);

    // Same content, different object key insertion order across all nested fields.
    const reordered: PlaybookProposal = {
      createdAt: original.createdAt,
      reflection: {
        bulletTags: original.reflection.bulletTags,
        keyInsight: original.reflection.keyInsight,
        rootCause: original.reflection.rootCause,
      },
      sourceTrajectoryRange: {
        toStepIndex: original.sourceTrajectoryRange.toStepIndex,
        sessionId: original.sourceTrajectoryRange.sessionId,
        fromStepIndex: original.sourceTrajectoryRange.fromStepIndex,
      },
      operations: original.operations,
      baseVersion: original.baseVersion,
      playbookId: original.playbookId,
      id: original.id,
    };
    await store.proposals.recordProposal(reordered);
    expect((await store.proposals.listProposals("pb-A")).length).toBe(1);
    store.close();
  });
});

describe("createSqlitePlaybookStore — append-only invariants", () => {
  test("structured save rejects out-of-order regression", async () => {
    const store = createSqlitePlaybookStore({ path: dbPath });
    await store.structuredPlaybooks.save(spb({ id: "s1", version: 3, title: "v3" }));
    await expect(
      store.structuredPlaybooks.save(spb({ id: "s1", version: 2, title: "v2" })),
    ).rejects.toThrow();
    expect((await store.structuredPlaybooks.get("s1"))?.version).toBe(3);
    expect((await store.structuredPlaybooks.get("s1"))?.title).toBe("v3");
    store.close();
  });

  test("trajectory append rejects duplicate with different content", async () => {
    const store = createSqlitePlaybookStore({ path: dbPath });
    await store.trajectories.append("s1", [makeEntry(0, "x")]);
    await expect(
      store.trajectories.append("s1", [{ ...makeEntry(0, "x"), durationMs: 999 }]),
    ).rejects.toThrow();
    const back = await store.trajectories.getSession("s1");
    expect(back.length).toBe(1);
    expect(back[0]?.durationMs).toBe(12);
    store.close();
  });

  test("trajectory append enriches null metadata + bulletIds and persists tail", async () => {
    const store = createSqlitePlaybookStore({ path: dbPath });
    await store.trajectories.append("s1", [makeEntry(0, "x")]);
    // Replay overlaps existing row with metadata enrichment + adds a tail entry.
    await store.trajectories.append("s1", [
      { ...makeEntry(0, "x"), metadata: { enriched: true }, bulletIds: ["b9"] },
      makeEntry(1, "y"),
    ]);
    const back = await store.trajectories.getSession("s1");
    expect(back.length).toBe(2);
    expect(back[0]?.metadata).toEqual({ enriched: true });
    expect(back[0]?.bulletIds).toEqual(["b9"]);
    expect(back[1]?.identifier).toBe("y");
    store.close();
  });

  test("concurrent enrichment from two handles cannot silently overwrite", async () => {
    const a = createSqlitePlaybookStore({ path: dbPath });
    const b = createSqlitePlaybookStore({ path: dbPath });
    await a.trajectories.append("s1", [makeEntry(0, "x")]);
    // Both handles see the row with NULL metadata. Writer A enriches first.
    await a.trajectories.append("s1", [{ ...makeEntry(0, "x"), metadata: { src: "a" } }]);
    // Writer B's stale read would have allowed it to write {src:"b"}; the
    // serialized .immediate() lock + guarded UPDATE must reject the conflict
    // rather than silently overwriting A's enrichment.
    await expect(
      b.trajectories.append("s1", [{ ...makeEntry(0, "x"), metadata: { src: "b" } }]),
    ).rejects.toThrow();
    const back = await a.trajectories.getSession("s1");
    expect(back[0]?.metadata).toEqual({ src: "a" });
    a.close();
    b.close();
  });

  test("trajectory enrichment cannot overwrite an already-set metadata field", async () => {
    const store = createSqlitePlaybookStore({ path: dbPath });
    await store.trajectories.append("s1", [{ ...makeEntry(0, "x"), metadata: { v: 1 } }]);
    await expect(
      store.trajectories.append("s1", [{ ...makeEntry(0, "x"), metadata: { v: 2 } }]),
    ).rejects.toThrow();
    store.close();
  });

  test("trajectory append accepts byte-identical retry without losing tail", async () => {
    const store = createSqlitePlaybookStore({ path: dbPath });
    await store.trajectories.append("s1", [makeEntry(0, "x"), makeEntry(1, "y")]);
    // Replay overlaps prefix [0,x] then adds new tail [2,z]
    await store.trajectories.append("s1", [
      makeEntry(0, "x"),
      makeEntry(1, "y"),
      makeEntry(2, "z"),
    ]);
    const back = await store.trajectories.getSession("s1");
    expect(back.map((e) => e.identifier)).toEqual(["x", "y", "z"]);
    store.close();
  });

  test("recordProposal rejects duplicate id with different content", async () => {
    const store = createSqlitePlaybookStore({ path: dbPath });
    await store.proposals.recordProposal(makeProposal("p-1", "pb-A"));
    await expect(
      store.proposals.recordProposal({
        ...makeProposal("p-1", "pb-A"),
        baseVersion: 999,
      }),
    ).rejects.toThrow();
    expect((await store.proposals.getProposal("p-1"))?.baseVersion).toBe(1);
    store.close();
  });

  test("recordProposal accepts byte-identical idempotent retry", async () => {
    const store = createSqlitePlaybookStore({ path: dbPath });
    const p = makeProposal("p-1", "pb-A");
    await store.proposals.recordProposal(p);
    await store.proposals.recordProposal(p);
    expect((await store.proposals.listProposals("pb-A")).length).toBe(1);
    store.close();
  });

  test("recordEvaluation rejects duplicate id with different verdict", async () => {
    const store = createSqlitePlaybookStore({ path: dbPath });
    await store.proposals.recordProposal(makeProposal("p-1", "pb-A"));
    await store.proposals.recordEvaluation(makeEvaluation("e-1", "p-1"));
    await expect(
      store.proposals.recordEvaluation({
        ...makeEvaluation("e-1", "p-1"),
        verdict: "reject",
      }),
    ).rejects.toThrow();
    store.close();
  });
});

describe("createSqlitePlaybookStore — crash safety", () => {
  test("write → close → re-open → state intact", async () => {
    const w = createSqlitePlaybookStore({ path: dbPath });
    await w.playbooks.save(pb({ id: "pb1", tags: ["t"] }));
    await w.structuredPlaybooks.save(spb({ id: "s1", version: 1 }));
    await w.structuredPlaybooks.save(spb({ id: "s1", version: 2, title: "v2" }));
    await w.trajectories.append("sess", [makeEntry(0, "x")]);
    await w.proposals.recordProposal(makeProposal("p-1", "pb1"));
    w.close();

    const r = createSqlitePlaybookStore({ path: dbPath });
    expect((await r.playbooks.get("pb1"))?.tags).toEqual(["t"]);
    expect((await r.structuredPlaybooks.get("s1"))?.version).toBe(2);
    expect((await r.structuredPlaybooks.getVersion?.("s1", 1))?.title).toBe("t");
    expect((await r.trajectories.getSession("sess")).length).toBe(1);
    expect((await r.proposals.getProposal("p-1"))?.playbookId).toBe("pb1");
    r.close();
  });
});
