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

// Seed the structured_playbook_versions row that playbook_proposals' FK
// requires. Tests that record proposals must call this first for the
// (playbookId, baseVersion=1) anchor.
async function seedAnchor(
  store: ReturnType<typeof createSqlitePlaybookStore>,
  playbookId: string,
  version = 1,
): Promise<void> {
  await store.structuredPlaybooks.save(spb({ id: playbookId, version }));
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

  test("rejects stale flat-playbook save (version below current)", async () => {
    const store = createSqlitePlaybookStore({ path: dbPath });
    await store.playbooks.save(pb({ id: "p", version: 5, strategy: "new" }));
    await expect(
      store.playbooks.save(pb({ id: "p", version: 3, strategy: "old" })),
    ).rejects.toThrow();
    expect((await store.playbooks.get("p"))?.strategy).toBe("new");
    store.close();
  });

  test("rejects equal-version flat-playbook save with different content (concurrent consolidators)", async () => {
    // Regression: two consolidators derive prev.version + 1 from the same
    // snapshot and produce divergent payloads. The second commit at the same
    // version must fail loudly, not silently overwrite — caller must
    // re-derive at version + 1.
    const store = createSqlitePlaybookStore({ path: dbPath });
    await store.playbooks.save(pb({ id: "p", version: 2, strategy: "first" }));
    await expect(
      store.playbooks.save(pb({ id: "p", version: 2, strategy: "second" })),
    ).rejects.toThrow(/already committed with different content/);
    expect((await store.playbooks.get("p"))?.strategy).toBe("first");
    store.close();
  });

  test("equal-version flat-playbook save with byte-identical content is idempotent", async () => {
    const store = createSqlitePlaybookStore({ path: dbPath });
    const p = pb({ id: "p", version: 2, strategy: "stable" });
    await store.playbooks.save(p);
    await store.playbooks.save(p);
    expect((await store.playbooks.get("p"))?.strategy).toBe("stable");
    store.close();
  });

  test("requires explicit path (no global default)", () => {
    // Regression: the store must not silently fall back to a home-directory
    // singleton that would bleed state across unrelated workspaces.
    expect(() => createSqlitePlaybookStore({ path: "" })).toThrow(/path is required/);
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

  test("remove preserves append-only audit history (rejects when proposals exist)", async () => {
    // remove() must NOT cascade through proposals/evaluations - that
    // would erase the audit trail for past promotions. Callers must
    // either retain the playbook (and its history) or perform explicit
    // operator surgery to purge.
    const store = createSqlitePlaybookStore({ path: dbPath });
    await store.structuredPlaybooks.save(spb({ id: "pb-A", version: 1 }));
    await store.proposals.recordProposal(makeProposal("p-1", "pb-A"));
    await store.proposals.recordEvaluation(makeEvaluation("e-1", "p-1"));
    await expect(store.structuredPlaybooks.remove("pb-A")).rejects.toThrow(/dependent proposal/);
    expect((await store.structuredPlaybooks.get("pb-A"))?.version).toBe(1);
    expect((await store.proposals.getProposal("p-1"))?.id).toBe("p-1");
    store.close();
  });

  test("remove is destructive (head + lineage cleared, matches in-memory baseline)", async () => {
    const store = createSqlitePlaybookStore({ path: dbPath });
    await store.structuredPlaybooks.save(spb({ id: "s1", version: 1, title: "v1" }));
    await store.structuredPlaybooks.save(spb({ id: "s1", version: 2, title: "v2" }));
    expect(await store.structuredPlaybooks.remove("s1")).toBe(true);
    expect(await store.structuredPlaybooks.get("s1")).toBeUndefined();
    // Hard-delete: lineage must be cleared too, so a removed playbook
    // cannot be silently resurrected via getVersion.
    expect(await store.structuredPlaybooks.getVersion("s1", 1)).toBeUndefined();
    expect(await store.structuredPlaybooks.getVersion("s1", 2)).toBeUndefined();
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

  test("empty append() makes session visible to listSessions and survives reopen", async () => {
    const store = createSqlitePlaybookStore({ path: dbPath });
    await store.trajectories.append("empty-s", []);
    const sessions = await store.trajectories.listSessions();
    expect(sessions).toContain("empty-s");
    store.close();
    const reopened = createSqlitePlaybookStore({ path: dbPath });
    expect(await reopened.trajectories.listSessions()).toContain("empty-s");
    expect(await reopened.trajectories.getSession("empty-s")).toEqual([]);
    reopened.close();
  });

  test("listSessions activity advances on every append (later append moves session forward)", async () => {
    const store = createSqlitePlaybookStore({ path: dbPath });
    await store.trajectories.append("a", [{ ...makeEntry(0, "x"), timestamp: 1000 }]);
    await store.trajectories.append("b", [{ ...makeEntry(0, "x"), timestamp: 2000 }]);
    expect(await store.trajectories.listSessions()).toEqual(["b", "a"]);
    // a now appends a fresher entry — must move ahead of b in recency order.
    await store.trajectories.append("a", [{ ...makeEntry(1, "y"), timestamp: 3000 }]);
    expect(await store.trajectories.listSessions()).toEqual(["a", "b"]);
    store.close();
  });

  test("listSessions stores BATCH MAX timestamp, not min (mixed-timestamp batch)", async () => {
    const store = createSqlitePlaybookStore({ path: dbPath });
    await store.trajectories.append("mixed", [
      { ...makeEntry(0, "x"), timestamp: 1000 },
      { ...makeEntry(1, "y"), timestamp: 3000 },
    ]);
    // Before cursor at 2500 must NOT include "mixed" — its last activity is 3000.
    expect(await store.trajectories.listSessions({ before: 2500 })).toEqual([]);
    // Before cursor at 3500 includes it (3000 < 3500).
    expect(await store.trajectories.listSessions({ before: 3500 })).toEqual(["mixed"]);
    store.close();
  });

  test("listSessions orders by created_at DESC and honors before cursor", async () => {
    const store = createSqlitePlaybookStore({ path: dbPath });
    await store.trajectories.append("old", [{ ...makeEntry(0, "x"), timestamp: 1000 }]);
    await store.trajectories.append("mid", [{ ...makeEntry(0, "x"), timestamp: 2000 }]);
    await store.trajectories.append("new", [{ ...makeEntry(0, "x"), timestamp: 3000 }]);
    expect(await store.trajectories.listSessions()).toEqual(["new", "mid", "old"]);
    expect(await store.trajectories.listSessions({ before: 2500 })).toEqual(["mid", "old"]);
    expect(await store.trajectories.listSessions({ before: 2500, limit: 1 })).toEqual(["mid"]);
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
    await seedAnchor(store, "pb-A");
    await seedAnchor(store, "pb-B");
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
    await seedAnchor(store, "pb-A");
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

describe("createSqlitePlaybookStore — schema migration v0 → v1", () => {
  test("rebuilds legacy playbook_evaluations table, drops orphans, dedupes by latest", async () => {
    // Seed a legacy DB: playbook_evaluations without UNIQUE(proposal_id) or FK,
    // user_version = 0. Mix of valid, duplicate, and orphan rows.
    const seed = new Database(dbPath, { create: true });
    seed.run("PRAGMA user_version = 0");
    seed.run(`
      CREATE TABLE playbook_proposals (
        id TEXT PRIMARY KEY, playbook_id TEXT NOT NULL, base_version INTEGER NOT NULL,
        operations TEXT NOT NULL, source_trajectory_range TEXT NOT NULL,
        reflection TEXT NOT NULL, created_at INTEGER NOT NULL
      )
    `);
    seed.run(`
      CREATE TABLE playbook_evaluations (
        id TEXT PRIMARY KEY, proposal_id TEXT NOT NULL, verdict TEXT NOT NULL,
        metrics TEXT NOT NULL, notes TEXT, evaluated_at INTEGER NOT NULL
      )
    `);
    // structured_playbook_versions row anchors the proposal so v3 doesn't
    // quarantine it.
    seed.run(`
      CREATE TABLE structured_playbook_versions (
        playbook_id TEXT NOT NULL, version INTEGER NOT NULL,
        snapshot TEXT NOT NULL, committed_at INTEGER NOT NULL,
        PRIMARY KEY (playbook_id, version)
      )
    `);
    seed.run("INSERT INTO structured_playbook_versions VALUES ('pb-A',1,'{}',0)");
    seed.run("INSERT INTO playbook_proposals VALUES ('p-1','pb-A',1,'[]','{}','{}',100)");
    // Valid winner — duplicate on proposal p-1 with later evaluated_at:
    seed.run("INSERT INTO playbook_evaluations VALUES ('e-old','p-1','reject','{}',NULL,100)");
    seed.run("INSERT INTO playbook_evaluations VALUES ('e-new','p-1','promote','{}',NULL,200)");
    // Orphan: references nonexistent proposal — must be dropped.
    seed.run(
      "INSERT INTO playbook_evaluations VALUES ('e-orphan','p-missing','promote','{}',NULL,50)",
    );
    seed.close();

    const migrated = createSqlitePlaybookStore({ path: dbPath });
    migrated.close();

    const after = new Database(dbPath, { readonly: true });
    const rows = after
      .query("SELECT id, proposal_id, verdict FROM playbook_evaluations")
      .all() as readonly { id: string; proposal_id: string; verdict: string }[];
    const userVersion = after.query("PRAGMA user_version").get() as { user_version: number };
    after.close();

    expect(userVersion.user_version).toBe(6);
    expect(rows.length).toBe(1);
    expect(rows[0]?.id).toBe("e-new");
    expect(rows[0]?.verdict).toBe("promote");
  });

  test("rebuild quarantines orphans + duplicates instead of deleting", async () => {
    const seed = new Database(dbPath, { create: true });
    seed.run("PRAGMA user_version = 0");
    seed.run(`
      CREATE TABLE playbook_proposals (
        id TEXT PRIMARY KEY, playbook_id TEXT NOT NULL, base_version INTEGER NOT NULL,
        operations TEXT NOT NULL, source_trajectory_range TEXT NOT NULL,
        reflection TEXT NOT NULL, created_at INTEGER NOT NULL
      )
    `);
    seed.run(`
      CREATE TABLE playbook_evaluations (
        id TEXT PRIMARY KEY, proposal_id TEXT NOT NULL, verdict TEXT NOT NULL,
        metrics TEXT NOT NULL, notes TEXT, evaluated_at INTEGER NOT NULL
      )
    `);
    seed.run("INSERT INTO playbook_proposals VALUES ('p-1','pb-A',1,'[]','{}','{}',100)");
    seed.run("INSERT INTO playbook_evaluations VALUES ('e-old','p-1','reject','{}',NULL,100)");
    seed.run("INSERT INTO playbook_evaluations VALUES ('e-new','p-1','promote','{}',NULL,200)");
    seed.run(
      "INSERT INTO playbook_evaluations VALUES ('e-orphan','p-missing','promote','{}',NULL,50)",
    );
    seed.close();

    const migrated = createSqlitePlaybookStore({ path: dbPath });
    migrated.close();

    const after = new Database(dbPath, { readonly: true });
    const quarantined = after
      .query("SELECT id, reason FROM playbook_evaluations_quarantine_v1 ORDER BY id")
      .all() as readonly { id: string; reason: string }[];
    after.close();

    expect(quarantined.length).toBe(2);
    expect(quarantined.find((q) => q.id === "e-orphan")?.reason).toContain("orphan");
    expect(quarantined.find((q) => q.id === "e-old")?.reason).toContain("duplicate");
  });

  test("partial-upgrade DB (UNIQUE but no FK) is detected and rebuilt", async () => {
    // Simulate a drifted DB: schema has UNIQUE(proposal_id) but no FK, and
    // user_version is still 0. The migration must NOT skip — it must rebuild
    // and add the FK before bumping user_version.
    const seed = new Database(dbPath, { create: true });
    seed.run("PRAGMA user_version = 0");
    seed.run(`
      CREATE TABLE playbook_proposals (
        id TEXT PRIMARY KEY, playbook_id TEXT NOT NULL, base_version INTEGER NOT NULL,
        operations TEXT NOT NULL, source_trajectory_range TEXT NOT NULL,
        reflection TEXT NOT NULL, created_at INTEGER NOT NULL
      )
    `);
    seed.run(`
      CREATE TABLE playbook_evaluations (
        id TEXT PRIMARY KEY,
        proposal_id TEXT NOT NULL UNIQUE,
        verdict TEXT NOT NULL, metrics TEXT NOT NULL,
        notes TEXT, evaluated_at INTEGER NOT NULL
      )
    `);
    seed.run("INSERT INTO playbook_proposals VALUES ('p-1','pb-A',1,'[]','{}','{}',100)");
    seed.run("INSERT INTO playbook_evaluations VALUES ('e-1','p-1','promote','{}',NULL,100)");
    seed.close();

    const migrated = createSqlitePlaybookStore({ path: dbPath });
    migrated.close();

    const after = new Database(dbPath, { readonly: true });
    const fks = after.query("PRAGMA foreign_key_list(playbook_evaluations)").all() as readonly {
      table: string;
      from: string;
    }[];
    after.close();
    // FK must now be present after migration.
    expect(fks.some((fk) => fk.table === "playbook_proposals" && fk.from === "proposal_id")).toBe(
      true,
    );
  });

  test("post-migration writes are constraint-enforced", async () => {
    const seed = new Database(dbPath, { create: true });
    seed.run("PRAGMA user_version = 0");
    seed.run(`
      CREATE TABLE playbook_evaluations (
        id TEXT PRIMARY KEY, proposal_id TEXT NOT NULL, verdict TEXT NOT NULL,
        metrics TEXT NOT NULL, notes TEXT, evaluated_at INTEGER NOT NULL
      )
    `);
    seed.close();

    const store = createSqlitePlaybookStore({ path: dbPath });
    await seedAnchor(store, "pb-A");
    await store.proposals.recordProposal(makeProposal("p-1", "pb-A"));
    await store.proposals.recordEvaluation(makeEvaluation("e-1", "p-1"));
    // Constraint must now fire on duplicate proposal_id from the migrated table.
    await expect(store.proposals.recordEvaluation(makeEvaluation("e-2", "p-1"))).rejects.toThrow();
    store.close();
  });

  test("v1 → v2 migration assigns per-session seq and preserves all rows", async () => {
    // Seed a v1 DB with the legacy trajectory_entries shape (PK on
    // session_id, turn_index, identifier). Two same-turn duplicate rows had to
    // have different identifiers under v1; migration must repack them under
    // (session_id, seq) without dropping any row.
    const seed = new Database(dbPath, { create: true });
    seed.run("PRAGMA user_version = 1");
    seed.run(`
      CREATE TABLE trajectory_entries (
        session_id  TEXT    NOT NULL,
        turn_index  INTEGER NOT NULL,
        timestamp   INTEGER NOT NULL,
        kind        TEXT    NOT NULL,
        identifier  TEXT    NOT NULL,
        outcome     TEXT    NOT NULL,
        duration_ms INTEGER NOT NULL,
        metadata    TEXT,
        bullet_ids  TEXT,
        PRIMARY KEY (session_id, turn_index, identifier)
      )
    `);
    seed.run(
      "INSERT INTO trajectory_entries VALUES ('s1', 0, 100, 'tool_call', 'fs.read.1', 'success', 5, NULL, NULL)",
    );
    seed.run(
      "INSERT INTO trajectory_entries VALUES ('s1', 0, 200, 'tool_call', 'fs.read.2', 'success', 7, NULL, NULL)",
    );
    seed.run(
      "INSERT INTO trajectory_entries VALUES ('s2', 0, 50, 'model_call', 'gpt', 'success', 3, NULL, NULL)",
    );
    seed.close();

    const migrated = createSqlitePlaybookStore({ path: dbPath });
    const back1 = await migrated.trajectories.getSession("s1");
    const back2 = await migrated.trajectories.getSession("s2");
    migrated.close();

    expect(back1.length).toBe(2);
    expect(back1.map((e) => e.identifier)).toEqual(["fs.read.1", "fs.read.2"]);
    expect(back2.length).toBe(1);

    const after = new Database(dbPath, { readonly: true });
    const seqRows = after
      .query("SELECT session_id, seq FROM trajectory_entries ORDER BY session_id, seq")
      .all() as readonly { session_id: string; seq: number }[];
    const userVersion = after.query("PRAGMA user_version").get() as { user_version: number };
    after.close();
    expect(userVersion.user_version).toBe(6);
    expect(seqRows.map((r) => `${r.session_id}:${String(r.seq)}`)).toEqual([
      "s1:1",
      "s1:2",
      "s2:1",
    ]);
  });

  test("v4 → v5 upgrade adds trajectory_sessions.created_at via ALTER", async () => {
    const seed = new Database(dbPath, { create: true });
    seed.run("CREATE TABLE trajectory_sessions (session_id TEXT PRIMARY KEY)");
    seed.run(
      "CREATE TABLE trajectory_entries (session_id TEXT, seq INTEGER, turn_index INTEGER, timestamp INTEGER, kind TEXT, identifier TEXT, outcome TEXT, duration_ms INTEGER, metadata TEXT, bullet_ids TEXT, PRIMARY KEY(session_id, seq))",
    );
    seed.run("INSERT INTO trajectory_sessions(session_id) VALUES ('legacy-empty')");
    seed.run(
      "INSERT INTO trajectory_entries(session_id, seq, turn_index, timestamp, kind, identifier, outcome, duration_ms) VALUES ('legacy-with-entries', 1, 0, 1234, 'tool_call', 'x', 'success', 5)",
    );
    seed.run("PRAGMA user_version = 4");
    seed.close();

    const upgraded = new Database(dbPath);
    const cols = upgraded.query("PRAGMA table_info(trajectory_sessions)").all() as readonly {
      readonly name: string;
    }[];
    upgraded.close();
    expect(cols.some((c) => c.name === "created_at")).toBe(false);

    const store = createSqlitePlaybookStore({ path: dbPath });
    const sessions = await store.trajectories.listSessions();
    expect(sessions).toContain("legacy-empty");
    expect(sessions).toContain("legacy-with-entries");
    store.close();
  });

  test("refuses to open database with user_version newer than CURRENT_SCHEMA_VERSION", () => {
    const seed = new Database(dbPath, { create: true });
    seed.run("PRAGMA user_version = 99");
    seed.close();
    expect(() => createSqlitePlaybookStore({ path: dbPath })).toThrow(
      /user_version 99 is newer than this binary/,
    );
  });

  test("drifted FK targeting wrong column is detected and rebuilt", async () => {
    // Simulate a drifted DB: schema declares FK from proposal_id but to the
    // wrong target column (verdict instead of id). The migration must detect
    // this via fk.to === 'id' check and rebuild before bumping user_version.
    const seed = new Database(dbPath, { create: true });
    seed.run("PRAGMA user_version = 0");
    seed.run(`
      CREATE TABLE playbook_proposals (
        id TEXT PRIMARY KEY, playbook_id TEXT NOT NULL, base_version INTEGER NOT NULL,
        operations TEXT NOT NULL, source_trajectory_range TEXT NOT NULL,
        reflection TEXT NOT NULL, created_at INTEGER NOT NULL,
        verdict TEXT
      )
    `);
    seed.run(`
      CREATE TABLE playbook_evaluations (
        id TEXT PRIMARY KEY,
        proposal_id TEXT NOT NULL UNIQUE
                    REFERENCES playbook_proposals(verdict),
        verdict TEXT NOT NULL, metrics TEXT NOT NULL,
        notes TEXT, evaluated_at INTEGER NOT NULL
      )
    `);
    seed.close();

    const migrated = createSqlitePlaybookStore({ path: dbPath });
    migrated.close();

    const after = new Database(dbPath, { readonly: true });
    const fks = after.query("PRAGMA foreign_key_list(playbook_evaluations)").all() as readonly {
      table: string;
      from: string;
      to: string;
    }[];
    after.close();
    expect(
      fks.some(
        (fk) => fk.table === "playbook_proposals" && fk.from === "proposal_id" && fk.to === "id",
      ),
    ).toBe(true);
  });

  test("v2 rebuilds drifted table that has seq column but legacy collapsing PK", async () => {
    // Regression: a partially-upgraded DB that grew a `seq` column but kept
    // PK (session_id, turn_index, identifier) must NOT be blessed as v2.
    // Same-turn replays would still collide on the legacy PK.
    const seed = new Database(dbPath, { create: true });
    seed.run("PRAGMA user_version = 1");
    seed.run(`
      CREATE TABLE trajectory_entries (
        session_id  TEXT    NOT NULL,
        seq         INTEGER NOT NULL,
        turn_index  INTEGER NOT NULL,
        timestamp   INTEGER NOT NULL,
        kind        TEXT    NOT NULL,
        identifier  TEXT    NOT NULL,
        outcome     TEXT    NOT NULL,
        duration_ms INTEGER NOT NULL,
        metadata    TEXT,
        bullet_ids  TEXT,
        PRIMARY KEY (session_id, turn_index, identifier)
      )
    `);
    seed.run(
      "INSERT INTO trajectory_entries VALUES ('s1', 1, 0, 100, 'tool_call', 'fs.read', 'success', 5, NULL, NULL)",
    );
    seed.close();

    const migrated = createSqlitePlaybookStore({ path: dbPath });
    // Append two same-(turn, identifier) rows; legacy PK would have rejected
    // the second. Migrated v2 PK accepts both.
    await migrated.trajectories.append("s1", [
      { ...makeEntry(0, "fs.read"), timestamp: 200 },
      { ...makeEntry(0, "fs.read"), timestamp: 300 },
    ]);
    const back = await migrated.trajectories.getSession("s1");
    migrated.close();
    expect(back.length).toBe(3);
    expect(back.map((e) => e.timestamp)).toEqual([100, 200, 300]);
  });

  test("v3 detects FK with swapped target columns and rebuilds", async () => {
    // Regression: the v3 satisfaction check must verify the full composite
    // FK shape (playbook_id → playbook_id, base_version → version), not
    // just that both columns appear somewhere in some FK row. A drifted
    // schema with swapped target columns is broken and must be rebuilt.
    const seed = new Database(dbPath, { create: true });
    seed.run("PRAGMA user_version = 0");
    seed.run(`
      CREATE TABLE structured_playbook_versions (
        playbook_id TEXT NOT NULL, version INTEGER NOT NULL,
        snapshot TEXT NOT NULL, committed_at INTEGER NOT NULL,
        PRIMARY KEY (playbook_id, version)
      )
    `);
    // Drifted FK: playbook_id → version (wrong), base_version → playbook_id (wrong).
    seed.run(`
      CREATE TABLE playbook_proposals (
        id TEXT PRIMARY KEY, playbook_id TEXT NOT NULL, base_version INTEGER NOT NULL,
        operations TEXT NOT NULL, source_trajectory_range TEXT NOT NULL,
        reflection TEXT NOT NULL, created_at INTEGER NOT NULL,
        FOREIGN KEY (playbook_id, base_version)
          REFERENCES structured_playbook_versions(version, playbook_id)
      )
    `);
    seed.close();

    const migrated = createSqlitePlaybookStore({ path: dbPath });
    migrated.close();

    const after = new Database(dbPath, { readonly: true });
    const fks = after.query("PRAGMA foreign_key_list(playbook_proposals)").all() as readonly {
      table: string;
      from: string;
      to: string;
    }[];
    after.close();
    // After rebuild the FK must have the correct shape.
    const correctFk = fks.filter((fk) => fk.table === "structured_playbook_versions");
    expect(correctFk.find((fk) => fk.from === "playbook_id")?.to).toBe("playbook_id");
    expect(correctFk.find((fk) => fk.from === "base_version")?.to).toBe("version");
  });

  test("v3 quarantines evaluations attached to orphaned proposals (no audit loss)", async () => {
    // Seed a v0 DB with a proposal whose anchor (pb-X, 1) does NOT exist in
    // structured_playbook_versions, plus an evaluation attached to it. After
    // v3 migration both must be quarantined — neither is silently dropped.
    const seed = new Database(dbPath, { create: true });
    seed.run("PRAGMA user_version = 0");
    seed.run(`
      CREATE TABLE structured_playbook_versions (
        playbook_id TEXT NOT NULL, version INTEGER NOT NULL,
        snapshot TEXT NOT NULL, committed_at INTEGER NOT NULL,
        PRIMARY KEY (playbook_id, version)
      )
    `);
    seed.run(`
      CREATE TABLE playbook_proposals (
        id TEXT PRIMARY KEY, playbook_id TEXT NOT NULL, base_version INTEGER NOT NULL,
        operations TEXT NOT NULL, source_trajectory_range TEXT NOT NULL,
        reflection TEXT NOT NULL, created_at INTEGER NOT NULL
      )
    `);
    seed.run(`
      CREATE TABLE playbook_evaluations (
        id TEXT PRIMARY KEY, proposal_id TEXT NOT NULL, verdict TEXT NOT NULL,
        metrics TEXT NOT NULL, notes TEXT, evaluated_at INTEGER NOT NULL
      )
    `);
    seed.run("INSERT INTO playbook_proposals VALUES ('p-orph','pb-X',1,'[]','{}','{}',100)");
    seed.run("INSERT INTO playbook_evaluations VALUES ('e-orph','p-orph','promote','{}',NULL,200)");
    seed.close();

    const migrated = createSqlitePlaybookStore({ path: dbPath });
    migrated.close();

    const after = new Database(dbPath, { readonly: true });
    const qProps = after
      .query("SELECT id, reason FROM playbook_proposals_quarantine_v3")
      .all() as readonly { id: string; reason: string }[];
    const qEvals = after
      .query("SELECT id, reason FROM playbook_evaluations_quarantine_v3")
      .all() as readonly { id: string; reason: string }[];
    after.close();
    expect(qProps.find((q) => q.id === "p-orph")).toBeDefined();
    expect(qEvals.find((q) => q.id === "e-orph")?.reason).toContain("proposal quarantined");
  });

  test("v2 trajectory migration preserves legacy insertion order (rowid, not identifier)", async () => {
    // Two same-turn rows whose alphabetic identifier order DIFFERS from
    // their original insertion order. The migration must use rowid (i.e.
    // append order) to assign seq, otherwise replay sees fabricated order.
    const seed = new Database(dbPath, { create: true });
    seed.run("PRAGMA user_version = 1");
    seed.run(`
      CREATE TABLE trajectory_entries (
        session_id  TEXT    NOT NULL,
        turn_index  INTEGER NOT NULL,
        timestamp   INTEGER NOT NULL,
        kind        TEXT    NOT NULL,
        identifier  TEXT    NOT NULL,
        outcome     TEXT    NOT NULL,
        duration_ms INTEGER NOT NULL,
        metadata    TEXT,
        bullet_ids  TEXT,
        PRIMARY KEY (session_id, turn_index, identifier)
      )
    `);
    // Insert "z" before "a" — identifier ASC would scramble this order.
    seed.run(
      "INSERT INTO trajectory_entries VALUES ('s1', 0, 100, 'tool_call', 'z.first', 'success', 5, NULL, NULL)",
    );
    seed.run(
      "INSERT INTO trajectory_entries VALUES ('s1', 0, 200, 'tool_call', 'a.second', 'success', 7, NULL, NULL)",
    );
    seed.close();

    const migrated = createSqlitePlaybookStore({ path: dbPath });
    const back = await migrated.trajectories.getSession("s1");
    migrated.close();
    expect(back.map((e) => e.identifier)).toEqual(["z.first", "a.second"]);
  });
});

describe("createSqlitePlaybookStore — evaluation lineage integrity", () => {
  test("recordEvaluation rejects orphan evaluation (no matching proposal)", async () => {
    const store = createSqlitePlaybookStore({ path: dbPath });
    await expect(
      store.proposals.recordEvaluation(makeEvaluation("e-1", "nonexistent")),
    ).rejects.toThrow();
    store.close();
  });

  test("recordEvaluation rejects second evaluation for same proposal", async () => {
    const store = createSqlitePlaybookStore({ path: dbPath });
    await seedAnchor(store, "pb-A");
    await store.proposals.recordProposal(makeProposal("p-1", "pb-A"));
    await store.proposals.recordEvaluation(makeEvaluation("e-1", "p-1"));
    // Different id, same proposal_id, different verdict — must reject.
    await expect(
      store.proposals.recordEvaluation({
        ...makeEvaluation("e-2", "p-1"),
        verdict: "reject",
      }),
    ).rejects.toThrow();
    store.close();
  });
});

describe("createSqlitePlaybookStore — head-row self-heal", () => {
  test("self-heal cannot regress head to a stale lineage version", async () => {
    const store = createSqlitePlaybookStore({ path: dbPath });
    const v1 = spb({ id: "s1", version: 1, title: "v1" });
    await store.structuredPlaybooks.save(v1);
    await store.structuredPlaybooks.save(spb({ id: "s1", version: 2, title: "v2" }));
    store.close();

    // Simulate partial corruption: head row missing, lineage intact at v2.
    const corrupt = new Database(dbPath);
    corrupt.run("DELETE FROM structured_playbooks WHERE id = ?", ["s1"]);
    corrupt.close();

    const repaired = createSqlitePlaybookStore({ path: dbPath });
    // Stale worker retries v1 — must throw (effectiveHead is v2 from lineage),
    // not silently rebuild head as v1 and hide v2.
    await expect(repaired.structuredPlaybooks.save(v1)).rejects.toThrow();
    repaired.close();
  });

  test("stray higher lineage row cannot fast-forward head past its monotonic position", async () => {
    // Regression: head at v2 (healthy), but a stray v10 row exists in
    // lineage from corruption/manual repair. A caller retrying v10 must
    // NOT promote that lineage row back into the visible head — self-heal
    // is restricted to the missing-head case. Either the stray content
    // differs from the caller payload (rejected as "different content")
    // or matches it (treated as no-op for the lineage row).
    const store = createSqlitePlaybookStore({ path: dbPath });
    await store.structuredPlaybooks.save(spb({ id: "s1", version: 1, title: "v1" }));
    await store.structuredPlaybooks.save(spb({ id: "s1", version: 2, title: "v2" }));
    store.close();

    // Inject a stray v10 lineage row with content "rogue".
    const corrupt = new Database(dbPath);
    const rogueSnapshot = JSON.stringify(spb({ id: "s1", version: 10, title: "rogue" }));
    corrupt.run(
      "INSERT INTO structured_playbook_versions (playbook_id, version, snapshot, committed_at) VALUES (?, ?, ?, ?)",
      ["s1", 10, rogueSnapshot, 0],
    );
    corrupt.close();

    const reopened = createSqlitePlaybookStore({ path: dbPath });
    // Caller retries v10 with DIFFERENT content — must be rejected, not
    // silently fast-forwarded.
    await expect(
      reopened.structuredPlaybooks.save(spb({ id: "s1", version: 10, title: "different" })),
    ).rejects.toThrow(/different content/);
    // Head still at v2.
    expect((await reopened.structuredPlaybooks.get("s1"))?.version).toBe(2);
    expect((await reopened.structuredPlaybooks.get("s1"))?.title).toBe("v2");
    reopened.close();
  });

  test("idempotent retry repairs stale head row when lineage matches caller content", async () => {
    // Regression: head row at v1 has STALE content (corrupted by manual
    // repair / drift), lineage v1 matches what caller is committing.
    // Idempotent retry must repair the head, not silently leave bad
    // content behind.
    const store = createSqlitePlaybookStore({ path: dbPath });
    await store.structuredPlaybooks.save(spb({ id: "s1", version: 1, title: "real" }));
    store.close();

    // Corrupt the head row to "tampered" while lineage v1 keeps "real".
    const corrupt = new Database(dbPath);
    corrupt.run("UPDATE structured_playbooks SET title = ? WHERE id = ?", ["tampered", "s1"]);
    corrupt.close();

    const repaired = createSqlitePlaybookStore({ path: dbPath });
    expect((await repaired.structuredPlaybooks.get("s1"))?.title).toBe("tampered");
    // Idempotent retry of "real" must rebuild head from lineage.
    await repaired.structuredPlaybooks.save(spb({ id: "s1", version: 1, title: "real" }));
    expect((await repaired.structuredPlaybooks.get("s1"))?.title).toBe("real");
    repaired.close();
  });

  test("remove returns true when only lineage existed (head was missing)", async () => {
    // Regression: in the corrupted state where the head row is gone but
    // lineage rows remain, remove() must report true (something was
    // destroyed) rather than false (which falsely implies no-op).
    const store = createSqlitePlaybookStore({ path: dbPath });
    await store.structuredPlaybooks.save(spb({ id: "s1", version: 1 }));
    await store.structuredPlaybooks.save(spb({ id: "s1", version: 2 }));
    store.close();

    const corrupt = new Database(dbPath);
    corrupt.run("DELETE FROM structured_playbooks WHERE id = ?", ["s1"]);
    corrupt.close();

    const repaired = createSqlitePlaybookStore({ path: dbPath });
    expect(await repaired.structuredPlaybooks.remove("s1")).toBe(true);
    expect(await repaired.structuredPlaybooks.getVersion("s1", 1)).toBeUndefined();
    expect(await repaired.structuredPlaybooks.getVersion("s1", 2)).toBeUndefined();
    repaired.close();
  });

  test("forward save after head loss clamps watermark against latest lineage snapshot", async () => {
    // Regression: when current is null but lineage has a row with a high
    // watermark, a forward save with a lower watermark must NOT downgrade
    // — otherwise ACE would reopen already-reflected trajectory windows.
    const store = createSqlitePlaybookStore({ path: dbPath });
    await store.structuredPlaybooks.save(
      spb({ id: "s1", version: 1, lastReflectedStepIndex: 100, title: "v1" }),
    );
    store.close();

    // Head row gone, lineage v1 still has watermark=100.
    const corrupt = new Database(dbPath);
    corrupt.run("DELETE FROM structured_playbooks WHERE id = ?", ["s1"]);
    corrupt.close();

    const repaired = createSqlitePlaybookStore({ path: dbPath });
    // Forward save at v2 with a low watermark — must clamp against
    // lineage's 100, not silently downgrade to 5.
    await repaired.structuredPlaybooks.save(
      spb({ id: "s1", version: 2, lastReflectedStepIndex: 5, title: "v2" }),
    );
    expect((await repaired.structuredPlaybooks.get("s1"))?.lastReflectedStepIndex).toBe(100);
    repaired.close();
  });

  test("self-heal rejects conflicting payload when head is missing (no silent lost-update)", async () => {
    // Regression: when lineage has v=N and the head row is missing,
    // submitting a DIFFERENT payload at v=N must throw, not silently
    // restore the stored snapshot and report success. The watermark and
    // provenance.committedAt are server-normalized so they are stripped
    // from the comparison, but caller-controlled fields (title, sections,
    // etc.) must match.
    const store = createSqlitePlaybookStore({ path: dbPath });
    await store.structuredPlaybooks.save(spb({ id: "s1", version: 1, title: "real" }));
    store.close();

    // Drop head row but keep lineage.
    const corrupt = new Database(dbPath);
    corrupt.run("DELETE FROM structured_playbooks WHERE id = ?", ["s1"]);
    corrupt.close();

    const repaired = createSqlitePlaybookStore({ path: dbPath });
    await expect(
      repaired.structuredPlaybooks.save(spb({ id: "s1", version: 1, title: "tampered" })),
    ).rejects.toThrow(/different content/);
    expect(await repaired.structuredPlaybooks.get("s1")).toBeUndefined();
    repaired.close();
  });

  test("same-version idempotent retry promotes watermark in head WITHOUT mutating lineage snapshot", async () => {
    const store = createSqlitePlaybookStore({ path: dbPath });
    await store.structuredPlaybooks.save(
      spb({ id: "s1", version: 1, lastReflectedStepIndex: 20, title: "v1" }),
    );
    await store.structuredPlaybooks.save(
      spb({ id: "s1", version: 1, lastReflectedStepIndex: 100, title: "v1" }),
    );
    expect((await store.structuredPlaybooks.get("s1"))?.lastReflectedStepIndex).toBe(100);
    store.close();
    // Lineage snapshot at v1 must remain immutable: the promotion lives only
    // in the mutable head row. Reading the raw stored snapshot must show the
    // ORIGINAL committed watermark (20), not the promoted value (100).
    const audit = new Database(dbPath);
    const row = audit
      .query(
        "SELECT snapshot FROM structured_playbook_versions WHERE playbook_id = 's1' AND version = 1",
      )
      .get() as { readonly snapshot: string };
    audit.close();
    const stored = JSON.parse(row.snapshot) as { lastReflectedStepIndex?: number };
    expect(stored.lastReflectedStepIndex).toBe(20);
  });

  test("same-version idempotent retry promotes higher lastReflectedStepIndex", async () => {
    const store = createSqlitePlaybookStore({ path: dbPath });
    await store.structuredPlaybooks.save(
      spb({ id: "s1", version: 1, lastReflectedStepIndex: 20, title: "v1" }),
    );
    // Second writer derives same v1 content but observed steps through 100.
    // Idempotent retry must not silently drop the higher progress marker.
    await store.structuredPlaybooks.save(
      spb({ id: "s1", version: 1, lastReflectedStepIndex: 100, title: "v1" }),
    );
    expect((await store.structuredPlaybooks.get("s1"))?.lastReflectedStepIndex).toBe(100);
    store.close();
  });

  test("promoted watermark survives head row loss via watermarks table", async () => {
    const store = createSqlitePlaybookStore({ path: dbPath });
    // Initial save at v1 with watermark 20.
    await store.structuredPlaybooks.save(
      spb({ id: "s1", version: 1, lastReflectedStepIndex: 20, title: "v1" }),
    );
    // Idempotent retry promotes watermark to 100 (lineage snapshot still
    // records 20 because lineage is immutable).
    await store.structuredPlaybooks.save(
      spb({ id: "s1", version: 1, lastReflectedStepIndex: 100, title: "v1" }),
    );
    expect((await store.structuredPlaybooks.get("s1"))?.lastReflectedStepIndex).toBe(100);
    store.close();
    // Simulate partial corruption: head row missing, lineage intact.
    const surgery = new Database(dbPath);
    surgery.run("DELETE FROM structured_playbooks WHERE id = 's1'");
    surgery.close();
    const repaired = createSqlitePlaybookStore({ path: dbPath });
    // A forward save at v2 with NO watermark must clamp against the
    // PROMOTED value (100) from the watermarks table — not the stale
    // value (20) from the lineage snapshot.
    await repaired.structuredPlaybooks.save(spb({ id: "s1", version: 2, title: "v2" }));
    expect((await repaired.structuredPlaybooks.get("s1"))?.lastReflectedStepIndex).toBe(100);
    repaired.close();
  });

  test("self-heal rebuilds head from stored snapshot after watermark was clamped", async () => {
    // Regression: when an earlier save server-clamped lastReflectedStepIndex
    // upward, the canonical stored snapshot has a watermark the caller can
    // no longer reproduce by re-normalizing against a missing head row.
    // Self-heal must rebuild from the STORED snapshot, not the caller
    // payload, so recovery succeeds even when the original payload's
    // watermark was below the persisted clamp.
    const store = createSqlitePlaybookStore({ path: dbPath });
    // First save establishes a high watermark.
    await store.structuredPlaybooks.save(
      spb({ id: "s1", version: 1, lastReflectedStepIndex: 100, title: "v1" }),
    );
    // Second save at v2 with a LOW watermark — server clamps to max(100, 5) = 100.
    const lowWatermark = spb({
      id: "s1",
      version: 2,
      lastReflectedStepIndex: 5,
      title: "v2",
    });
    await store.structuredPlaybooks.save(lowWatermark);
    expect((await store.structuredPlaybooks.get("s1"))?.lastReflectedStepIndex).toBe(100);
    store.close();

    // Simulate corruption: drop the head row. Lineage v2 still has
    // watermark=100 (server-clamped); caller's payload has watermark=5.
    const corrupt = new Database(dbPath);
    corrupt.run("DELETE FROM structured_playbooks WHERE id = ?", ["s1"]);
    corrupt.close();

    const repaired = createSqlitePlaybookStore({ path: dbPath });
    // Idempotent retry of the original low-watermark payload must self-heal
    // from the stored snapshot, NOT throw "different content".
    await repaired.structuredPlaybooks.save(lowWatermark);
    const restored = await repaired.structuredPlaybooks.get("s1");
    expect(restored?.lastReflectedStepIndex).toBe(100);
    expect(restored?.version).toBe(2);
    repaired.close();
  });

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

  test("stray higher lineage row does not block writes against live head", async () => {
    // Regression: a single stray higher version in lineage (from manual
    // repair, historical corruption, or a prior bug) must not wedge healthy
    // writes forever. The live head pointer is authoritative; lineage MAX is
    // only consulted as fallback when the head row is missing.
    const store = createSqlitePlaybookStore({ path: dbPath });
    await store.structuredPlaybooks.save(spb({ id: "s1", version: 1, title: "v1" }));
    await store.structuredPlaybooks.save(spb({ id: "s1", version: 2, title: "v2" }));
    store.close();

    // Inject a stray v100 lineage row, leaving head at v2.
    const corrupt = new Database(dbPath);
    corrupt.run(
      "INSERT INTO structured_playbook_versions (playbook_id, version, snapshot, committed_at) VALUES (?, ?, ?, ?)",
      ["s1", 100, '{"orphaned":true}', 0],
    );
    corrupt.close();

    const reopened = createSqlitePlaybookStore({ path: dbPath });
    // Save at v3 must succeed (head=2 < 3), not be wedged behind stray v100.
    await reopened.structuredPlaybooks.save(spb({ id: "s1", version: 3, title: "v3" }));
    expect((await reopened.structuredPlaybooks.get("s1"))?.version).toBe(3);
    reopened.close();
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
    await seedAnchor(store, "pb-A");
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

  test("trajectory preserves repeated same-tool calls within a single turn", async () => {
    // Regression: ACE records multiple `fs.read` calls in turn 0 with the same
    // (turnIndex, identifier). The legacy PK collapsed them into one row;
    // each call must round-trip as a distinct entry.
    const store = createSqlitePlaybookStore({ path: dbPath });
    await store.trajectories.append("s1", [
      { ...makeEntry(0, "fs.read"), timestamp: 100, durationMs: 5 },
      { ...makeEntry(0, "fs.read"), timestamp: 200, durationMs: 7 },
      { ...makeEntry(0, "fs.read"), timestamp: 300, durationMs: 9 },
    ]);
    const back = await store.trajectories.getSession("s1");
    expect(back.length).toBe(3);
    expect(back.map((e) => e.timestamp)).toEqual([100, 200, 300]);
    expect(back.map((e) => e.durationMs)).toEqual([5, 7, 9]);
    store.close();
  });

  test("trajectory append preserves write order across batches", async () => {
    const store = createSqlitePlaybookStore({ path: dbPath });
    await store.trajectories.append("s1", [makeEntry(0, "x"), makeEntry(1, "y")]);
    await store.trajectories.append("s1", [makeEntry(2, "z")]);
    const back = await store.trajectories.getSession("s1");
    expect(back.map((e) => e.identifier)).toEqual(["x", "y", "z"]);
    store.close();
  });

  test("trajectory append persists legitimate identical-content repeats", async () => {
    // Regression: append is NOT idempotent — a legitimate second batch with
    // identical contents must persist as additional rows. Caller-side retry
    // dedup is the caller's responsibility.
    const store = createSqlitePlaybookStore({ path: dbPath });
    const batch = [makeEntry(0, "x"), makeEntry(1, "y")];
    await store.trajectories.append("s1", batch);
    await store.trajectories.append("s1", batch);
    const back = await store.trajectories.getSession("s1");
    expect(back.length).toBe(4);
    expect(back.map((e) => e.identifier)).toEqual(["x", "y", "x", "y"]);
    store.close();
  });

  test("recordProposal rejects ancestry on nonexistent playbook version", async () => {
    // Regression: a proposal can't claim to be derived from a playbook
    // version that was never committed. Composite FK enforces this.
    const store = createSqlitePlaybookStore({ path: dbPath });
    await expect(
      store.proposals.recordProposal(makeProposal("p-1", "pb-missing")),
    ).rejects.toThrow();
    store.close();
  });

  test("recordProposal rejects duplicate id with different content", async () => {
    const store = createSqlitePlaybookStore({ path: dbPath });
    await seedAnchor(store, "pb-A");
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

  test("recordProposal rejects baseVersion below current head after head advances", async () => {
    const store = createSqlitePlaybookStore({ path: dbPath });
    await seedAnchor(store, "pb-A", 1);
    await store.structuredPlaybooks.save(spb({ id: "pb-A", version: 2 }));
    await expect(
      store.proposals.recordProposal({
        ...makeProposal("p-stale", "pb-A"),
        baseVersion: 1,
      }),
    ).rejects.toThrow(/does not match current head/);
    store.close();
  });

  test("recordProposal accepts baseVersion against lineage MAX when head row is missing", async () => {
    const store = createSqlitePlaybookStore({ path: dbPath });
    await seedAnchor(store, "pb-A", 1);
    store.close();
    // Simulate partial corruption: head row gone but lineage intact.
    const surgery = new Database(dbPath);
    surgery.exec("DELETE FROM structured_playbooks WHERE id = 'pb-A'");
    surgery.close();
    const reopened = createSqlitePlaybookStore({ path: dbPath });
    await reopened.proposals.recordProposal(makeProposal("p-1", "pb-A"));
    expect((await reopened.proposals.getProposal("p-1"))?.baseVersion).toBe(1);
    reopened.close();
  });

  test("recordProposal accepts byte-identical idempotent retry", async () => {
    const store = createSqlitePlaybookStore({ path: dbPath });
    await seedAnchor(store, "pb-A");
    const p = makeProposal("p-1", "pb-A");
    await store.proposals.recordProposal(p);
    await store.proposals.recordProposal(p);
    expect((await store.proposals.listProposals("pb-A")).length).toBe(1);
    store.close();
  });

  test("recordEvaluation rejects duplicate id with different verdict", async () => {
    const store = createSqlitePlaybookStore({ path: dbPath });
    await seedAnchor(store, "pb-A");
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
    await seedAnchor(w, "pb1");
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

  test("concurrent writers from two handles do not fail with SQLITE_BUSY", async () => {
    // Regression: SQLite's default busy_timeout is 0. Without the pragma,
    // a second writer touching the file during another writer's transaction
    // fails immediately. With our pragma, it should wait and succeed.
    const a = createSqlitePlaybookStore({ path: dbPath });
    const b = createSqlitePlaybookStore({ path: dbPath });
    // Two simultaneous saves on different ids — no contention on rows, but
    // they contend on the WAL write lock. Without busy_timeout one of these
    // would race-fail; both should succeed.
    await Promise.all([
      a.playbooks.save(pb({ id: "p-a", strategy: "a" })),
      b.playbooks.save(pb({ id: "p-b", strategy: "b" })),
    ]);
    expect((await a.playbooks.list()).map((p) => p.id).sort()).toEqual(["p-a", "p-b"]);
    a.close();
    b.close();
  });
});
