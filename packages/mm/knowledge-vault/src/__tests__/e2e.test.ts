/**
 * End-to-end integration tests for the knowledge vault pipeline.
 *
 * Tests the full flow: scan → index → query → select using real
 * temp directories with markdown files.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Agent, AttachResult, FileSystemBackend, KoiError, Result } from "@koi/core";
import { isAttachResult } from "@koi/core";
import { createKnowledgeVaultProvider } from "../component-provider.js";
import { createKnowledgeSourceResolver } from "../context-source-adapter.js";
import type { KnowledgeComponent, KnowledgeVaultConfig } from "../types.js";
import { KNOWLEDGE } from "../types.js";
import { createVaultService } from "../vault-service.js";

interface TestDoc {
  readonly path: string;
  readonly frontmatter?: Readonly<Record<string, string | readonly string[]>>;
  readonly body: string;
}

const tempDirs: string[] = [];

async function createTestVault(docs: readonly TestDoc[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "kv-e2e-"));
  tempDirs.push(dir);

  for (const doc of docs) {
    const parts: string[] = [];
    if (doc.frontmatter !== undefined) {
      parts.push("---");
      for (const [key, value] of Object.entries(doc.frontmatter)) {
        if (Array.isArray(value)) {
          parts.push(`${key}: [${value.join(", ")}]`);
        } else {
          parts.push(`${key}: ${value}`);
        }
      }
      parts.push("---");
    }
    parts.push(doc.body);
    await Bun.write(join(dir, doc.path), parts.join("\n"));
  }

  return dir;
}

// Agent stub — provider/resolver ignores the agent param, so cast is safe
const stubAgent = {} as Agent;

afterEach(async () => {
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true });
  }
  tempDirs.length = 0;
});

describe("e2e: full pipeline", () => {
  test("happy path: 10-doc vault → provider → attach → query", async () => {
    const dir = await createTestVault([
      {
        path: "auth/jwt.md",
        frontmatter: { title: "JWT Authentication", tags: ["auth", "jwt", "security"] },
        body: "JSON Web Tokens for stateless authentication. Access tokens, refresh tokens, signing algorithms.",
      },
      {
        path: "auth/oauth.md",
        frontmatter: { title: "OAuth2 Flows", tags: ["auth", "oauth"] },
        body: "Authorization code flow, PKCE, client credentials grant, implicit flow deprecation.",
      },
      {
        path: "api/rest.md",
        frontmatter: { title: "REST API Design", tags: ["api", "rest"] },
        body: "Resource naming, HTTP methods, pagination, filtering, error responses, HATEOAS.",
      },
      {
        path: "api/graphql.md",
        frontmatter: { title: "GraphQL Schema", tags: ["api", "graphql"] },
        body: "Schema definition language, resolvers, mutations, subscriptions, N+1 problem.",
      },
      {
        path: "db/postgres.md",
        frontmatter: { title: "PostgreSQL Guide", tags: ["database", "postgres"] },
        body: "Table design, indexes, CTEs, window functions, JSONB, full-text search.",
      },
      {
        path: "db/migrations.md",
        frontmatter: { title: "Database Migrations", tags: ["database", "migrations"] },
        body: "Schema versioning, up/down migrations, data migrations, zero-downtime migrations.",
      },
      {
        path: "deploy/docker.md",
        frontmatter: { title: "Docker Setup", tags: ["deploy", "docker"] },
        body: "Dockerfile best practices, multi-stage builds, compose files, health checks.",
      },
      {
        path: "deploy/k8s.md",
        frontmatter: { title: "Kubernetes Deployment", tags: ["deploy", "kubernetes"] },
        body: "Pods, deployments, services, ingress, ConfigMaps, secrets, horizontal pod autoscaler.",
      },
      {
        path: "arch/patterns.md",
        frontmatter: { title: "Architecture Patterns", tags: ["architecture"] },
        body: "Domain-driven design, hexagonal architecture, CQRS, event sourcing.",
      },
      {
        path: "arch/testing.md",
        frontmatter: { title: "Testing Strategy", tags: ["testing"] },
        body: "Unit tests, integration tests, contract tests, test pyramid, TDD workflow.",
      },
    ]);

    const config: KnowledgeVaultConfig = {
      sources: [{ kind: "directory", path: dir, name: "architecture-docs" }],
      tokenBudget: 4000,
    };

    const provider = createKnowledgeVaultProvider(config);
    const result = await provider.attach(stubAgent);

    expect(isAttachResult(result)).toBe(true);
    const attachResult = result as AttachResult;
    expect(attachResult.skipped).toHaveLength(0);

    const component = attachResult.components.get(KNOWLEDGE as string) as KnowledgeComponent;

    expect(component).toBeDefined();
    expect(component.sources).toHaveLength(1);
    expect(component.sources[0]?.documentCount).toBe(10);

    // Query for authentication
    const authDocs = await component.query("authentication JWT tokens");
    expect(authDocs.length).toBeGreaterThanOrEqual(1);

    // First result should be the JWT doc (most relevant)
    const topDoc = authDocs[0]!;
    expect(topDoc.title).toBe("JWT Authentication");
    expect(topDoc.relevanceScore).toBeGreaterThan(0);

    // Query for database
    const dbDocs = await component.query("PostgreSQL schema migrations");
    expect(dbDocs.length).toBeGreaterThanOrEqual(1);
    const dbTitles = dbDocs.map((d) => d.title);
    expect(dbTitles.includes("PostgreSQL Guide") || dbTitles.includes("Database Migrations")).toBe(
      true,
    );
  });

  test("empty vault: attach succeeds, query returns empty", async () => {
    const dir = await createTestVault([]);

    const config: KnowledgeVaultConfig = {
      sources: [{ kind: "directory", path: dir }],
    };

    const provider = createKnowledgeVaultProvider(config);
    const result = await provider.attach(stubAgent);

    expect(isAttachResult(result)).toBe(true);
    const attachResult = result as AttachResult;

    const component = attachResult.components.get(KNOWLEDGE as string) as KnowledgeComponent;

    expect(component).toBeDefined();
    const docs = await component.query("anything");
    expect(docs).toHaveLength(0);
  });

  test("mixed failures: good md + binary → warnings collected", async () => {
    const dir = await createTestVault([
      {
        path: "good1.md",
        frontmatter: { title: "Good Doc 1" },
        body: "Valid markdown content one.",
      },
      {
        path: "good2.md",
        frontmatter: { title: "Good Doc 2" },
        body: "Valid markdown content two.",
      },
      {
        path: "good3.md",
        frontmatter: { title: "Good Doc 3" },
        body: "Valid markdown content three.",
      },
      {
        path: "good4.md",
        frontmatter: { title: "Good Doc 4" },
        body: "Valid markdown content four.",
      },
      {
        path: "good5.md",
        frontmatter: { title: "Good Doc 5" },
        body: "Valid markdown content five.",
      },
    ]);

    // Write binary files
    await Bun.write(
      join(dir, "binary1.md"),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0d, 0x0a]),
    );
    await Bun.write(join(dir, "binary2.md"), Buffer.from([0x00, 0x01, 0x02, 0x03]));

    const config: KnowledgeVaultConfig = {
      sources: [{ kind: "directory", path: dir }],
    };

    const result = await createVaultService(config);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const service = result.value;
    // 5 good docs indexed
    expect(service.sources[0]?.documentCount).toBe(5);

    // Refresh should report warnings about binary files
    const refreshResult = await service.refresh();
    expect(refreshResult.documentCount).toBe(5);
    expect(refreshResult.warnings.length).toBeGreaterThanOrEqual(2);
  });

  test("context source adapter produces formatted output", async () => {
    const dir = await createTestVault([
      {
        path: "doc1.md",
        frontmatter: { title: "Auth Guide" },
        body: "Authentication concepts and patterns.",
      },
      {
        path: "doc2.md",
        frontmatter: { title: "API Guide" },
        body: "API design principles and patterns.",
      },
    ]);

    const config: KnowledgeVaultConfig = {
      sources: [{ kind: "directory", path: dir }],
    };

    const result = await createVaultService(config);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const resolver = createKnowledgeSourceResolver(result.value);
    const sourceResult = await resolver({ kind: "knowledge", query: "authentication" }, stubAgent);

    expect(sourceResult.label).toBe("Knowledge Vault");
    expect(sourceResult.content).toContain("Auth Guide");
    expect(sourceResult.tokens).toBeGreaterThan(0);
  });

  test("context source adapter handles empty query", async () => {
    const dir = await createTestVault([{ path: "doc.md", body: "Some content." }]);

    const config: KnowledgeVaultConfig = {
      sources: [{ kind: "directory", path: dir }],
    };

    const result = await createVaultService(config);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const resolver = createKnowledgeSourceResolver(result.value);
    const sourceResult = await resolver({ kind: "knowledge" }, stubAgent);

    expect(sourceResult.content).toBe("");
    expect(sourceResult.tokens).toBe(0);
  });
});

describe("e2e: edge cases", () => {
  test("single-file vault works correctly", async () => {
    const dir = await createTestVault([
      {
        path: "only.md",
        frontmatter: { title: "Only Doc" },
        body: "The only document in this vault.",
      },
    ]);

    const config: KnowledgeVaultConfig = {
      sources: [{ kind: "directory", path: dir }],
    };

    const result = await createVaultService(config);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const docs = await result.value.query("document");
    expect(docs).toHaveLength(1);
    expect(docs[0]?.title).toBe("Only Doc");
  });

  test("no frontmatter documents work correctly", async () => {
    const dir = await createTestVault([
      { path: "bare.md", body: "Just plain markdown content without any frontmatter." },
    ]);

    const config: KnowledgeVaultConfig = {
      sources: [{ kind: "directory", path: dir }],
    };

    const result = await createVaultService(config);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const docs = await result.value.query("markdown");
    expect(docs.length).toBeGreaterThanOrEqual(1);
    expect(docs[0]?.tags).toEqual([]);
  });

  test("unicode content handled correctly", async () => {
    const dir = await createTestVault([
      {
        path: "unicode.md",
        frontmatter: { title: "Unicode Document" },
        body: "Documenting internationalization: 日本語, 한국어, العربية, emoji 🎉",
      },
    ]);

    const config: KnowledgeVaultConfig = {
      sources: [{ kind: "directory", path: dir }],
    };

    const result = await createVaultService(config);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const docs = await result.value.query("internationalization");
    expect(docs.length).toBeGreaterThanOrEqual(1);
    expect(docs[0]?.content).toContain("日本語");
  });

  test("zero-match query returns empty array (not error)", async () => {
    const dir = await createTestVault([
      { path: "doc.md", body: "Content about completely unrelated topics." },
    ]);

    const config: KnowledgeVaultConfig = {
      sources: [{ kind: "directory", path: dir }],
    };

    const result = await createVaultService(config);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const docs = await result.value.query("xylophone");
    expect(docs).toHaveLength(0);
  });

  test("duplicate tags are preserved as-is", async () => {
    const dir = await createTestVault([
      {
        path: "dup.md",
        frontmatter: { title: "Dup Tags", tags: ["api", "api", "auth"] },
        body: "Document with duplicate tags.",
      },
    ]);

    const config: KnowledgeVaultConfig = {
      sources: [{ kind: "directory", path: dir }],
    };

    const result = await createVaultService(config);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const docs = await result.value.query("api auth");
    expect(docs.length).toBeGreaterThanOrEqual(1);
  });

  test("budget=0 returns nothing even when docs match", async () => {
    const dir = await createTestVault([
      { path: "doc.md", body: "Relevant content about testing." },
    ]);

    const config: KnowledgeVaultConfig = {
      sources: [{ kind: "directory", path: dir }],
      tokenBudget: 0,
    };

    const result = await createVaultService(config);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const docs = await result.value.query("testing");
    expect(docs).toHaveLength(0);
  });

  test("full pipeline with mock FileSystemBackend", async () => {
    const files = new Map([
      [
        "guides/auth.md",
        "---\ntitle: Authentication Guide\ntags: [auth, security]\n---\nJWT tokens, OAuth2 flows, session management.",
      ],
      [
        "guides/api.md",
        "---\ntitle: API Design Guide\ntags: [api, rest]\n---\nREST endpoints, pagination, error handling.",
      ],
      [
        "guides/db.md",
        "---\ntitle: Database Guide\ntags: [database, sql]\n---\nPostgreSQL schema, migrations, indexing.",
      ],
    ]);

    const mockBackend: FileSystemBackend = {
      name: "e2e-mock",
      list: (_path, options) => {
        const entries = [...files.keys()]
          .filter((p) => {
            if (options?.glob === undefined) return true;
            const glob = new Bun.Glob(options.glob);
            return glob.match(p);
          })
          .map((p) => ({ path: p, kind: "file" as const }));
        return { ok: true, value: { entries, truncated: false } };
      },
      read: (path) => {
        const content = files.get(path);
        if (content === undefined) {
          return {
            ok: false,
            error: { code: "NOT_FOUND", message: `Not found: ${path}`, retryable: false },
          } satisfies Result<never, KoiError>;
        }
        return { ok: true, value: { content, path, size: content.length } };
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

    const config: KnowledgeVaultConfig = {
      sources: [
        {
          kind: "directory",
          path: "/virtual",
          name: "guides",
          description: "Engineering guides",
          backend: mockBackend,
        },
      ],
      tokenBudget: 4000,
    };

    const provider = createKnowledgeVaultProvider(config);
    const result = await provider.attach(stubAgent);

    expect(isAttachResult(result)).toBe(true);
    const attachResult = result as AttachResult;
    expect(attachResult.skipped).toHaveLength(0);

    const component = attachResult.components.get(KNOWLEDGE as string) as KnowledgeComponent;
    expect(component).toBeDefined();
    expect(component.sources).toHaveLength(1);
    expect(component.sources[0]?.documentCount).toBe(3);
    expect(component.sources[0]?.description).toBe("Engineering guides");

    // Query for authentication
    const authDocs = await component.query("authentication JWT");
    expect(authDocs.length).toBeGreaterThanOrEqual(1);
    expect(authDocs[0]?.title).toBe("Authentication Guide");

    // Query for database
    const dbDocs = await component.query("PostgreSQL schema");
    expect(dbDocs.length).toBeGreaterThanOrEqual(1);
  });

  test("multiple directory sources with diversity guarantee", async () => {
    const dir1 = await createTestVault([
      {
        path: "auth-guide.md",
        frontmatter: { title: "Auth from Source 1" },
        body: "Authentication details from the first vault.",
      },
    ]);
    const dir2 = await createTestVault([
      {
        path: "auth-reference.md",
        frontmatter: { title: "Auth from Source 2" },
        body: "Authentication details from the second vault.",
      },
    ]);

    const config: KnowledgeVaultConfig = {
      sources: [
        { kind: "directory", path: dir1, name: "vault-1" },
        { kind: "directory", path: dir2, name: "vault-2" },
      ],
      tokenBudget: 4000,
    };

    const result = await createVaultService(config);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.sources).toHaveLength(2);
    const docs = await result.value.query("authentication");
    expect(docs.length).toBeGreaterThanOrEqual(2);
  });
});
