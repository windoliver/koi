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
