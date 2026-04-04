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

      expect(updated.name).toBe("Project Status");
      expect(updated.description).toBe("Current sprint focus");
      expect(updated.type).toBe("project");
      expect(updated.content).toBe("Auth module complete. Moving to payments.");
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
      expect(deleted).toBe(true);

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
      expect(result).toBe(false);
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
});
