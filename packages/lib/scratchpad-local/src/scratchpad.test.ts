import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { agentGroupId, agentId, scratchpadPath } from "@koi/core";
import type { LocalScratchpad } from "./scratchpad.js";
import { createLocalScratchpad } from "./scratchpad.js";

const aid = agentId("agent-1");

// Each test gets a unique groupId so that the persistent group store
// does not bleed state across tests.
let gidCounter = 0;
let currentGid = agentGroupId("group-0");

function makeScratchpad(sweepIntervalMs = 0): LocalScratchpad {
  return createLocalScratchpad({ groupId: currentGid, authorId: aid, sweepIntervalMs });
}

describe("createLocalScratchpad", () => {
  let sp: LocalScratchpad;

  beforeEach(() => {
    currentGid = agentGroupId(`group-${++gidCounter}`);
    sp = makeScratchpad();
  });

  afterEach(() => {
    sp.close();
  });

  describe("write / read / delete", () => {
    it("writes and reads an entry", () => {
      const path = scratchpadPath("notes/todo.md");
      const wr = sp.write({ path, content: "buy milk" });
      expect(wr.ok).toBe(true);
      if (!wr.ok) return;
      expect(wr.value.generation).toBe(1);

      const rr = sp.read(path);
      expect(rr.ok).toBe(true);
      if (!rr.ok) return;
      expect(rr.value.content).toBe("buy milk");
      expect(rr.value.generation).toBe(1);
      expect(rr.value.authorId).toBe(aid);
      expect(rr.value.groupId).toBe(currentGid);
    });

    it("returns NOT_FOUND for missing path", () => {
      const rr = sp.read(scratchpadPath("missing"));
      expect(rr.ok).toBe(false);
      if (rr.ok) return;
      expect(rr.error.code).toBe("NOT_FOUND");
    });

    it("increments generation on each write", () => {
      const path = scratchpadPath("counter");
      sp.write({ path, content: "v1" });
      sp.write({ path, content: "v2" });
      const wr = sp.write({ path, content: "v3" });
      expect(wr.ok).toBe(true);
      if (!wr.ok) return;
      expect(wr.value.generation).toBe(3);
    });

    it("deletes an entry", () => {
      const path = scratchpadPath("x");
      sp.write({ path, content: "data" });
      const dr = sp.delete(path);
      expect(dr.ok).toBe(true);
      expect(sp.read(path).ok).toBe(false);
    });

    it("returns NOT_FOUND when deleting missing entry", () => {
      const dr = sp.delete(scratchpadPath("ghost"));
      expect(dr.ok).toBe(false);
      if (dr.ok) return;
      expect(dr.error.code).toBe("NOT_FOUND");
    });
  });

  describe("CAS semantics", () => {
    it("create-only (expectedGeneration=0) succeeds when absent", () => {
      const path = scratchpadPath("lock");
      const wr = sp.write({ path, content: "held", expectedGeneration: 0 });
      expect(wr.ok).toBe(true);
    });

    it("create-only (expectedGeneration=0) fails with CONFLICT when present", () => {
      const path = scratchpadPath("lock");
      sp.write({ path, content: "first", expectedGeneration: 0 });
      const wr = sp.write({ path, content: "second", expectedGeneration: 0 });
      expect(wr.ok).toBe(false);
      if (wr.ok) return;
      expect(wr.error.code).toBe("CONFLICT");
    });

    it("CAS update succeeds on generation match", () => {
      const path = scratchpadPath("data");
      sp.write({ path, content: "v1" });
      const wr = sp.write({ path, content: "v2", expectedGeneration: 1 });
      expect(wr.ok).toBe(true);
      if (!wr.ok) return;
      expect(wr.value.generation).toBe(2);
    });

    it("CAS update fails CONFLICT on generation mismatch", () => {
      const path = scratchpadPath("data");
      sp.write({ path, content: "v1" });
      sp.write({ path, content: "v2" });
      const wr = sp.write({ path, content: "v3", expectedGeneration: 1 });
      expect(wr.ok).toBe(false);
      if (wr.ok) return;
      expect(wr.error.code).toBe("CONFLICT");
    });

    it("CAS update fails NOT_FOUND when path missing", () => {
      const path = scratchpadPath("absent");
      const wr = sp.write({ path, content: "x", expectedGeneration: 5 });
      expect(wr.ok).toBe(false);
      if (wr.ok) return;
      expect(wr.error.code).toBe("NOT_FOUND");
    });
  });

  describe("TTL", () => {
    it("expired entries not returned by read", async () => {
      const path = scratchpadPath("ephemeral");
      sp.write({ path, content: "data", ttlSeconds: 0.01 });
      await Bun.sleep(20);
      const rr = sp.read(path);
      expect(rr.ok).toBe(false);
      if (rr.ok) return;
      expect(rr.error.code).toBe("NOT_FOUND");
    });

    it("expired entries not returned by list", async () => {
      sp.write({ path: scratchpadPath("a"), content: "alive" });
      sp.write({ path: scratchpadPath("b"), content: "dead", ttlSeconds: 0.01 });
      await Bun.sleep(20);
      const entries = sp.list();
      expect(entries.length).toBe(1);
      expect(entries[0]?.path).toBe(scratchpadPath("a"));
    });

    it("expired entries rejected by delete", async () => {
      const path = scratchpadPath("old");
      sp.write({ path, content: "x", ttlSeconds: 0.01 });
      await Bun.sleep(20);
      const dr = sp.delete(path);
      expect(dr.ok).toBe(false);
      if (dr.ok) return;
      expect(dr.error.code).toBe("NOT_FOUND");
    });
  });

  describe("list + glob", () => {
    beforeEach(() => {
      sp.write({ path: scratchpadPath("notes/a.md"), content: "a" });
      sp.write({ path: scratchpadPath("notes/b.md"), content: "b" });
      sp.write({ path: scratchpadPath("config.json"), content: "{}" });
    });

    it("lists all entries when no filter", () => {
      expect(sp.list().length).toBe(3);
    });

    it("filters by glob *", () => {
      const entries = sp.list({ glob: "*.json" });
      expect(entries.length).toBe(1);
      expect(entries[0]?.path).toBe(scratchpadPath("config.json"));
    });

    it("filters by glob ** for recursive", () => {
      const entries = sp.list({ glob: "notes/**" });
      expect(entries.length).toBe(2);
    });

    it("respects limit", () => {
      const entries = sp.list({ limit: 1 });
      expect(entries.length).toBe(1);
    });

    it("returns summaries (no content)", () => {
      const entries = sp.list();
      for (const e of entries) {
        expect("content" in e).toBe(false);
      }
    });
  });

  describe("change events", () => {
    it("fires 'written' event on write", () => {
      const events: string[] = [];
      sp.onChange((e) => events.push(e.kind));
      sp.write({ path: scratchpadPath("x"), content: "y" });
      expect(events).toEqual(["written"]);
    });

    it("fires 'deleted' event on delete", () => {
      const path = scratchpadPath("x");
      sp.write({ path, content: "y" });
      const events: string[] = [];
      sp.onChange((e) => events.push(e.kind));
      sp.delete(path);
      expect(events).toEqual(["deleted"]);
    });

    it("unsubscribe stops events", () => {
      const events: string[] = [];
      const unsub = sp.onChange((e) => events.push(e.kind));
      unsub();
      sp.write({ path: scratchpadPath("x"), content: "y" });
      expect(events).toEqual([]);
    });
  });

  describe("validation", () => {
    it("rejects empty path", () => {
      const wr = sp.write({ path: scratchpadPath(""), content: "x" });
      expect(wr.ok).toBe(false);
      if (wr.ok) return;
      expect(wr.error.code).toBe("VALIDATION");
    });

    it("rejects path with leading slash", () => {
      const wr = sp.write({ path: scratchpadPath("/abs"), content: "x" });
      expect(wr.ok).toBe(false);
      if (wr.ok) return;
      expect(wr.error.code).toBe("VALIDATION");
    });

    it("rejects path with .. traversal", () => {
      const wr = sp.write({ path: scratchpadPath("../escape"), content: "x" });
      expect(wr.ok).toBe(false);
      if (wr.ok) return;
      expect(wr.error.code).toBe("VALIDATION");
    });

    it("rejects content exceeding MAX_FILE_SIZE_BYTES", () => {
      const big = "x".repeat(1_048_577); // 1 MiB + 1
      const wr = sp.write({ path: scratchpadPath("big"), content: big });
      expect(wr.ok).toBe(false);
      if (wr.ok) return;
      expect(wr.error.code).toBe("RESOURCE_EXHAUSTED");
    });

    it("returns VALIDATION error for non-JSON-serializable metadata (circular ref)", () => {
      const circular: Record<string, unknown> = {};
      circular["self"] = circular;
      const wr = sp.write({ path: scratchpadPath("circ"), content: "x", metadata: circular });
      expect(wr.ok).toBe(false);
      if (wr.ok) return;
      expect(wr.error.code).toBe("VALIDATION");
    });

    it("returns VALIDATION error for BigInt metadata value", () => {
      const wr = sp.write({
        path: scratchpadPath("bigint"),
        content: "x",
        metadata: { n: BigInt(42) } as unknown as Record<string, unknown>,
      });
      expect(wr.ok).toBe(false);
      if (wr.ok) return;
      expect(wr.error.code).toBe("VALIDATION");
    });

    it("rejects NaN ttlSeconds", () => {
      const wr = sp.write({
        path: scratchpadPath("ttl-nan"),
        content: "x",
        ttlSeconds: Number.NaN,
      });
      expect(wr.ok).toBe(false);
      if (wr.ok) return;
      expect(wr.error.code).toBe("VALIDATION");
    });

    it("rejects Infinity ttlSeconds", () => {
      const wr = sp.write({
        path: scratchpadPath("ttl-inf"),
        content: "x",
        ttlSeconds: Number.POSITIVE_INFINITY,
      });
      expect(wr.ok).toBe(false);
      if (wr.ok) return;
      expect(wr.error.code).toBe("VALIDATION");
    });

    it("rejects zero ttlSeconds", () => {
      const wr = sp.write({ path: scratchpadPath("ttl-zero"), content: "x", ttlSeconds: 0 });
      expect(wr.ok).toBe(false);
      if (wr.ok) return;
      expect(wr.error.code).toBe("VALIDATION");
    });

    it("rejects negative ttlSeconds", () => {
      const wr = sp.write({ path: scratchpadPath("ttl-neg"), content: "x", ttlSeconds: -1 });
      expect(wr.ok).toBe(false);
      if (wr.ok) return;
      expect(wr.error.code).toBe("VALIDATION");
    });
  });

  describe("concurrent access", () => {
    it("CAS prevents lost updates under concurrent writes", async () => {
      const path = scratchpadPath("counter");
      sp.write({ path, content: "0" });

      // Two concurrent writers try to increment from generation 1
      const [r1, r2] = await Promise.all([
        Promise.resolve(sp.write({ path, content: "1", expectedGeneration: 1 })),
        Promise.resolve(sp.write({ path, content: "1", expectedGeneration: 1 })),
      ]);

      // Exactly one should succeed, one should CONFLICT
      const successes = [r1, r2].filter((r) => r.ok).length;
      const conflicts = [r1, r2].filter((r) => !r.ok).length;
      expect(successes).toBe(1);
      expect(conflicts).toBe(1);
    });
  });

  describe("flush / close", () => {
    it("flush is a no-op for in-memory backend", () => {
      expect(() => sp.flush()).not.toThrow();
    });

    it("close clears all entries", () => {
      sp.write({ path: scratchpadPath("a"), content: "1" });
      sp.close();
      expect(sp.list().length).toBe(0);
    });

    it("write returns VALIDATION error after close", () => {
      sp.close();
      const r = sp.write({ path: scratchpadPath("a"), content: "x" });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error.code).toBe("VALIDATION");
    });

    it("read returns VALIDATION error after close", () => {
      sp.close();
      const r = sp.read(scratchpadPath("a"));
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error.code).toBe("VALIDATION");
    });
  });

  describe("group-shared storage", () => {
    it("two instances with same groupId share writes", () => {
      const sp2 = createLocalScratchpad({ groupId: currentGid, authorId: agentId("agent-2") });
      try {
        sp.write({ path: scratchpadPath("shared/key"), content: "hello" });
        const r = sp2.read(scratchpadPath("shared/key"));
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.value.content).toBe("hello");
      } finally {
        sp2.close();
      }
    });

    it("CAS conflict visible across instances", () => {
      const sp2 = createLocalScratchpad({ groupId: currentGid, authorId: agentId("agent-2") });
      try {
        sp.write({ path: scratchpadPath("lock"), content: "v1" });
        // Both try to create-only (expectedGeneration=0) — one must conflict
        sp2.write({ path: scratchpadPath("lock"), content: "v2" });
        const r = sp.write({
          path: scratchpadPath("lock"),
          content: "v3",
          expectedGeneration: 0,
        });
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error.code).toBe("CONFLICT");
      } finally {
        sp2.close();
      }
    });

    it("change event from one instance fires on subscriber registered in another", () => {
      const sp2 = createLocalScratchpad({ groupId: currentGid, authorId: agentId("agent-2") });
      try {
        let fired = false;
        const unsub = sp2.onChange(() => {
          fired = true;
        });
        sp.write({ path: scratchpadPath("notify-test"), content: "ping" });
        expect(fired).toBe(true);
        unsub();
      } finally {
        sp2.close();
      }
    });

    it("different groupIds are isolated", () => {
      const otherGid = agentGroupId("group-other");
      const sp2 = createLocalScratchpad({ groupId: otherGid, authorId: aid });
      try {
        sp.write({ path: scratchpadPath("isolated"), content: "secret" });
        const r = sp2.read(scratchpadPath("isolated"));
        expect(r.ok).toBe(false);
      } finally {
        sp2.close();
      }
    });

    it("entries survive last handle close and are visible to a new handle with matching reuseToken", () => {
      // Use a long dormantTtlMs so the entry persists for the synchronous re-open below.
      // reuseToken proves the reopener is the same lifecycle; without it the dormant store is evicted.
      const reopenGid = agentGroupId(`group-reopen-${++gidCounter}`);
      const token = "lifecycle-abc";
      const sp1 = createLocalScratchpad({
        groupId: reopenGid,
        authorId: aid,
        dormantTtlMs: 60_000,
        reuseToken: token,
      });
      sp1.write({ path: scratchpadPath("checkpoint"), content: "state-v1" });
      sp1.close(); // refCount → 0; timer stopped, dormant eviction scheduled

      // New handle for same groupId with matching token cancels the dormant timer and sees the surviving entries
      const sp2 = createLocalScratchpad({ groupId: reopenGid, authorId: aid, reuseToken: token });
      try {
        const r = sp2.read(scratchpadPath("checkpoint"));
        expect(r.ok).toBe(true); // entries persist across handle gap
        if (r.ok) expect(r.value.content).toBe("state-v1");
      } finally {
        sp2.close();
      }
    });

    it("dormantTtlMs is fixed by first handle; later handles with different config do not override it", () => {
      // First handle sets a long TTL and a reuse token so the third can rejoin.
      const ttlGid = agentGroupId(`group-ttl-${++gidCounter}`);
      const ttlToken = "ttl-reuse";
      const first = createLocalScratchpad({
        groupId: ttlGid,
        authorId: aid,
        dormantTtlMs: 60_000,
        reuseToken: ttlToken,
      });
      first.write({ path: scratchpadPath("state"), content: "hello" });
      // Second handle opens with TTL=0 (immediate eviction) — should NOT override first.
      // No reuseToken needed: store is active when second joins (dormantTimer is null).
      const second = createLocalScratchpad({
        groupId: ttlGid,
        authorId: agentId("agent-2"),
        dormantTtlMs: 0,
      });
      first.close(); // refCount still 1 (second open), no dormant eviction triggered
      // Third handle closes last — should use store-level TTL (60_000), not 0
      second.close(); // refCount → 0; dormant eviction scheduled with 60_000 ms

      // Immediately re-open (within ms) with matching token: state should still be present
      const third = createLocalScratchpad({ groupId: ttlGid, authorId: aid, reuseToken: ttlToken });
      try {
        const r = third.read(scratchpadPath("state"));
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.value.content).toBe("hello");
      } finally {
        third.close();
      }
    });

    it("dormant store is evicted when new handle opens without a matching reuseToken", () => {
      const evictGid = agentGroupId(`group-evict-${++gidCounter}`);
      const sp1 = createLocalScratchpad({
        groupId: evictGid,
        authorId: aid,
        dormantTtlMs: 60_000,
        reuseToken: "original-token",
      });
      sp1.write({ path: scratchpadPath("data"), content: "should-be-evicted" });
      sp1.close(); // refCount → 0; dormant window starts

      // New handle — no token (or wrong token) — should NOT inherit prior entries
      const sp2 = createLocalScratchpad({ groupId: evictGid, authorId: aid });
      try {
        const r = sp2.read(scratchpadPath("data"));
        expect(r.ok).toBe(false); // store was evicted; entry not found
      } finally {
        sp2.close();
      }
    });

    it("closing one handle does not remove the same callback registered by another handle", () => {
      // Both handles register the EXACT same function reference.
      // With Set-based dedup, closing sp1 would delete the function from the Set,
      // silently removing sp2's subscription too. Token-keyed Map prevents this.
      const sp2 = createLocalScratchpad({ groupId: currentGid, authorId: agentId("agent-2") });
      let callCount = 0;
      const sharedHandler = (): void => {
        callCount++;
      };
      sp.onChange(sharedHandler);
      sp2.onChange(sharedHandler);
      sp.write({ path: scratchpadPath("a"), content: "1" }); // fires twice (both subs)
      expect(callCount).toBe(2);
      sp.close(); // removes sp's token — sp2's token must survive
      sp2.write({ path: scratchpadPath("a"), content: "2" }); // should still fire for sp2
      expect(callCount).toBe(3); // would be 2 if sp.close() removed sp2's sub too
      sp2.close();
    });

    it("closed handle stops receiving events while another handle remains open", () => {
      const sp2 = createLocalScratchpad({ groupId: currentGid, authorId: agentId("agent-2") });
      let sp1Events = 0;
      let sp2Events = 0;
      sp.onChange(() => {
        sp1Events++;
      });
      sp2.onChange(() => {
        sp2Events++;
      });
      sp.write({ path: scratchpadPath("ping"), content: "1" }); // both fire
      sp.close(); // sp's handler should be removed
      sp2.write({ path: scratchpadPath("ping"), content: "2" }); // only sp2 fires
      expect(sp1Events).toBe(1);
      expect(sp2Events).toBe(2);
      sp2.close();
    });
  });
});
