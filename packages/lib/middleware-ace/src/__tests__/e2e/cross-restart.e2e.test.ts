/**
 * E2E: ACE promotion gate behavior across actual sqlite process boundaries.
 *
 * These tests open a real on-disk sqlite file, close it (simulating a
 * process restart), and reopen it. They exercise corner cases that pure
 * in-memory tests cannot reach:
 *  - Cross-session watermark preservation across restart
 *  - Idempotent commit retry with mutated payload (after restart)
 *  - Rollback retry with different targetVersion (after restart)
 *  - Schema migration: open a v7-shaped DB and verify v8 add-column works
 */

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  PlaybookEvaluation,
  PlaybookProposal,
  PromotionThresholds,
  StructuredPlaybook,
} from "@koi/ace-types";
import { createSqlitePlaybookStore } from "@koi/playbook-store-sqlite";

import { commitPromotion, rollbackPromotion } from "../../promotion-gate.js";

const PB_ID = "spb-e2e";

const thresholds: PromotionThresholds = {
  minHelpfulRate: 0.5,
  maxHarmfulRate: 0.5,
  minTrials: 1,
};

function seed(overrides: Partial<StructuredPlaybook> = {}): StructuredPlaybook {
  return {
    id: PB_ID,
    title: "v",
    sections: [
      {
        name: "Existing",
        slug: "existing",
        bullets: [
          { id: "b1", content: "first", helpful: 1, harmful: 0, createdAt: 0, updatedAt: 0 },
        ],
      },
    ],
    tags: [],
    source: "curated",
    createdAt: 0,
    updatedAt: 0,
    sessionCount: 0,
    version: 1,
    ...overrides,
  };
}

function proposal(overrides: Partial<PlaybookProposal> = {}): PlaybookProposal {
  return {
    id: "p-e2e",
    playbookId: PB_ID,
    baseVersion: 1,
    operations: [{ kind: "add", section: "Existing", content: "insight" }],
    sourceTrajectoryRange: { sessionId: "sess", fromStepIndex: 0, toStepIndex: 1 },
    reflection: { rootCause: "rc", keyInsight: "ki", bulletTags: [] },
    createdAt: 0,
    ...overrides,
  };
}

function evaluation(overrides: Partial<PlaybookEvaluation> = {}): PlaybookEvaluation {
  return {
    id: "e-e2e",
    proposalId: "p-e2e",
    verdict: "promote",
    metrics: { helpfulRate: 0.9, harmfulRate: 0.0, trials: 5 },
    evaluatedAt: 1,
    ...overrides,
  };
}

function withTmpDb<T>(fn: (path: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "ace-e2e-"));
  const path = join(dir, "ace.sqlite");
  return fn(path).finally(() => {
    rmSync(dir, { recursive: true, force: true });
  });
}

