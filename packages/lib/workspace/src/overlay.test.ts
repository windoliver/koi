import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  FileDeleteResult,
  FileEditResult,
  FileListResult,
  FileRenameResult,
  FileSearchResult,
  FileSystemBackend,
  FileWriteResult,
  KoiError,
  Result,
} from "@koi/core";
import { createGitWorktreeOverlayManager, createOverlayFileSystem } from "./overlay.js";

async function run(command: string[], cwd: string): Promise<void> {
  const proc = Bun.spawn(command, { cwd, stderr: "pipe", stdout: "pipe" });
  const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  if (code !== 0) throw new Error(`${command.join(" ")} failed: ${stderr}`);
}

async function createRepo(): Promise<string> {
  const repo = join(
    tmpdir(),
    `koi-overlay-repo-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await mkdir(repo, { recursive: true });
  await run(["git", "init", "--initial-branch=main"], repo);
  await run(["git", "config", "user.email", "overlay@koi.dev"], repo);
  await run(["git", "config", "user.name", "Overlay Test"], repo);
  await writeFile(join(repo, "README.md"), "base\n", "utf8");
  await run(["git", "add", "."], repo);
  await run(["git", "commit", "-m", "init"], repo);
  return repo;
}

describe("createGitWorktreeOverlayManager", () => {
  let repoPath: string;
  let overlayBasePath: string;

  beforeEach(async () => {
    repoPath = await createRepo();
    overlayBasePath = join(
      tmpdir(),
      `koi-overlay-base-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
  });

  afterEach(async () => {
    await rm(repoPath, { recursive: true, force: true });
    await rm(overlayBasePath, { recursive: true, force: true });
  });

  test("creates an isolated worktree overlay rooted outside the real repo", async () => {
    const manager = createGitWorktreeOverlayManager({ repoPath, overlayBasePath });
    const created = await manager.create();

    expect(created.ok).toBe(true);
    if (!created.ok) return;

    expect(created.value.path.startsWith(overlayBasePath)).toBe(true);
    expect(await readFile(join(created.value.path, "README.md"), "utf8")).toBe("base\n");
    expect(await readFile(join(repoPath, "README.md"), "utf8")).toBe("base\n");
  });

  test("reject discards overlay writes without touching the real repo", async () => {
    const manager = createGitWorktreeOverlayManager({ repoPath, overlayBasePath });
    const created = await manager.create();
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    await writeFile(join(created.value.path, "README.md"), "overlay\n", "utf8");
    const rejected = await manager.reject(created.value.id);

    expect(rejected.ok).toBe(true);
    await expect(stat(created.value.path)).rejects.toThrow();
    expect(await readFile(join(repoPath, "README.md"), "utf8")).toBe("base\n");
  });

  test("accept copies overlay writes back to the real repo and removes the worktree", async () => {
    const manager = createGitWorktreeOverlayManager({ repoPath, overlayBasePath });
    const created = await manager.create();
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    await writeFile(join(created.value.path, "README.md"), "accepted\n", "utf8");
    await writeFile(join(created.value.path, "new.txt"), "new file\n", "utf8");
    const accepted = await manager.accept(created.value.id);

    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;
    expect(accepted.value.changedPaths).toEqual(["README.md", "new.txt"]);
    expect(await readFile(join(repoPath, "README.md"), "utf8")).toBe("accepted\n");
    expect(await readFile(join(repoPath, "new.txt"), "utf8")).toBe("new file\n");
    await expect(stat(created.value.path)).rejects.toThrow();
  });

  test("accept reports a conflict when real repo and overlay changed the same path", async () => {
    const manager = createGitWorktreeOverlayManager({ repoPath, overlayBasePath });
    const created = await manager.create();
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    await writeFile(join(created.value.path, "README.md"), "overlay\n", "utf8");
    await writeFile(join(repoPath, "README.md"), "real\n", "utf8");
    const accepted = await manager.accept(created.value.id);

    expect(accepted.ok).toBe(false);
    if (accepted.ok) return;
    expect(accepted.error.code).toBe("CONFLICT");
    expect(accepted.error.context).toEqual({ conflictPaths: ["README.md"] });
    expect(await readFile(join(repoPath, "README.md"), "utf8")).toBe("real\n");
    expect(await readFile(join(created.value.path, "README.md"), "utf8")).toBe("overlay\n");
  });

  test("accept reports a conflict when real and overlay changes overlap by directory prefix", async () => {
    const manager = createGitWorktreeOverlayManager({ repoPath, overlayBasePath });
    const created = await manager.create();
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    await writeFile(join(created.value.path, "config"), "overlay file\n", "utf8");
    await mkdir(join(repoPath, "config"), { recursive: true });
    await writeFile(join(repoPath, "config", "local.json"), "{}\n", "utf8");
    const accepted = await manager.accept(created.value.id);

    expect(accepted.ok).toBe(false);
    if (accepted.ok) return;
    expect(accepted.error.code).toBe("CONFLICT");
    expect(accepted.error.context).toEqual({ conflictPaths: ["config"] });
    expect(await readFile(join(repoPath, "config", "local.json"), "utf8")).toBe("{}\n");
    expect(await readFile(join(created.value.path, "config"), "utf8")).toBe("overlay file\n");
  });

  test("concurrent overlays do not see or overwrite each other's changes", async () => {
    const manager = createGitWorktreeOverlayManager({ repoPath, overlayBasePath });
    const first = await manager.create();
    const second = await manager.create();
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    await writeFile(join(first.value.path, "first.txt"), "first\n", "utf8");
    await writeFile(join(second.value.path, "second.txt"), "second\n", "utf8");

    expect(Bun.file(join(first.value.path, "second.txt")).exists()).resolves.toBe(false);
    expect(Bun.file(join(second.value.path, "first.txt")).exists()).resolves.toBe(false);

    const accepted = await manager.accept(first.value.id);
    expect(accepted.ok).toBe(true);
    expect(Bun.file(join(repoPath, "first.txt")).exists()).resolves.toBe(true);
    expect(Bun.file(join(repoPath, "second.txt")).exists()).resolves.toBe(false);

    const rejected = await manager.reject(second.value.id);
    expect(rejected.ok).toBe(true);
  });

  test("accept handles large file changes", async () => {
    const manager = createGitWorktreeOverlayManager({ repoPath, overlayBasePath });
    const created = await manager.create();
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const payload = "x".repeat(2 * 1024 * 1024);
    await writeFile(join(created.value.path, "large.bin"), payload, "utf8");
    const accepted = await manager.accept(created.value.id);

    expect(accepted.ok).toBe(true);
    expect(await readFile(join(repoPath, "large.bin"), "utf8")).toBe(payload);
  });

  test("redirected filesystem writes land in the overlay worktree and accept merges them", async () => {
    const manager = createGitWorktreeOverlayManager({ repoPath, overlayBasePath });
    const created = await manager.create();
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const fs = createOverlayFileSystem({
      real: createRootedFileSystem("real", repoPath),
      overlay: createRootedFileSystem("overlay", created.value.path),
    });

    const written = await fs.write("README.md", "from overlay fs\n");
    expect(written.ok).toBe(true);
    expect(await readFile(join(created.value.path, "README.md"), "utf8")).toBe("from overlay fs\n");
    expect(await readFile(join(repoPath, "README.md"), "utf8")).toBe("base\n");

    const accepted = await manager.accept(created.value.id);
    expect(accepted.ok).toBe(true);
    expect(await readFile(join(repoPath, "README.md"), "utf8")).toBe("from overlay fs\n");
  });

  test("redirected filesystem deletes are accepted as real repo deletes", async () => {
    const manager = createGitWorktreeOverlayManager({ repoPath, overlayBasePath });
    const created = await manager.create();
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const fs = createOverlayFileSystem({
      real: createRootedFileSystem("real", repoPath),
      overlay: createRootedFileSystem("overlay", created.value.path),
    });

    const deleted = await fs.delete?.("README.md");
    expect(deleted?.ok).toBe(true);
    expect(Bun.file(join(created.value.path, "README.md")).exists()).resolves.toBe(false);
    expect(Bun.file(join(repoPath, "README.md")).exists()).resolves.toBe(true);

    const accepted = await manager.accept(created.value.id);
    expect(accepted.ok).toBe(true);
    expect(Bun.file(join(repoPath, "README.md")).exists()).resolves.toBe(false);
  });
});

