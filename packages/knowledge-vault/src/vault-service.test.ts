import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { FileSystemBackend } from "@koi/core";
import type { FileSystemScope } from "@koi/scope";
import type { KnowledgeVaultConfig } from "./types.js";
import { createVaultService } from "./vault-service.js";

const tempDirs: string[] = [];

async function createTestVault(
  docs: readonly { readonly path: string; readonly content: string }[],
): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "kv-vs-"));
  tempDirs.push(dir);
  for (const doc of docs) {
    await Bun.write(join(dir, doc.path), doc.content);
  }
  return dir;
}

afterEach(async () => {
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true });
  }
  tempDirs.length = 0;
});

describe("createVaultService", () => {
  test("creates service from directory source and answers queries", async () => {
    const dir = await createTestVault([
      {
        path: "auth.md",
        content:
          "---\ntitle: Authentication\ntags: [auth, security]\n---\nJWT tokens, OAuth2 flows, session management.",
      },
      {
        path: "api.md",
        content:
          "---\ntitle: API Design\ntags: [api, rest]\n---\nREST endpoints, pagination, error handling.",
      },
      {
        path: "database.md",
        content:
          "---\ntitle: Database\ntags: [database, sql]\n---\nPostgreSQL schema, migrations, indexing.",
      },
    ]);

    const config: KnowledgeVaultConfig = {
      sources: [{ kind: "directory", path: dir, name: "docs" }],
      tokenBudget: 4000,
    };

    const result = await createVaultService(config);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const service = result.value;
    expect(service.sources).toHaveLength(1);
    expect(service.sources[0]?.documentCount).toBe(3);

    // Query for authentication-related docs
    const docs = await service.query("authentication JWT");
    expect(docs.length).toBeGreaterThanOrEqual(1);
    expect(docs[0]?.title).toBe("Authentication");
  });

  test("returns empty results for empty query", async () => {
    const dir = await createTestVault([{ path: "doc.md", content: "Some content." }]);

    const config: KnowledgeVaultConfig = {
      sources: [{ kind: "directory", path: dir }],
    };

    const result = await createVaultService(config);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const docs = await result.value.query("");
    expect(docs).toHaveLength(0);
  });

  test("refresh rebuilds index with new documents", async () => {
    const dir = await createTestVault([
      { path: "initial.md", content: "Initial content about security." },
    ]);

    const config: KnowledgeVaultConfig = {
      sources: [{ kind: "directory", path: dir }],
    };

    const result = await createVaultService(config);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const service = result.value;
    expect(service.sources[0]?.documentCount).toBe(1);

    // Add a new file
    await Bun.write(join(dir, "new.md"), "New content about deployment.");

    const refreshResult = await service.refresh();
    expect(refreshResult.documentCount).toBe(2);
  });

  test("handles empty directory source", async () => {
    const dir = await createTestVault([]);

    const config: KnowledgeVaultConfig = {
      sources: [{ kind: "directory", path: dir }],
    };

    const result = await createVaultService(config);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const docs = await result.value.query("anything");
    expect(docs).toHaveLength(0);
  });

  test("respects relevanceThreshold filter", async () => {
    const dir = await createTestVault([
      {
        path: "exact.md",
        content: "---\ntitle: Exact Match\n---\nauthentication authentication authentication",
      },
      {
        path: "vague.md",
        content: "---\ntitle: Vague\n---\ngeneral content about many topics",
      },
    ]);

    const config: KnowledgeVaultConfig = {
      sources: [{ kind: "directory", path: dir }],
      relevanceThreshold: 0.5,
    };

    const result = await createVaultService(config);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const docs = await result.value.query("authentication");
    // "vague.md" should be filtered out by threshold
    for (const doc of docs) {
      expect(doc.relevanceScore).toBeGreaterThanOrEqual(0.5);
    }
  });

  test("query limit caps number of results", async () => {
    const dir = await createTestVault([
      { path: "a.md", content: "topic one details" },
      { path: "b.md", content: "topic two details" },
      { path: "c.md", content: "topic three details" },
    ]);

    const config: KnowledgeVaultConfig = {
      sources: [{ kind: "directory", path: dir }],
    };

    const result = await createVaultService(config);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const docs = await result.value.query("topic", 1);
    expect(docs.length).toBeLessThanOrEqual(1);
  });

  test("description surfaces in source info", async () => {
    const dir = await createTestVault([{ path: "doc.md", content: "Some content about auth." }]);

    const config: KnowledgeVaultConfig = {
      sources: [
        {
          kind: "directory",
          path: dir,
          name: "docs",
          description: "Internal engineering docs",
        },
      ],
    };

    const result = await createVaultService(config);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.sources).toHaveLength(1);
    expect(result.value.sources[0]?.description).toBe("Internal engineering docs");
  });

  test("scope wraps backend when both provided", async () => {
    const tmpRoot = await createTestVault([]);
    const absRoot = resolve(tmpRoot);
    const insidePath = join(absRoot, "inside.md");

    // Track which paths are read
    const readPaths: string[] = [];
    const mockBackend: FileSystemBackend = {
      name: "scoped-test",
      list: () => ({
        ok: true,
        value: {
          entries: [{ path: insidePath, kind: "file" as const }],
          truncated: false,
        },
      }),
      read: (path) => {
        readPaths.push(path);
        return {
          ok: true,
          value: { content: "Scoped content.", path, size: 15 },
        };
      },
      write: () => {
        throw new Error("Not implemented");
      },
      edit: () => {
        throw new Error("Not implemented");
      },
      search: () => {
        throw new Error("Not implemented");
      },
    };

    const scope: FileSystemScope = { root: absRoot, mode: "ro" };

    const config: KnowledgeVaultConfig = {
      sources: [
        {
          kind: "directory",
          path: absRoot,
          backend: mockBackend,
        },
      ],
      scope,
    };

    const result = await createVaultService(config);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // The backend should have been wrapped — read() should receive resolved paths
    expect(readPaths.length).toBeGreaterThanOrEqual(1);
    expect(result.value.sources[0]?.documentCount).toBe(1);
  });
});