describe("ACE e2e: cross-restart sqlite scenarios", () => {
  test("D: per-session watermarks survive process restart and alternating sessions", async () => {
    await withTmpDb(async (path) => {
      // Phase 1: session A commits range [0, 6)
      let store = createSqlitePlaybookStore({ path });
      await store.structuredPlaybooks.save(seed());
      const pA1 = proposal({
        id: "p-A1",
        baseVersion: 1,
        sourceTrajectoryRange: { sessionId: "A", fromStepIndex: 0, toStepIndex: 6 },
      });
      const eA1 = evaluation({ id: "e-A1", proposalId: "p-A1" });
      await store.proposals.recordProposal(pA1);
      await commitPromotion(
        { structuredStore: store.structuredPlaybooks, proposalStore: store.proposals },
        pA1,
        eA1,
        thresholds,
      );
      store.close();

      // Phase 2: restart, session B commits range [0, 3)
      store = createSqlitePlaybookStore({ path });
      const head1 = await store.structuredPlaybooks.get(PB_ID);
      expect(head1?.reflectedStepIndexBySession?.A).toBe(5);
      expect(head1?.lastReflectedStepIndex).toBe(5);

      const pB = proposal({
        id: "p-B1",
        baseVersion: 2,
        sourceTrajectoryRange: { sessionId: "B", fromStepIndex: 0, toStepIndex: 3 },
      });
      const eB = evaluation({ id: "e-B1", proposalId: "p-B1" });
      await store.proposals.recordProposal(pB);
      await commitPromotion(
        { structuredStore: store.structuredPlaybooks, proposalStore: store.proposals },
        pB,
        eB,
        thresholds,
      );
      store.close();

      // Phase 3: restart, session A resumes at its real position
      store = createSqlitePlaybookStore({ path });
      const head2 = await store.structuredPlaybooks.get(PB_ID);
      expect(head2?.reflectedStepIndexBySession).toEqual({ A: 5, B: 2 });

      const pA2 = proposal({
        id: "p-A2",
        baseVersion: 3,
        sourceTrajectoryRange: { sessionId: "A", fromStepIndex: 6, toStepIndex: 8 },
      });
      const eA2 = evaluation({ id: "e-A2", proposalId: "p-A2" });
      await store.proposals.recordProposal(pA2);
      await commitPromotion(
        { structuredStore: store.structuredPlaybooks, proposalStore: store.proposals },
        pA2,
        eA2,
        thresholds,
      );

      const final = await store.structuredPlaybooks.get(PB_ID);
      expect(final?.reflectedStepIndexBySession).toEqual({ A: 7, B: 2 });
      expect(final?.lastReflectedStepIndex).toBe(7);
      store.close();
    });
  });

  test("C: idempotent commit retry with mutated payload after restart is rejected", async () => {
    await withTmpDb(async (path) => {
      // Phase 1: pre-record proposal, then commit successfully
      let store = createSqlitePlaybookStore({ path });
      await store.structuredPlaybooks.save(seed());
      const p = proposal();
      const e = evaluation();
      await store.proposals.recordProposal(p);
      await commitPromotion(
        { structuredStore: store.structuredPlaybooks, proposalStore: store.proposals },
        p,
        e,
        thresholds,
      );
      store.close();

      // Phase 2: restart, retry commit with SAME ids but MUTATED operations
      store = createSqlitePlaybookStore({ path });
      const mutated = proposal({
        operations: [{ kind: "add", section: "Existing", content: "DIFFERENT content" }],
      });
      await expect(
        commitPromotion(
          { structuredStore: store.structuredPlaybooks, proposalStore: store.proposals },
          mutated,
          e,
          thresholds,
        ),
      ).rejects.toThrow(/persisted payload differs/);

      // Head version unchanged after rejection
      const head = await store.structuredPlaybooks.get(PB_ID);
      expect(head?.version).toBe(2);
      store.close();
    });
  });

  test("C': byte-identical retry across restart returns idempotent success", async () => {
    await withTmpDb(async (path) => {
      let store = createSqlitePlaybookStore({ path });
      await store.structuredPlaybooks.save(seed());
      const p = proposal();
      const e = evaluation();
      await store.proposals.recordProposal(p);
      await commitPromotion(
        { structuredStore: store.structuredPlaybooks, proposalStore: store.proposals },
        p,
        e,
        thresholds,
      );
      store.close();

      // Restart, retry with byte-identical payload
      store = createSqlitePlaybookStore({ path });
      const result = await commitPromotion(
        { structuredStore: store.structuredPlaybooks, proposalStore: store.proposals },
        p,
        e,
        thresholds,
      );
      expect(result.outcome).toBe("promoted");
      expect(result.toVersion).toBe(2);

      const head = await store.structuredPlaybooks.get(PB_ID);
      expect(head?.version).toBe(2); // No double-bump
      store.close();
    });
  });

  test("G: rollback retry naming a different targetVersion is rejected", async () => {
    await withTmpDb(async (path) => {
      let store = createSqlitePlaybookStore({ path });

      // Build version history: v1 (seed) → v2 → v3 → rollback to v1 (head=v4)
      await store.structuredPlaybooks.save(seed());
      // Commit p1 to advance to v2
      const p1 = proposal({ id: "p-1", baseVersion: 1 });
      const e1 = evaluation({ id: "e-1", proposalId: "p-1" });
      await store.proposals.recordProposal(p1);
      await commitPromotion(
        { structuredStore: store.structuredPlaybooks, proposalStore: store.proposals },
        p1,
        e1,
        thresholds,
      );
      // Commit p2 to advance to v3
      const p2 = proposal({ id: "p-2", baseVersion: 2 });
      const e2 = evaluation({ id: "e-2", proposalId: "p-2" });
      await store.proposals.recordProposal(p2);
      await commitPromotion(
        { structuredStore: store.structuredPlaybooks, proposalStore: store.proposals },
        p2,
        e2,
        thresholds,
      );

      // Rollback to v1 (sets head to v4 with v1's content)
      const pR = proposal({ id: "p-R", baseVersion: 3 });
      const eR = evaluation({ id: "e-R", proposalId: "p-R", verdict: "rollback" });
      await store.proposals.recordProposal(pR);
      await rollbackPromotion(
        { structuredStore: store.structuredPlaybooks, proposalStore: store.proposals },
        pR,
        1,
        eR,
      );
      store.close();

      // Restart, retry rollback with DIFFERENT targetVersion
      store = createSqlitePlaybookStore({ path });
      await expect(
        rollbackPromotion(
          { structuredStore: store.structuredPlaybooks, proposalStore: store.proposals },
          pR,
          2,
          eR,
        ),
      ).rejects.toThrow(/current head content does not match that snapshot/);
      store.close();
    });
  });

  test("G': rollback idempotent retry with same targetVersion returns success", async () => {
    await withTmpDb(async (path) => {
      let store = createSqlitePlaybookStore({ path });
      await store.structuredPlaybooks.save(seed());
      const p1 = proposal({ id: "p-1", baseVersion: 1 });
      const e1 = evaluation({ id: "e-1", proposalId: "p-1" });
      await store.proposals.recordProposal(p1);
      await commitPromotion(
        { structuredStore: store.structuredPlaybooks, proposalStore: store.proposals },
        p1,
        e1,
        thresholds,
      );
      const pR = proposal({ id: "p-R", baseVersion: 2 });
      const eR = evaluation({ id: "e-R", proposalId: "p-R", verdict: "rollback" });
      await store.proposals.recordProposal(pR);
      await rollbackPromotion(
        { structuredStore: store.structuredPlaybooks, proposalStore: store.proposals },
        pR,
        1,
        eR,
      );
      store.close();

      store = createSqlitePlaybookStore({ path });
      const retry = await rollbackPromotion(
        { structuredStore: store.structuredPlaybooks, proposalStore: store.proposals },
        pR,
        1,
        eR,
      );
      expect(retry.outcome).toBe("rolled_back");
      store.close();
    });
  });
});

