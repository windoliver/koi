/**
 * Reusable contract test suite for ScratchpadComponent implementations.
 *
 * Accepts a factory that returns a ScratchpadComponent (sync or async).
 * Each test creates a fresh instance for isolation.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import type { ScratchpadComponent } from "@koi/core";
import { SCRATCHPAD_DEFAULTS, scratchpadPath } from "@koi/core";

/**
 * Run the ScratchpadComponent contract test suite against any implementation.
 *
 * The factory should return a scratchpad pre-configured with a groupId and authorId.
 */
export function runScratchpadContractTests(
  createScratchpad: () => ScratchpadComponent | Promise<ScratchpadComponent>,
): void {
  describe("ScratchpadComponent contract", () => {
    let pad: ScratchpadComponent;

    beforeEach(async () => {
      pad = await createScratchpad();
    });

    // -----------------------------------------------------------------------
    // write + read round-trip
    // -----------------------------------------------------------------------

    test("write + read round-trip returns stored content", async () => {
      const writeResult = await pad.write({
        path: scratchpadPath("test.txt"),
        content: "hello world",
      });
      expect(writeResult.ok).toBe(true);
      if (!writeResult.ok) return;
      expect(writeResult.value.generation).toBeGreaterThan(0);

      const readResult = await pad.read(scratchpadPath("test.txt"));
      expect(readResult.ok).toBe(true);
      if (!readResult.ok) return;
      expect(readResult.value.content).toBe("hello world");
      expect(readResult.value.path).toBe(scratchpadPath("test.txt"));
      expect(readResult.value.generation).toBe(writeResult.value.generation);
      expect(readResult.value.sizeBytes).toBeGreaterThan(0);
    });

    test("read non-existent path returns NOT_FOUND", async () => {
      const result = await pad.read(scratchpadPath("does-not-exist.txt"));
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("NOT_FOUND");
    });

    // -----------------------------------------------------------------------
    // CAS — create-only (expectedGeneration = 0)
    // -----------------------------------------------------------------------

    test("CAS create-only succeeds when path does not exist", async () => {
      const result = await pad.write({
        path: scratchpadPath("new.txt"),
        content: "fresh",
        expectedGeneration: 0,
      });
      expect(result.ok).toBe(true);
    });

    test("CAS create-only fails with CONFLICT when path already exists", async () => {
      await pad.write({ path: scratchpadPath("exists.txt"), content: "v1" });

      const result = await pad.write({
        path: scratchpadPath("exists.txt"),
        content: "v2",
        expectedGeneration: 0,
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("CONFLICT");
    });

    // -----------------------------------------------------------------------
    // CAS — match / mismatch
    // -----------------------------------------------------------------------

    test("CAS update succeeds when generation matches", async () => {
      const w1 = await pad.write({ path: scratchpadPath("cas.txt"), content: "v1" });
      expect(w1.ok).toBe(true);
      if (!w1.ok) return;

      const w2 = await pad.write({
        path: scratchpadPath("cas.txt"),
        content: "v2",
        expectedGeneration: w1.value.generation,
      });
      expect(w2.ok).toBe(true);
      if (!w2.ok) return;
      expect(w2.value.generation).toBeGreaterThan(w1.value.generation);
    });

    test("CAS update fails with CONFLICT when generation mismatches", async () => {
      const w1 = await pad.write({ path: scratchpadPath("cas.txt"), content: "v1" });
      expect(w1.ok).toBe(true);
      if (!w1.ok) return;

      const result = await pad.write({
        path: scratchpadPath("cas.txt"),
        content: "v2",
        expectedGeneration: w1.value.generation + 999,
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("CONFLICT");
    });

    // -----------------------------------------------------------------------
    // Unconditional write (expectedGeneration = undefined)
    // -----------------------------------------------------------------------

    test("unconditional write overwrites regardless of generation", async () => {
      await pad.write({ path: scratchpadPath("overwrite.txt"), content: "v1" });

      const w2 = await pad.write({
        path: scratchpadPath("overwrite.txt"),
        content: "v2",
      });
      expect(w2.ok).toBe(true);

      const read = await pad.read(scratchpadPath("overwrite.txt"));
      expect(read.ok).toBe(true);
      if (!read.ok) return;
      expect(read.value.content).toBe("v2");
    });

    // -----------------------------------------------------------------------
    // list
    // -----------------------------------------------------------------------

    test("list returns all entries when no filter", async () => {
      await pad.write({ path: scratchpadPath("a.txt"), content: "a" });
      await pad.write({ path: scratchpadPath("b.txt"), content: "b" });
      await pad.write({ path: scratchpadPath("c.txt"), content: "c" });

      const entries = await pad.list();
      expect(entries).toHaveLength(3);
    });

    test("list with limit restricts result count", async () => {
      await pad.write({ path: scratchpadPath("a.txt"), content: "a" });
      await pad.write({ path: scratchpadPath("b.txt"), content: "b" });
      await pad.write({ path: scratchpadPath("c.txt"), content: "c" });

      const entries = await pad.list({ limit: 2 });
      expect(entries).toHaveLength(2);
    });

    test("list with glob filters by path pattern", async () => {
      await pad.write({ path: scratchpadPath("notes/a.md"), content: "a" });
      await pad.write({ path: scratchpadPath("notes/b.md"), content: "b" });
      await pad.write({ path: scratchpadPath("code/c.ts"), content: "c" });

      const entries = await pad.list({ glob: "notes/*.md" });
      expect(entries).toHaveLength(2);
    });

    test("list entries do not include content (summaries only)", async () => {
      await pad.write({ path: scratchpadPath("test.txt"), content: "secret data" });

      const entries = await pad.list();
      expect(entries).toHaveLength(1);
      // ScratchpadEntrySummary = Omit<ScratchpadEntry, "content">
      // TypeScript enforces this, but we verify at runtime that content is not leaked
      const entry = entries[0];
      expect(entry).toBeDefined();
      if (entry === undefined) return;
      expect(entry.path).toBe(scratchpadPath("test.txt"));
      expect("content" in entry).toBe(false);
    });

    // -----------------------------------------------------------------------
    // delete
    // -----------------------------------------------------------------------

    test("delete removes an existing entry", async () => {
      await pad.write({ path: scratchpadPath("del.txt"), content: "bye" });

      const delResult = await pad.delete(scratchpadPath("del.txt"));
      expect(delResult.ok).toBe(true);

      const readResult = await pad.read(scratchpadPath("del.txt"));
      expect(readResult.ok).toBe(false);
      if (readResult.ok) return;
      expect(readResult.error.code).toBe("NOT_FOUND");
    });

    test("delete non-existent path returns NOT_FOUND", async () => {
      const result = await pad.delete(scratchpadPath("ghost.txt"));
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("NOT_FOUND");
    });

    // -----------------------------------------------------------------------
    // generation increments
    // -----------------------------------------------------------------------

    test("generation increments on each write", async () => {
      const w1 = await pad.write({ path: scratchpadPath("gen.txt"), content: "v1" });
      expect(w1.ok).toBe(true);
      if (!w1.ok) return;

      const w2 = await pad.write({ path: scratchpadPath("gen.txt"), content: "v2" });
      expect(w2.ok).toBe(true);
      if (!w2.ok) return;

      expect(w2.value.generation).toBeGreaterThan(w1.value.generation);
    });

    // -----------------------------------------------------------------------
    // path validation
    // -----------------------------------------------------------------------

    test("path with '..' is rejected with VALIDATION error", async () => {
      const result = await pad.write({
        path: scratchpadPath("../escape.txt"),
        content: "nope",
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("VALIDATION");
    });

    test("path with leading '/' is rejected with VALIDATION error", async () => {
      const result = await pad.write({
        path: scratchpadPath("/absolute.txt"),
        content: "nope",
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("VALIDATION");
    });

    test("path exceeding max length is rejected with VALIDATION error", async () => {
      const longPath = "a".repeat(SCRATCHPAD_DEFAULTS.MAX_PATH_LENGTH + 1);
      const result = await pad.write({
        path: scratchpadPath(longPath),
        content: "nope",
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("VALIDATION");
    });

    // -----------------------------------------------------------------------
    // file size limit
    // -----------------------------------------------------------------------

    test("content exceeding max file size is rejected with VALIDATION error", async () => {
      const largeContent = "x".repeat(SCRATCHPAD_DEFAULTS.MAX_FILE_SIZE_BYTES + 1);
      const result = await pad.write({
        path: scratchpadPath("big.txt"),
        content: largeContent,
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("VALIDATION");
    });

    // -----------------------------------------------------------------------
    // onChange
    // -----------------------------------------------------------------------

    test("onChange fires on write", async () => {
      const events: unknown[] = [];
      const unsub = pad.onChange((evt) => {
        events.push(evt);
      });

      await pad.write({ path: scratchpadPath("watch.txt"), content: "hello" });

      // Allow microtask/sync delivery
      await Bun.sleep(10);

      expect(events).toHaveLength(1);
      const evt = events[0] as { kind: string; path: string };
      expect(evt.kind).toBe("written");
      expect(evt.path).toBe("watch.txt");

      unsub();
    });

    test("onChange fires on delete", async () => {
      await pad.write({ path: scratchpadPath("watch-del.txt"), content: "bye" });

      const events: unknown[] = [];
      const unsub = pad.onChange((evt) => {
        events.push(evt);
      });

      await pad.delete(scratchpadPath("watch-del.txt"));
      await Bun.sleep(10);

      expect(events.length).toBeGreaterThanOrEqual(1);
      const lastEvt = events[events.length - 1] as { kind: string };
      expect(lastEvt.kind).toBe("deleted");

      unsub();
    });

    test("unsubscribe stops delivery", async () => {
      const events: unknown[] = [];
      const unsub = pad.onChange((evt) => {
        events.push(evt);
      });
      unsub();

      await pad.write({ path: scratchpadPath("silent.txt"), content: "no event" });
      await Bun.sleep(10);

      expect(events).toHaveLength(0);
    });

    // -----------------------------------------------------------------------
    // flush
    // -----------------------------------------------------------------------

    test("flush is callable without error", async () => {
      await pad.write({ path: scratchpadPath("flush.txt"), content: "data" });
      await pad.flush();
      // Should not throw
    });
  });
}
