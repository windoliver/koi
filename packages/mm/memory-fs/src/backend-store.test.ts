import { describe, expect, test } from "bun:test";
import type {
  FileDeleteResult,
  FileEdit,
  FileEditResult,
  FileListEntry,
  FileListResult,
  FileReadResult,
  FileSearchResult,
  FileSystemBackend,
  FileWriteOptions,
  FileWriteResult,
  KoiError,
  Result,
} from "@koi/core";
import { memoryRecordId } from "@koi/core/memory";
import { createFileSystemMemoryStore } from "./backend-store.js";

interface StoredFile {
  content: string;
  modifiedAt: number;
}

interface SemanticHit {
  readonly path: string;
  readonly snippet: string;
  readonly score: number;
  readonly lineStart: number;
  readonly lineEnd: number;
}

type MemoryTestBackend = FileSystemBackend & {
  readonly semanticSearch: (
    query: string,
    options?: { readonly scope?: string; readonly maxResults?: number; readonly minScore?: number },
  ) => Promise<Result<{ readonly results: readonly SemanticHit[] }, KoiError>>;
  readonly writeRaw: (path: string, content: string) => void;
};

function err(code: KoiError["code"], message: string): Result<never, KoiError> {
  return { ok: false, error: { code, message, retryable: false } };
}

function normalizePath(path: string): string {
  const prefixed = path.startsWith("/") ? path : `/${path}`;
  const parts: string[] = [];
  for (const part of prefixed.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") throw new Error(`path escapes root: ${path}`);
    parts.push(part);
  }
  return `/${parts.join("/")}`;
}

function globMatch(path: string, glob: string): boolean {
  if (glob === "**/*.md") return path.endsWith(".md");
  if (glob === "memory/**") return path.startsWith("/memory/");
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "<<GLOBSTAR>>")
    .replace(/\*/g, "[^/]*")
    .replace(/<<GLOBSTAR>>/g, ".*");
  return new RegExp(`^/?${escaped}$`).test(path);
}

function createMemoryTestBackend(): MemoryTestBackend {
  const files = new Map<string, StoredFile>();

  return {
    name: "test-nexus",
    read(path): Result<FileReadResult, KoiError> {
      const normalized = normalizePath(path);
      const file = files.get(normalized);
      if (file === undefined) return err("NOT_FOUND", `not found: ${normalized}`);
      return {
        ok: true,
        value: {
          path: normalized,
          content: file.content,
          size: new TextEncoder().encode(file.content).byteLength,
        },
      };
    },
    write(path, content, _options?: FileWriteOptions): Result<FileWriteResult, KoiError> {
      const normalized = normalizePath(path);
      files.set(normalized, { content, modifiedAt: Date.now() });
      return {
        ok: true,
        value: {
          path: normalized,
          bytesWritten: new TextEncoder().encode(content).byteLength,
        },
      };
    },
    edit(_path: string, _edits: readonly FileEdit[]): Result<FileEditResult, KoiError> {
      return err("INTERNAL", "edit not implemented");
    },
    list(path, options): Result<FileListResult, KoiError> {
      const normalized = normalizePath(path);
      const prefix = normalized === "/" ? "/" : `${normalized}/`;
      const entries: FileListEntry[] = [];
      for (const [filePath, file] of files) {
        if (!filePath.startsWith(prefix) && filePath !== normalized) continue;
        const relative = filePath.slice(prefix.length);
        if (options?.recursive !== true && relative.includes("/")) continue;
        if (options?.glob !== undefined && !globMatch(filePath, options.glob)) continue;
        entries.push({
          path: filePath,
          kind: "file",
          size: new TextEncoder().encode(file.content).byteLength,
          modifiedAt: file.modifiedAt,
        });
      }
      return { ok: true, value: { entries, truncated: false } };
    },
    search(_pattern: string): Result<FileSearchResult, KoiError> {
      return { ok: true, value: { matches: [], truncated: false } };
    },
    delete(path): Result<FileDeleteResult, KoiError> {
      const normalized = normalizePath(path);
      if (!files.delete(normalized)) return err("NOT_FOUND", `not found: ${normalized}`);
      return { ok: true, value: { path: normalized } };
    },
    async semanticSearch(
      query,
      options,
    ): Promise<Result<{ readonly results: readonly SemanticHit[] }, KoiError>> {
      const needle = query.toLowerCase();
      const results: SemanticHit[] = [];
      for (const [path, file] of files) {
        if (options?.scope !== undefined && !globMatch(path, options.scope)) continue;
        if (!file.content.toLowerCase().includes(needle)) continue;
        results.push({
          path,
          snippet: file.content,
          score: 0.9,
          lineStart: 1,
          lineEnd: 1,
        });
      }
      return { ok: true, value: { results: results.slice(0, options?.maxResults ?? 10) } };
    },
    writeRaw(path, content): void {
      files.set(normalizePath(path), { content, modifiedAt: Date.now() });
    },
  };
}