function fsError(code: KoiError["code"], message: string): KoiError {
  return { code, message, retryable: false };
}

function createMemoryFileSystem(
  name: string,
  seed?: Readonly<Record<string, string>>,
): FileSystemBackend {
  const files = new Map(Object.entries(seed ?? {}));
  return {
    name,
    async read(
      path,
    ): Promise<
      Result<{ readonly content: string; readonly path: string; readonly size: number }, KoiError>
    > {
      const content = files.get(path);
      if (content === undefined) {
        return { ok: false, error: fsError("NOT_FOUND", `File not found: ${path}`) };
      }
      return { ok: true, value: { content, path, size: content.length } };
    },
    async write(
      path,
      content,
    ): Promise<Result<{ readonly path: string; readonly bytesWritten: number }, KoiError>> {
      files.set(path, content);
      return { ok: true, value: { path, bytesWritten: content.length } };
    },
    async edit(
      path,
      edits,
    ): Promise<Result<{ readonly path: string; readonly hunksApplied: number }, KoiError>> {
      const current = files.get(path);
      if (current === undefined) {
        return { ok: false, error: fsError("NOT_FOUND", `File not found: ${path}`) };
      }
      let next = current;
      let applied = 0;
      for (const edit of edits) {
        if (!next.includes(edit.oldText)) continue;
        next = next.replace(edit.oldText, edit.newText);
        applied++;
      }
      files.set(path, next);
      return { ok: true, value: { path, hunksApplied: applied } };
    },
    async list(): Promise<
      Result<
        {
          readonly entries: readonly { readonly path: string; readonly kind: "file" }[];
          readonly truncated: false;
        },
        KoiError
      >
    > {
      return {
        ok: true,
        value: {
          entries: [...files.keys()].sort().map((path) => ({ path, kind: "file" as const })),
          truncated: false,
        },
      };
    },
    async search(): Promise<
      Result<
        {
          readonly matches: readonly {
            readonly path: string;
            readonly line: number;
            readonly text: string;
          }[];
          readonly truncated: false;
        },
        KoiError
      >
    > {
      return {
        ok: true,
        value: {
          matches: [...files.entries()]
            .filter(([, content]) => content.includes("needle"))
            .map(([path, content]) => ({ path, line: 1, text: content.trim() })),
          truncated: false,
        },
      };
    },
    async delete(path): Promise<Result<{ readonly path: string }, KoiError>> {
      files.delete(path);
      return { ok: true, value: { path } };
    },
    async rename(
      from,
      to,
    ): Promise<Result<{ readonly from: string; readonly to: string }, KoiError>> {
      const current = files.get(from);
      if (current === undefined) {
        return { ok: false, error: fsError("NOT_FOUND", `File not found: ${from}`) };
      }
      files.delete(from);
      files.set(to, current);
      return { ok: true, value: { from, to } };
    },
  };
}

