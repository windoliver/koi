/**
 * Reusable FileSystemBackend contract test suite.
 *
 * Tests only the interface — no implementation-specific assertions.
 * Any backend (mock, local, Nexus) that passes this suite satisfies the L0 contract.
 *
 * Will be extracted to a shared test package when a 2nd backend arrives.
 */

import { describe, expect, test } from "bun:test";
import type { FileSystemBackend } from "@koi/core";

export function runFileSystemBackendContractTests(
  createBackend: () => FileSystemBackend | Promise<FileSystemBackend>,
): void {
  // -------------------------------------------------------------------
  // Read
  // -------------------------------------------------------------------
  describe("read", () => {
    test("returns content for existing file", async () => {
      const backend = await createBackend();
      await backend.write("/contract/read.txt", "hello");
      const result = await backend.read("/contract/read.txt");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.content).toBe("hello");
        expect(result.value.path).toBe("/contract/read.txt");
        expect(result.value.size).toBeGreaterThan(0);
      }
    });

    test("returns NOT_FOUND for missing file", async () => {
      const backend = await createBackend();
      const result = await backend.read("/contract/does-not-exist.txt");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("NOT_FOUND");
    });

    test("reads empty file", async () => {
      const backend = await createBackend();
      await backend.write("/contract/empty.txt", "");
      const result = await backend.read("/contract/empty.txt");
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.content).toBe("");
    });

    test("reads file with unicode content", async () => {
      const backend = await createBackend();
      const content = "Hello\nBravo! ";
      await backend.write("/contract/unicode.txt", content);
      const result = await backend.read("/contract/unicode.txt");
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.content).toBe(content);
    });
  });

  // -------------------------------------------------------------------
  // Write
  // -------------------------------------------------------------------
  describe("write", () => {
    test("writes and returns bytesWritten", async () => {
      const backend = await createBackend();
      const result = await backend.write("/contract/write.txt", "test content");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.path).toBe("/contract/write.txt");
        expect(result.value.bytesWritten).toBeGreaterThan(0);
      }
    });

    test("overwrites existing file", async () => {
      const backend = await createBackend();
      await backend.write("/contract/overwrite.txt", "first");
      await backend.write("/contract/overwrite.txt", "second");
      const result = await backend.read("/contract/overwrite.txt");
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.content).toBe("second");
    });

    test("writes empty content", async () => {
      const backend = await createBackend();
      const result = await backend.write("/contract/write-empty.txt", "");
      expect(result.ok).toBe(true);
      const read = await backend.read("/contract/write-empty.txt");
      expect(read.ok).toBe(true);
      if (read.ok) expect(read.value.content).toBe("");
    });
  });

  // -------------------------------------------------------------------
  // Edit
  // -------------------------------------------------------------------
  describe("edit", () => {
    test("applies single hunk", async () => {
      const backend = await createBackend();
      await backend.write("/contract/edit.txt", "hello world");
      const result = await backend.edit("/contract/edit.txt", [
        { oldText: "hello", newText: "goodbye" },
      ]);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.hunksApplied).toBe(1);
    });

    test("applies multiple hunks", async () => {
      const backend = await createBackend();
      await backend.write("/contract/edit-multi.txt", "aaa bbb ccc");
      const result = await backend.edit("/contract/edit-multi.txt", [
        { oldText: "aaa", newText: "xxx" },
        { oldText: "ccc", newText: "zzz" },
      ]);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.hunksApplied).toBe(2);
    });

    test("dryRun does not modify file", async () => {
      const backend = await createBackend();
      await backend.write("/contract/edit-dry.txt", "hello world");
      const result = await backend.edit(
        "/contract/edit-dry.txt",
        [{ oldText: "hello", newText: "goodbye" }],
        { dryRun: true },
      );
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.hunksApplied).toBe(1);

      const read = await backend.read("/contract/edit-dry.txt");
      expect(read.ok).toBe(true);
      if (read.ok) expect(read.value.content).toBe("hello world");
    });

    test("returns error for missing file", async () => {
      const backend = await createBackend();
      const result = await backend.edit("/contract/missing-edit.txt", [
        { oldText: "a", newText: "b" },
      ]);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("NOT_FOUND");
    });
  });

  // -------------------------------------------------------------------
  // List
  // -------------------------------------------------------------------
  describe("list", () => {
    test("lists files in directory", async () => {
      const backend = await createBackend();
      await backend.write("/contract/list/a.txt", "a");
      await backend.write("/contract/list/b.txt", "b");
      const result = await backend.list("/contract/list");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.entries.length).toBeGreaterThanOrEqual(2);
        const paths = result.value.entries.map((e) => e.path);
        expect(paths).toContain("/contract/list/a.txt");
        expect(paths).toContain("/contract/list/b.txt");
      }
    });

    test("lists recursively", async () => {
      const backend = await createBackend();
      await backend.write("/contract/list-r/sub/deep.txt", "deep");
      const result = await backend.list("/contract/list-r", { recursive: true });
      expect(result.ok).toBe(true);
      if (result.ok) {
        const paths = result.value.entries.map((e) => e.path);
        expect(paths.some((p) => p.includes("deep.txt"))).toBe(true);
      }
    });

    test("returns truncated flag", async () => {
      const backend = await createBackend();
      const result = await backend.list("/contract/list-empty");
      expect(result.ok).toBe(true);
      if (result.ok) expect(typeof result.value.truncated).toBe("boolean");
    });

    test("entries have kind field", async () => {
      const backend = await createBackend();
      await backend.write("/contract/list-kind/file.txt", "content");
      const result = await backend.list("/contract/list-kind", { recursive: true });
      expect(result.ok).toBe(true);
      if (result.ok) {
        for (const entry of result.value.entries) {
          expect(["file", "directory", "symlink"]).toContain(entry.kind);
        }
      }
    });
  });

  // -------------------------------------------------------------------
  // Search
  // -------------------------------------------------------------------
  describe("search", () => {
    test("finds matching content", async () => {
      const backend = await createBackend();
      await backend.write("/contract/search/target.txt", "findme in this file");
      const result = await backend.search("findme", { glob: "/contract/search/*" });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.matches.length).toBeGreaterThanOrEqual(1);
        expect(result.value.matches[0]?.text).toContain("findme");
      }
    });

    test("returns empty for no matches", async () => {
      const backend = await createBackend();
      await backend.write("/contract/search-none/file.txt", "nothing here");
      const result = await backend.search("ZZZZZ_NO_MATCH", { glob: "/contract/search-none/*" });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.matches.length).toBe(0);
    });

    test("returns truncated flag", async () => {
      const backend = await createBackend();
      await backend.write("/contract/search-trunc/file.txt", "content");
      const result = await backend.search("content");
      expect(result.ok).toBe(true);
      if (result.ok) expect(typeof result.value.truncated).toBe("boolean");
    });

    test("respects maxResults", async () => {
      const backend = await createBackend();
      const lines = Array.from({ length: 20 }, (_, i) => `match_${String(i)}`).join("\n");
      await backend.write("/contract/search-max/many.txt", lines);
      const result = await backend.search("match_", { maxResults: 5 });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.matches.length).toBeLessThanOrEqual(5);
    });
  });

  // -------------------------------------------------------------------
  // Delete
  // -------------------------------------------------------------------
  describe("delete", () => {
    test("deletes existing file", async () => {
      const backend = await createBackend();
      await backend.write("/contract/delete-me.txt", "bye");
      const del = backend.delete;
      if (del === undefined) return; // Optional operation
      const result = await del("/contract/delete-me.txt");
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.path).toBe("/contract/delete-me.txt");

      const read = await backend.read("/contract/delete-me.txt");
      expect(read.ok).toBe(false);
    });

    test("returns error for missing file", async () => {
      const backend = await createBackend();
      const del = backend.delete;
      if (del === undefined) return;
      const result = await del("/contract/no-such-file.txt");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("NOT_FOUND");
    });
  });

  // -------------------------------------------------------------------
  // Rename
  // -------------------------------------------------------------------
  describe("rename", () => {
    test("renames existing file", async () => {
      const backend = await createBackend();
      await backend.write("/contract/rename-src.txt", "content");
      const rename = backend.rename;
      if (rename === undefined) return; // Optional operation
      const result = await rename("/contract/rename-src.txt", "/contract/rename-dst.txt");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.from).toBe("/contract/rename-src.txt");
        expect(result.value.to).toBe("/contract/rename-dst.txt");
      }

      const read = await backend.read("/contract/rename-dst.txt");
      expect(read.ok).toBe(true);
      if (read.ok) expect(read.value.content).toBe("content");
    });

    test("returns error for missing source", async () => {
      const backend = await createBackend();
      const rename = backend.rename;
      if (rename === undefined) return;
      const result = await rename("/contract/no-src.txt", "/contract/dst.txt");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("NOT_FOUND");
    });
  });
}