describe("createFileSystemMemoryStore", () => {
  test("writes, reads, lists, and rebuilds MEMORY.md under /memory", async () => {
    const fs = createMemoryTestBackend();
    const store = createFileSystemMemoryStore({ fs });

    const written = await store.write({
      name: "User Role",
      description: "User works on data infrastructure",
      type: "user",
      content: "The user maintains streaming data pipelines.",
    });

    expect(written.action).toBe("created");
    expect(written.record.filePath).toBe("user_role.md");

    const read = await store.read(written.record.id);
    expect(read?.content).toBe("The user maintains streaming data pipelines.");

    const listed = await store.list();
    expect(listed.map((record) => record.name)).toEqual(["User Role"]);

    const index = await fs.read("/memory/MEMORY.md");
    expect(index.ok).toBe(true);
    if (index.ok) {
      expect(index.value.content).toContain("User Role");
      expect(index.value.content).toContain("user_role.md");
    }
  });

  test("updates and deletes records through the backend namespace", async () => {
    const fs = createMemoryTestBackend();
    const store = createFileSystemMemoryStore({ fs });
    const written = await store.write({
      name: "Project Status",
      description: "Current project state",
      type: "project",
      content: "The Nexus memory backend is in design.",
    });

    const updated = await store.update(written.record.id, {
      content: "The Nexus memory backend is in implementation.",
    });
    expect(updated.record.content).toContain("implementation");

    const deleted = await store.delete(written.record.id);
    expect(deleted.deleted).toBe(true);
    expect(await store.read(written.record.id)).toBeUndefined();
    expect(await store.list()).toEqual([]);
  });

  test("skips malformed records while preserving valid records", async () => {
    const fs = createMemoryTestBackend();
    fs.writeRaw("/memory/bad.md", "not frontmatter");
    fs.writeRaw(
      "/memory/good.md",
      [
        "---",
        "name: Good Memory",
        "description: Valid record",
        "type: feedback",
        "---",
        "",
        "Always keep malformed records out of trusted recall.",
      ].join("\n"),
    );
    const store = createFileSystemMemoryStore({ fs });

    const listed = await store.list();
    expect(listed.length).toBe(1);
    expect(listed[0]?.name).toBe("Good Memory");
    expect(await store.read(memoryRecordId("bad"))).toBeUndefined();
  });

  test("persists across store instances that share a Nexus-backed namespace", async () => {
    const fs = createMemoryTestBackend();
    const firstSession = createFileSystemMemoryStore({ fs, memoryDir: "/memory" });
    const secondSession = createFileSystemMemoryStore({ fs, memoryDir: "/memory" });

    const written = await firstSession.write({
      name: "Cross Session",
      description: "Persisted through shared Nexus namespace",
      type: "project",
      content: "Future sessions can recall this memory from Nexus.",
    });

    const recalled = await secondSession.read(written.record.id);
    expect(recalled?.name).toBe("Cross Session");
    expect((await secondSession.list()).map((record) => record.id)).toContain(written.record.id);
  });

  test("upserts by canonical name and type without creating duplicate files", async () => {
    const fs = createMemoryTestBackend();
    const store = createFileSystemMemoryStore({ fs });

    const created = await store.upsert(
      {
        name: "Canonical\nName",
        description: "Initial description",
        type: "feedback",
        content: "The first validated implementation note.",
      },
      { force: true },
    );
    expect(created.action).toBe("created");

    const updated = await store.upsert(
      {
        name: "Canonical Name",
        description: "Updated description",
        type: "feedback",
        content: "The second validated implementation note.",
      },
      { force: true },
    );
    expect(updated.action).toBe("updated");

    const listed = await store.list();
    expect(listed.length).toBe(1);
    expect(listed[0]?.name).toBe("Canonical Name");
    expect(listed[0]?.description).toBe("Updated description");
    expect(listed[0]?.content).toBe("The second validated implementation note.");
  });

  test("writes searchable markdown that Nexus semantic search can discover", async () => {
    const fs = createMemoryTestBackend();
    const store = createFileSystemMemoryStore({ fs });

    await store.write({
      name: "Searchable Memory",
      description: "Semantic indexing should see this file",
      type: "reference",
      content: "The vector pipeline stores searchable memory records under Nexus.",
    });

    const result = await fs.semanticSearch("vector pipeline", {
      scope: "memory/**",
      maxResults: 10,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.results.map((hit) => hit.path)).toContain("/memory/searchable_memory.md");
    }
  });
});
