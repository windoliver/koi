import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memoryRecordId } from "@koi/core/memory";
import { readIndex } from "./index-file.js";
import { createMemoryStore } from "./store.js";

const TEST_ROOT = join(tmpdir(), "koi-store-test");

afterEach(async () => {
  await rm(TEST_ROOT, { recursive: true, force: true });
});

function makeDir(): string {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return join(TEST_ROOT, id);
}

describe("createMemoryStore", () => {
  describe("write + read roundtrip", () => {
    test("creates file and reads it back", async () => {
      const dir = makeDir();
      const store = createMemoryStore({ dir });

      const result = await store.write({
        name: "User Role",
        description: "User is a data scientist",
        type: "user",
        content: "The user is a data scientist focused on ML pipelines.",
      });

      expect(result.action).toBe("created");
      expect(result.record.name).toBe("User Role");
      expect(result.record.type).toBe("user");

      const read = await store.read(result.record.id);
      expect(read).toBeDefined();
      expect(read?.name).toBe("User Role");
      expect(read?.content).toBe("The user is a data scientist focused on ML pipelines.");
    });

    test("preserves all record fields through roundtrip", async () => {
      const dir = makeDir();
      const store = createMemoryStore({ dir });

      const result = await store.write({
        name: "Testing Feedback",
        description: "Integration tests must hit real DB",
        type: "feedback",
        content:
          "Always use real database.\n\n**Why:** Mock divergence broke prod.\n**How to apply:** Never mock DB in integration tests.",
      });

      const read = await store.read(result.record.id);
      expect(read?.name).toBe("Testing Feedback");
      expect(read?.description).toBe("Integration tests must hit real DB");
      expect(read?.type).toBe("feedback");
      expect(read?.content).toContain("**Why:**");
    });
  });

  describe("deduplication", () => {
    test("skips write when content is nearly identical", async () => {
      const dir = makeDir();
      const store = createMemoryStore({ dir, dedupThreshold: 0.7 });

      const first = await store.write({
        name: "User Pref",
        description: "User likes dark mode",
        type: "user",
        content: "The user prefers dark mode in all editors and terminals.",
      });
      expect(first.action).toBe("created");

      const second = await store.write({
        name: "User Pref 2",
        description: "User likes dark mode too",
        type: "user",
        content: "The user prefers dark mode in all editors and terminals.",
      });
      expect(second.action).toBe("skipped");
      expect(second.duplicateOf).toBe(first.record.id);
      expect(second.similarity).toBe(1);
    });

    test("creates new record when content differs enough", async () => {
      const dir = makeDir();
      const store = createMemoryStore({ dir, dedupThreshold: 0.7 });

      await store.write({
        name: "Pref 1",
        description: "Dark mode",
        type: "user",
        content: "The user prefers dark mode.",
      });

      const result = await store.write({
        name: "Pref 2",
        description: "Vim keybindings",
        type: "user",
        content: "The user uses vim keybindings in VS Code.",
      });
      expect(result.action).toBe("created");
    });
  });

  describe("update", () => {
    test("modifies content and preserves unpatched fields", async () => {
      const dir = makeDir();
      const store = createMemoryStore({ dir });

      const { record } = await store.write({
        name: "Project Status",
        description: "Current sprint focus",
        type: "project",
        content: "Working on auth module.",
      });

      const updated = await store.update(record.id, {
        content: "Auth module complete. Moving to payments.",
      });

      expect(updated.record.name).toBe("Project Status");
      expect(updated.record.description).toBe("Current sprint focus");
      expect(updated.record.type).toBe("project");
      expect(updated.record.content).toBe("Auth module complete. Moving to payments.");
      expect(updated.indexError).toBeUndefined();
    });

    test("preserves createdAt across updates (via mtime utimes)", async () => {
      const dir = makeDir();
      const store = createMemoryStore({ dir });

      const first = await store.write({
        name: "Long-lived",
        description: "Will be updated",
        type: "project",
        content: "Initial content for a record whose createdAt should never drift.",
      });
      const originalCreatedAt = first.record.createdAt;

      // Sleep briefly so any drift would be visible at >= 1s granularity
      // (utimes on most filesystems has second-level precision).
      await new Promise((resolve) => setTimeout(resolve, 1100));

      const updated = await store.update(first.record.id, {
        content: "Updated content body for the long-lived record.",
      });
      // utimes preserves createdAt at sub-millisecond precision loss —
      // the value is stamped as seconds-float and filesystems round to
      // their native precision. Allow a 2ms tolerance.
      const drift = Math.abs(updated.record.createdAt - originalCreatedAt);
      expect(drift).toBeLessThanOrEqual(2);
      // A fresh scan from disk should also report a value close to the
      // original createdAt — and emphatically NOT jump forward by ~1s.
      const reloaded = await store.read(first.record.id);
      const reloadedDrift = Math.abs((reloaded?.createdAt ?? 0) - originalCreatedAt);
      expect(reloadedDrift).toBeLessThanOrEqual(2);
      // updatedAt should have moved forward (update happened >1s later).
      expect(reloaded?.updatedAt).toBeGreaterThan(originalCreatedAt + 500);
    });

    test("throws for nonexistent id", async () => {
      const dir = makeDir();
      await mkdir(dir, { recursive: true });
      const store = createMemoryStore({ dir });

      await expect(store.update(memoryRecordId("nonexistent"), { content: "x" })).rejects.toThrow(
        "Memory record not found",
      );
    });
  });

  describe("delete", () => {
    test("removes file and updates index", async () => {
      const dir = makeDir();
      const store = createMemoryStore({ dir });

      const { record } = await store.write({
        name: "To Delete",
        description: "Will be removed",
        type: "reference",
        content: "Temporary reference.",
      });

      const deleted = await store.delete(record.id);
      expect(deleted.deleted).toBe(true);
      expect(deleted.indexError).toBeUndefined();

      const read = await store.read(record.id);
      expect(read).toBeUndefined();

      const index = await readIndex(dir);
      expect(index.entries.length).toBe(0);
    });

    test("returns false for nonexistent id", async () => {
      const dir = makeDir();
      await mkdir(dir, { recursive: true });
      const store = createMemoryStore({ dir });

      const result = await store.delete(memoryRecordId("nope"));
      expect(result.deleted).toBe(false);
    });
  });

  describe("list", () => {
    test("returns all records", async () => {
      const dir = makeDir();
      const store = createMemoryStore({ dir });

      await store.write({
        name: "R1",
        description: "First",
        type: "user",
        content: "First record content.",
      });
      await store.write({
        name: "R2",
        description: "Second",
        type: "feedback",
        content: "Second record content that is different.",
      });

      const all = await store.list();
      expect(all.length).toBe(2);
    });

    test("filters by type", async () => {
      const dir = makeDir();
      const store = createMemoryStore({ dir });

      await store.write({
        name: "User Info",
        description: "About user",
        type: "user",
        content: "User information here.",
      });
      await store.write({
        name: "Feedback",
        description: "Correction",
        type: "feedback",
        content: "Some feedback content that is unique.",
      });

      const users = await store.list({ type: "user" });
      expect(users.length).toBe(1);
      expect(users[0]?.type).toBe("user");
    });

    test("returns empty for fresh directory", async () => {
      const dir = makeDir();
      await mkdir(dir, { recursive: true });
      const store = createMemoryStore({ dir });

      const all = await store.list();
      expect(all.length).toBe(0);
    });
  });

  describe("index sync", () => {
    test("MEMORY.md is updated after write", async () => {
      const dir = makeDir();
      const store = createMemoryStore({ dir });

      await store.write({
        name: "Indexed Record",
        description: "Should appear in index",
        type: "user",
        content: "Content for indexed record.",
      });

      const indexContent = await readFile(join(dir, "MEMORY.md"), "utf-8");
      expect(indexContent).toContain("Indexed Record");
    });

    test("MEMORY.md is updated after delete", async () => {
      const dir = makeDir();
      const store = createMemoryStore({ dir });

      const { record } = await store.write({
        name: "Will Remove",
        description: "Temp",
        type: "user",
        content: "Will be removed from index.",
      });

      await store.delete(record.id);
      const index = await readIndex(dir);
      expect(index.entries.length).toBe(0);
    });
  });

  describe("threshold validation", () => {
    test("rejects NaN threshold", () => {
      expect(() => createMemoryStore({ dir: "/tmp/x", dedupThreshold: NaN })).toThrow(
        "dedupThreshold must be between 0 and 1",
      );
    });

    test("rejects negative threshold", () => {
      expect(() => createMemoryStore({ dir: "/tmp/x", dedupThreshold: -0.1 })).toThrow(
        "dedupThreshold must be between 0 and 1",
      );
    });

    test("rejects threshold > 1", () => {
      expect(() => createMemoryStore({ dir: "/tmp/x", dedupThreshold: 1.5 })).toThrow(
        "dedupThreshold must be between 0 and 1",
      );
    });

    test("rejects Infinity", () => {
      expect(() => createMemoryStore({ dir: "/tmp/x", dedupThreshold: Infinity })).toThrow(
        "dedupThreshold must be between 0 and 1",
      );
    });
  });

  describe("symlink and non-file handling", () => {
    test("ignores non-.md files and directories during scan", async () => {
      const dir = makeDir();
      await mkdir(dir, { recursive: true });
      // Create a directory ending in .md — should be skipped
      await mkdir(join(dir, "bad.md"), { recursive: true });

      const store = createMemoryStore({ dir });
      const all = await store.list();
      expect(all.length).toBe(0);
    });
  });

  describe("validation", () => {
    test("throws on empty name", async () => {
      const dir = makeDir();
      const store = createMemoryStore({ dir });

      await expect(
        store.write({
          name: "",
          description: "desc",
          type: "user",
          content: "content",
        }),
      ).rejects.toThrow("Invalid memory record input");
    });

    test("throws on invalid type", async () => {
      const dir = makeDir();
      const store = createMemoryStore({ dir });

      await expect(
        store.write({
          name: "name",
          description: "desc",
          type: "invalid" as "user",
          content: "content",
        }),
      ).rejects.toThrow("Invalid memory record input");
    });
  });

  describe("upsert", () => {
    test("creates new record when no name+type match and no Jaccard match", async () => {
      const dir = makeDir();
      const store = createMemoryStore({ dir });

      const result = await store.upsert(
        {
          name: "Unique Entry",
          description: "Brand new record",
          type: "user" as const,
          content: "Completely unique content that matches nothing else in the store.",
        },
        { force: false },
      );

      expect(result.action).toBe("created");
      if (result.action !== "created") throw new Error("unreachable");
      expect(result.record.name).toBe("Unique Entry");
      expect(result.record.type).toBe("user");
      expect(result.record.content).toBe(
        "Completely unique content that matches nothing else in the store.",
      );

      const all = await store.list();
      expect(all.length).toBe(1);
    });

    test("returns conflict when name+type match exists and force=false", async () => {
      const dir = makeDir();
      const store = createMemoryStore({ dir });

      const first = await store.upsert(
        {
          name: "Dup Entry",
          description: "First version",
          type: "feedback" as const,
          content: "Original content for the duplicate entry test.",
        },
        { force: false },
      );
      expect(first.action).toBe("created");

      const second = await store.upsert(
        {
          name: "Dup Entry",
          description: "Second version",
          type: "feedback" as const,
          content: "Totally different content so Jaccard does not trigger.",
        },
        { force: false },
      );
      expect(second.action).toBe("conflict");
      if (second.action !== "conflict") throw new Error("unreachable");
      expect(second.existing.name).toBe("Dup Entry");
      expect(second.existing.type).toBe("feedback");

      const all = await store.list();
      expect(all.length).toBe(1);
    });

    test("updates in place when name+type match exists and force=true", async () => {
      const dir = makeDir();
      const store = createMemoryStore({ dir });

      await store.upsert(
        {
          name: "Mutable Entry",
          description: "Will be overwritten",
          type: "project" as const,
          content: "Initial content before the forced update replaces it.",
        },
        { force: false },
      );

      const updated = await store.upsert(
        {
          name: "Mutable Entry",
          description: "Overwritten description",
          type: "project" as const,
          content: "Replaced content after force upsert overwrites the record.",
        },
        { force: true },
      );

      expect(updated.action).toBe("updated");
      if (updated.action !== "updated") throw new Error("unreachable");
      expect(updated.record.content).toBe(
        "Replaced content after force upsert overwrites the record.",
      );
      expect(updated.record.description).toBe("Overwritten description");

      const all = await store.list();
      expect(all.length).toBe(1);
    });

    test("skips when no name+type match but Jaccard content is similar", async () => {
      const dir = makeDir();
      const store = createMemoryStore({ dir, dedupThreshold: 0.7 });

      const first = await store.upsert(
        {
          name: "Alpha",
          description: "First entry",
          type: "user" as const,
          content: "The user prefers dark mode in all editors and terminals.",
        },
        { force: false },
      );
      expect(first.action).toBe("created");
      if (first.action !== "created") throw new Error("unreachable");

      const second = await store.upsert(
        {
          name: "Beta",
          description: "Different name but same content",
          type: "reference" as const,
          content: "The user prefers dark mode in all editors and terminals.",
        },
        { force: false },
      );

      expect(second.action).toBe("skipped");
      if (second.action !== "skipped") throw new Error("unreachable");
      expect(second.duplicateOf).toBe(first.record.id);
      expect(second.similarity).toBe(1);
    });

    test("name+type match takes precedence over Jaccard", async () => {
      const dir = makeDir();
      const store = createMemoryStore({ dir, dedupThreshold: 0.7 });

      // Write a record via write() with content X.
      const contentX = "The user prefers dark mode in all editors and terminals.";
      await store.write({
        name: "Decoy",
        description: "Record with content X",
        type: "user" as const,
        content: contentX,
      });

      // Upsert a record "Target/user" with different content.
      await store.upsert(
        {
          name: "Target",
          description: "First upsert",
          type: "user" as const,
          content: "Completely unrelated content about quantum computing research.",
        },
        { force: false },
      );

      // Upsert "Target/user" again with content X — should conflict on
      // name+type (not skip on Jaccard match against "Decoy").
      const result = await store.upsert(
        {
          name: "Target",
          description: "Second upsert with content X",
          type: "user" as const,
          content: contentX,
        },
        { force: false },
      );

      expect(result.action).toBe("conflict");
    });

    test("validates input before any filesystem side effect", async () => {
      const dir = makeDir();
      const store = createMemoryStore({ dir });

      await expect(
        store.upsert(
          {
            name: "",
            description: "desc",
            type: "user" as const,
            content: "content",
          },
          { force: false },
        ),
      ).rejects.toThrow("Invalid memory record input");
    });
  });
});