describe("ACE e2e: schema migration v7 → v8", () => {
  test("E: opening a v7-shaped database through current binary applies the v8 ALTER", async () => {
    await withTmpDb(async (path) => {
      // Seed a v7 database manually (no reflected_step_index_by_session column)
      const raw = new Database(path, { create: true });
      raw.run("PRAGMA journal_mode = WAL");
      raw.run("PRAGMA foreign_keys = ON");
      raw.run(`
        CREATE TABLE structured_playbooks (
          id                        TEXT    PRIMARY KEY,
          title                     TEXT    NOT NULL,
          sections                  TEXT    NOT NULL,
          tags                      TEXT    NOT NULL DEFAULT '[]',
          source                    TEXT    NOT NULL,
          created_at                INTEGER NOT NULL,
          updated_at                INTEGER NOT NULL,
          session_count             INTEGER NOT NULL,
          last_reflected_step_index INTEGER,
          version                   INTEGER NOT NULL,
          provenance                TEXT
        )
      `);
      // Insert a legacy row with only the scalar watermark
      raw.run(
        `INSERT INTO structured_playbooks
         (id, title, sections, tags, source, created_at, updated_at, session_count,
          last_reflected_step_index, version, provenance)
         VALUES ('legacy-pb', 'legacy', '[]', '[]', 'curated', 0, 0, 0, 42, 5, NULL)`,
      );
      raw.run("PRAGMA user_version = 7");
      raw.close();

      // Open through current binary — should add column and bump user_version to 8
      const store = createSqlitePlaybookStore({ path });
      try {
        const inspectDb = new Database(path, { readonly: true });
        try {
          const cols = inspectDb
            .query("PRAGMA table_info(structured_playbooks)")
            .all() as readonly { name: string }[];
          expect(cols.some((c) => c.name === "reflected_step_index_by_session")).toBe(true);

          const v = inspectDb.query("PRAGMA user_version").get() as { user_version: number };
          expect(v.user_version).toBe(8);
        } finally {
          inspectDb.close();
        }

        // Legacy row reads correctly
        const legacy = await store.structuredPlaybooks.get("legacy-pb");
        expect(legacy?.lastReflectedStepIndex).toBe(42);
        expect(legacy?.reflectedStepIndexBySession).toBeUndefined();
      } finally {
        store.close();
      }
    });
  });
});