function createRootedFileSystem(name: string, root: string): FileSystemBackend {
  return {
    name,
    async read(
      path,
    ): Promise<
      Result<{ readonly content: string; readonly path: string; readonly size: number }, KoiError>
    > {
      const fullPath = join(root, path);
      try {
        const content = await readFile(fullPath, "utf8");
        return { ok: true, value: { content, path, size: content.length } };
      } catch (e: unknown) {
        if (e instanceof Error && "code" in e && e.code === "ENOENT") {
          return { ok: false, error: fsError("NOT_FOUND", `File not found: ${path}`) };
        }
        return { ok: false, error: fsError("INTERNAL", `Failed to read: ${path}`) };
      }
    },
    async write(path, content): Promise<Result<FileWriteResult, KoiError>> {
      const fullPath = join(root, path);
      await mkdir(join(fullPath, ".."), { recursive: true });
      await writeFile(fullPath, content, "utf8");
      return { ok: true, value: { path, bytesWritten: content.length } };
    },
    async edit(path, edits): Promise<Result<FileEditResult, KoiError>> {
      const current = await this.read(path);
      if (!current.ok) return current;
      let next = current.value.content;
      let hunksApplied = 0;
      for (const edit of edits) {
        if (!next.includes(edit.oldText)) continue;
        next = next.replace(edit.oldText, edit.newText);
        hunksApplied++;
      }
      const written = await this.write(path, next);
      if (!written.ok) return written;
      return { ok: true, value: { path, hunksApplied } };
    },
    async list(): Promise<Result<FileListResult, KoiError>> {
      return { ok: true, value: { entries: [], truncated: false } };
    },
    async search(): Promise<Result<FileSearchResult, KoiError>> {
      return { ok: true, value: { matches: [], truncated: false } };
    },
    async delete(path): Promise<Result<FileDeleteResult, KoiError>> {
      try {
        await unlink(join(root, path));
      } catch (e: unknown) {
        if (!(e instanceof Error) || !("code" in e) || e.code !== "ENOENT") {
          return { ok: false, error: fsError("INTERNAL", `Failed to delete: ${path}`) };
        }
      }
      return { ok: true, value: { path } };
    },
    async rename(from, to): Promise<Result<FileRenameResult, KoiError>> {
      const source = await this.read(from);
      if (!source.ok) return source;
      const written = await this.write(to, source.value.content);
      if (!written.ok) return written;
      await this.delete?.(from);
      return { ok: true, value: { from, to } };
    },
  };
}

