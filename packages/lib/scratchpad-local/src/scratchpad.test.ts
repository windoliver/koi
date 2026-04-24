import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { agentGroupId, agentId, scratchpadPath } from "@koi/core";
import type { LocalScratchpad } from "./scratchpad.js";
import { createLocalScratchpad } from "./scratchpad.js";

const gid = agentGroupId("group-1");
const aid = agentId("agent-1");

function makeScratchpad(sweepIntervalMs = 0): LocalScratchpad {
  return createLocalScratchpad({ groupId: gid, authorId: aid, sweepIntervalMs });
}

describe("createLocalScratchpad", () => {
  let sp: LocalScratchpad;

  beforeEach(() => {
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
      expect(rr.value.groupId).toBe(gid);
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
  });
});
