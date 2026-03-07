/**
 * Reusable contract test suite for FileSystemBackend implementations.
 *
 * Accepts a factory that returns a FileSystemBackend (sync or async).
 * Each test creates a fresh backend instance for isolation.
 *
 * Pattern: same shape as runForgeStoreContractTests in store-contract.ts.
 */

import { describe, expect, test } from "bun:test";
import type { FileSystemBackend } from "@koi/core";

/**
 * Run the FileSystemBackend contract test suite against any implementation.
 *
 * The factory can return sync or async — async factories are useful for
 * implementations that need setup (e.g., temp directory, Nexus connection).
 */
export function runFileSystemBackendContractTests(
  createBackend: () => FileSystemBackend | Promise<FileSystemBackend>,
): void {
  describe("FileSystemBackend contract", () => {
    // -----------------------------------------------------------------
    // read / write round-trip
    // -----------------------------------------------------------------

    test("write then read returns identical content", async () => {
      const backend = await createBackend();
      const writeResult = await backend.write("/test/hello.txt", "hello world");
      expect(writeResult.ok).toBe(true);

      const readResult = await backend.read("/test/hello.txt");
      expect(readResult.ok).toBe(true);
      if (readResult.ok) {
        expect(readResult.value.content).toBe("hello world");
        expect(readResult.value.path).toBe("/test/hello.txt");
      }
    });

    test("write with createDirectories option succeeds", async () => {
      const backend = await createBackend();
      const result = await backend.write("/deep/nested/dir/file.txt", "content", {
        createDirectories: true,
      });
      expect(result.ok).toBe(true);

      const readResult = await backend.read("/deep/nested/dir/file.txt");
      expect(readResult.ok).toBe(true);
      if (readResult.ok) {
        expect(readResult.value.content).toBe("content");
      }
    });

    test("write with overwrite option replaces content", async () => {
      const backend = await createBackend();
      await backend.write("/overwrite.txt", "original");
      const result = await backend.write("/overwrite.txt", "replaced", { overwrite: true });
      expect(result.ok).toBe(true);

      const readResult = await backend.read("/overwrite.txt");
      expect(readResult.ok).toBe(true);
      if (readResult.ok) {
        expect(readResult.value.content).toBe("replaced");
      }
    });

    test("write empty content succeeds", async () => {
      const backend = await createBackend();
      const result = await backend.write("/empty.txt", "");
      expect(result.ok).toBe(true);

      const readResult = await backend.read("/empty.txt");
      expect(readResult.ok).toBe(true);
      if (readResult.ok) {
        expect(readResult.value.content).toBe("");
      }
    });

    // -----------------------------------------------------------------
    // read errors
    // -----------------------------------------------------------------

    test("read on non-existent path returns NOT_FOUND", async () => {
      const backend = await createBackend();
      const result = await backend.read("/does/not/exist.txt");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("NOT_FOUND");
      }
    });

    // -----------------------------------------------------------------
    // edit
    // -----------------------------------------------------------------

    test("edit replaces oldText with newText", async () => {
      const backend = await createBackend();
      await backend.write("/edit.txt", "hello world");

      const editResult = await backend.edit("/edit.txt", [
        { oldText: "hello", newText: "goodbye" },
      ]);
      expect(editResult.ok).toBe(true);
      if (editResult.ok) {
        expect(editResult.value.hunksApplied).toBe(1);
      }

      const readResult = await backend.read("/edit.txt");
      expect(readResult.ok).toBe(true);
      if (readResult.ok) {
        expect(readResult.value.content).toBe("goodbye world");
      }
    });

    test("edit with dryRun does not modify file", async () => {
      const backend = await createBackend();
      await backend.write("/dryrun.txt", "original content");

      const editResult = await backend.edit(
        "/dryrun.txt",
        [{ oldText: "original", newText: "modified" }],
        { dryRun: true },
      );
      expect(editResult.ok).toBe(true);
      if (editResult.ok) {
        expect(editResult.value.hunksApplied).toBe(1);
      }

      const readResult = await backend.read("/dryrun.txt");
      expect(readResult.ok).toBe(true);
      if (readResult.ok) {
        expect(readResult.value.content).toBe("original content");
      }
    });

    // -----------------------------------------------------------------
    // list
    // -----------------------------------------------------------------

    test("list returns written files", async () => {
      const backend = await createBackend();
      await backend.write("/list-dir/a.txt", "a");
      await backend.write("/list-dir/b.txt", "b");

      const listResult = await backend.list("/list-dir");
      expect(listResult.ok).toBe(true);
      if (listResult.ok) {
        const paths = listResult.value.entries.map((e) => e.path);
        expect(paths).toContain("/list-dir/a.txt");
        expect(paths).toContain("/list-dir/b.txt");
      }
    });

    test("list with glob filter", async () => {
      const backend = await createBackend();
      await backend.write("/glob-dir/file.txt", "text");
      await backend.write("/glob-dir/file.json", "json");

      const listResult = await backend.list("/glob-dir", { glob: "*.txt" });
      expect(listResult.ok).toBe(true);
      if (listResult.ok) {
        expect(listResult.value.entries.length).toBe(1);
        expect(listResult.value.entries[0]?.path).toBe("/glob-dir/file.txt");
      }
    });

    // -----------------------------------------------------------------
    // search
    // -----------------------------------------------------------------

    test("search finds matching content", async () => {
      const backend = await createBackend();
      await backend.write("/search/a.txt", "line one\nfind me here\nline three");
      await backend.write("/search/b.txt", "nothing interesting");

      const searchResult = await backend.search("find me");
      expect(searchResult.ok).toBe(true);
      if (searchResult.ok) {
        expect(searchResult.value.matches.length).toBeGreaterThanOrEqual(1);
        const match = searchResult.value.matches[0];
        expect(match?.path).toBe("/search/a.txt");
        expect(match?.text).toContain("find me");
      }
    });

    test("search with maxResults limits output", async () => {
      const backend = await createBackend();
      await backend.write("/max/a.txt", "match this");
      await backend.write("/max/b.txt", "match this too");
      await backend.write("/max/c.txt", "match this as well");

      const searchResult = await backend.search("match", { maxResults: 2 });
      expect(searchResult.ok).toBe(true);
      if (searchResult.ok) {
        expect(searchResult.value.matches.length).toBeLessThanOrEqual(2);
      }
    });

    // -----------------------------------------------------------------
    // delete (optional)
    // -----------------------------------------------------------------

    test("delete removes file, subsequent read returns NOT_FOUND", async () => {
      const backend = await createBackend();
      if (backend.delete === undefined) return;

      await backend.write("/to-delete.txt", "will be deleted");
      const delResult = await backend.delete("/to-delete.txt");
      expect(delResult.ok).toBe(true);

      const readResult = await backend.read("/to-delete.txt");
      expect(readResult.ok).toBe(false);
      if (!readResult.ok) {
        expect(readResult.error.code).toBe("NOT_FOUND");
      }
    });

    // -----------------------------------------------------------------
    // rename (optional)
    // -----------------------------------------------------------------

    test("rename moves file, old path returns NOT_FOUND", async () => {
      const backend = await createBackend();
      if (backend.rename === undefined) return;

      await backend.write("/old-name.txt", "rename me");
      const renameResult = await backend.rename("/old-name.txt", "/new-name.txt");
      expect(renameResult.ok).toBe(true);

      const oldRead = await backend.read("/old-name.txt");
      expect(oldRead.ok).toBe(false);
      if (!oldRead.ok) {
        expect(oldRead.error.code).toBe("NOT_FOUND");
      }

      const newRead = await backend.read("/new-name.txt");
      expect(newRead.ok).toBe(true);
      if (newRead.ok) {
        expect(newRead.value.content).toBe("rename me");
      }
    });

    // -----------------------------------------------------------------
    // dispose
    // -----------------------------------------------------------------

    test("dispose does not throw", async () => {
      const backend = await createBackend();
      if (backend.dispose !== undefined) {
        expect(() => backend.dispose?.()).not.toThrow();
      }
    });
  });
}