describe("createOverlayFileSystem", () => {
  test("reads fall back to real filesystem while writes are redirected to overlay", async () => {
    const real = createMemoryFileSystem("real", { "note.txt": "real\n" });
    const overlay = createMemoryFileSystem("overlay");
    const fs = createOverlayFileSystem({ real, overlay });

    const readBefore = await fs.read("note.txt");
    expect(readBefore.ok).toBe(true);
    if (!readBefore.ok) return;
    expect(readBefore.value.content).toBe("real\n");

    const written = await fs.write("note.txt", "overlay\n");
    expect(written.ok).toBe(true);
    const readAfter = await fs.read("note.txt");
    const realAfter = await real.read("note.txt");

    expect(readAfter.ok && readAfter.value.content).toBe("overlay\n");
    expect(realAfter.ok && realAfter.value.content).toBe("real\n");
  });

  test("edit hydrates real content into overlay before applying edits", async () => {
    const real = createMemoryFileSystem("real", { "note.txt": "hello world" });
    const overlay = createMemoryFileSystem("overlay");
    const fs = createOverlayFileSystem({ real, overlay });

    const edited = await fs.edit("note.txt", [{ oldText: "world", newText: "overlay" }]);
    expect(edited.ok).toBe(true);

    const overlayRead = await overlay.read("note.txt");
    const realRead = await real.read("note.txt");
    expect(overlayRead.ok && overlayRead.value.content).toBe("hello overlay");
    expect(realRead.ok && realRead.value.content).toBe("hello world");
  });

  test("dry-run edit on a real-only file does not write into the overlay", async () => {
    const real = createMemoryFileSystem("real", { "note.txt": "hello world" });
    const overlay = createMemoryFileSystem("overlay");
    const fs = createOverlayFileSystem({ real, overlay });

    const edited = await fs.edit("note.txt", [{ oldText: "world", newText: "overlay" }], {
      dryRun: true,
    });

    expect(edited.ok && edited.value.hunksApplied).toBe(1);
    const overlayRead = await overlay.read("note.txt");
    expect(overlayRead.ok).toBe(false);
    expect(!overlayRead.ok && overlayRead.error.code).toBe("NOT_FOUND");
  });

  test("delete masks a real file without mutating the real filesystem", async () => {
    const real = createMemoryFileSystem("real", { "note.txt": "real\n" });
    const overlay = createMemoryFileSystem("overlay");
    const fs = createOverlayFileSystem({ real, overlay });

    const deleted = await fs.delete?.("note.txt");
    expect(deleted?.ok).toBe(true);

    const readAfter = await fs.read("note.txt");
    const realAfter = await real.read("note.txt");
    expect(readAfter.ok).toBe(false);
    expect(!readAfter.ok && readAfter.error.code).toBe("NOT_FOUND");
    expect(realAfter.ok && realAfter.value.content).toBe("real\n");
  });

  test("does not expose delete when overlay backend cannot persist deletes", () => {
    const real = createMemoryFileSystem("real", { "note.txt": "real\n" });
    const {
      delete: _delete,
      rename: _rename,
      ...overlayWithoutDelete
    } = createMemoryFileSystem("overlay");

    const fs = createOverlayFileSystem({ real, overlay: overlayWithoutDelete });

    expect(fs.delete).toBeUndefined();
    expect(fs.rename).toBeUndefined();
  });

  test("list merges real files with overlay writes and masks deleted paths", async () => {
    const real = createMemoryFileSystem("real", {
      "deleted.txt": "real deleted\n",
      "real.txt": "real\n",
    });
    const overlay = createMemoryFileSystem("overlay");
    const fs = createOverlayFileSystem({ real, overlay });

    await fs.write("overlay.txt", "overlay\n");
    await fs.delete?.("deleted.txt");
    const listed = await fs.list(".");

    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.value.entries.map((entry) => entry.path).sort()).toEqual([
      "overlay.txt",
      "real.txt",
    ]);
  });

  test("search merges real matches with overlay matches and suppresses stale real matches", async () => {
    const real = createMemoryFileSystem("real", {
      "changed.txt": "needle from real\n",
      "real.txt": "needle real\n",
    });
    const overlay = createMemoryFileSystem("overlay");
    const fs = createOverlayFileSystem({ real, overlay });

    await fs.write("changed.txt", "no match here\n");
    await fs.write("overlay.txt", "needle overlay\n");
    const searched = await fs.search("needle");

    expect(searched.ok).toBe(true);
    if (!searched.ok) return;
    expect(searched.value.matches.map((match) => match.path).sort()).toEqual([
      "overlay.txt",
      "real.txt",
    ]);
  });
});
