import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { brickId, publisherId } from "@koi/core";
import { assertOk, testVersionIndexContract } from "@koi/test-utils";
import { createSqliteVersionIndex } from "../version-index.js";

// ---------------------------------------------------------------------------
// Contract tests
// ---------------------------------------------------------------------------

describe("SqliteVersionIndex", () => {
  testVersionIndexContract({
    createIndex: () => {
      const db = new Database(":memory:");
      db.run("PRAGMA foreign_keys = ON");
      return createSqliteVersionIndex({ db });
    },
  });

  // -------------------------------------------------------------------------
  // SQLite-specific tests
  // -------------------------------------------------------------------------

  describe("publisher tracking", () => {
    test("preserves publisher from original publish on idempotent re-publish", async () => {
      const db = new Database(":memory:");
      db.run("PRAGMA foreign_keys = ON");
      const index = createSqliteVersionIndex({ db });

      const alice = publisherId("alice");
      const bid = brickId("sha256-aaa");

      assertOk(await index.publish("calc", "tool", "1.0.0", bid, alice));

      // Re-publish same version (idempotent) — publisher should remain alice
      const result = await index.publish("calc", "tool", "1.0.0", bid, alice);
      assertOk(result);
      expect(result.value.publisher).toBe(alice);
    });
  });

  describe("large version lists", () => {
    test("handles many versions for same brick", async () => {
      const db = new Database(":memory:");
      db.run("PRAGMA foreign_keys = ON");
      const index = createSqliteVersionIndex({ db });

      const pub = publisherId("publisher");
      for (let i = 0; i < 20; i++) {
        const version = `${i}.0.0`;
        const bid = brickId(`sha256-${i}`);
        assertOk(await index.publish("big-brick", "tool", version, bid, pub));
      }

      const result = await index.listVersions("big-brick", "tool");
      assertOk(result);
      expect(result.value.length).toBe(20);
      // Newest first — version "19.0.0" should be first
      expect(result.value[0]?.version).toBe("19.0.0");
    });
  });

  describe("close()", () => {
    test("close does not throw", () => {
      const db = new Database(":memory:");
      db.run("PRAGMA foreign_keys = ON");
      const index = createSqliteVersionIndex({ db });
      index.close();
    });
  });
});
