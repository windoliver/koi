/**
 * Tests for the Nexus-backed FileSystemBackend.
 *
 * Runs the shared contract suite + Nexus-specific tests.
 */

import { describe, expect, test } from "bun:test";
import type { FileSystemBackend } from "@koi/core";
import { runFileSystemBackendContractTests } from "./contract-tests.js";
import { createNexusFileSystem } from "./nexus-filesystem-backend.js";
import { createFakeNexusTransport } from "./test-helpers.js";
import type { NexusTransport } from "./types.js";

// ---------------------------------------------------------------------------
// Contract tests — proves NexusFileSystem satisfies FileSystemBackend
// ---------------------------------------------------------------------------

describe("NexusFileSystem contract", () => {
  runFileSystemBackendContractTests(() =>
    createNexusFileSystem({
      url: "http://fake",
      transport: createFakeNexusTransport(),
    }),
  );
});

// ---------------------------------------------------------------------------
// Nexus-specific tests
// ---------------------------------------------------------------------------

describe("NexusFileSystem specifics", () => {
  test("backend name is 'nexus'", () => {
    const backend = createNexusFileSystem({
      url: "http://fake",
      transport: createFakeNexusTransport(),
    });
    expect(backend.name).toBe("nexus");
  });

  test("custom mountPoint prefixes paths", async () => {
    const transport = createFakeNexusTransport();
    const backend = createNexusFileSystem({
      url: "http://fake",
      mountPoint: "workspace/agent1",
      transport,
    });
    // Write through the backend
    await backend.write("/hello.txt", "test");
    // Read should succeed through the same mount
    const result = await backend.read("/hello.txt");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.content).toBe("test");
  });

  test("injected transports without an explicit mountPoint span the full Nexus namespace", async () => {
    const transport = createFakeNexusTransport();
    const backend = createNexusFileSystem({
      url: "http://fake",
      transport,
    });

    await backend.write("/gmail/inbox/message.eml", "mail");
    await backend.write("/gdrive/team/doc.txt", "doc");

    const gmailRead = await backend.read("/gmail/inbox/message.eml");
    const gdriveRead = await backend.read("/gdrive/team/doc.txt");

    expect(gmailRead.ok).toBe(true);
    expect(gdriveRead.ok).toBe(true);
    if (gmailRead.ok) expect(gmailRead.value.content).toBe("mail");
    if (gdriveRead.ok) expect(gdriveRead.value.content).toBe("doc");
  });

  test("path traversal is rejected", async () => {
    const backend = createNexusFileSystem({
      url: "http://fake",
      transport: createFakeNexusTransport(),
    });
    const result = await backend.read("../../../etc/passwd");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("VALIDATION");
  });

  test("null bytes in path are rejected", async () => {
    const backend = createNexusFileSystem({
      url: "http://fake",
      transport: createFakeNexusTransport(),
    });
    const result = await backend.read("file\0.txt");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("VALIDATION");
  });

  test("edit delegates to Nexus when available", async () => {
    const transport = createFakeNexusTransport();
    const backend = createNexusFileSystem({ url: "http://fake", transport });
    await backend.write("/edit-delegate.txt", "hello world");
    const result = await backend.edit("/edit-delegate.txt", [
      { oldText: "hello", newText: "goodbye" },
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.hunksApplied).toBe(1);
  });

  test("edit falls back to composite when Nexus edit unavailable", async () => {
    const transport = createFakeNexusTransport({
      failMethod: "edit",
      failCode: -32601,
      failMessage: "method not found",
    });
    const backend = createNexusFileSystem({ url: "http://fake", transport });
    await backend.write("/edit-fallback.txt", "hello world");
    const result = await backend.edit("/edit-fallback.txt", [
      { oldText: "hello", newText: "goodbye" },
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.hunksApplied).toBe(1);

    const read = await backend.read("/edit-fallback.txt");
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.value.content).toBe("goodbye world");
  });

  test("dispose closes transport", () => {
    const transport = createFakeNexusTransport();
    const backend = createNexusFileSystem({ url: "http://fake", transport });
    expect(backend.dispose).toBeDefined();
    backend.dispose?.();
    // After dispose, operations should fail
  });

  test("search delegates to grep RPC", async () => {
    const transport = createFakeNexusTransport();
    const backend = createNexusFileSystem({ url: "http://fake", transport });
    await backend.write("/search/file.ts", "const foo = 42;\nconst bar = 99;");
    const result = await backend.search("foo");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.matches.length).toBeGreaterThanOrEqual(1);
      expect(result.value.matches[0]?.text).toContain("foo");
    }
  });

  test("semanticSearch delegates to semantic_search RPC", async () => {
    const transport = createFakeNexusTransport();
    const backend = createNexusFileSystem({
      url: "http://fake",
      transport,
    }) as FileSystemBackend & {
      readonly semanticSearch?: (
        query: string,
        options?: {
          readonly scope?: string;
          readonly maxResults?: number;
          readonly minScore?: number;
        },
      ) => Promise<
        | {
            readonly ok: true;
            readonly value: {
              readonly results: readonly {
                readonly path: string;
                readonly snippet: string;
                readonly score: number;
                readonly lineStart: number;
                readonly lineEnd: number;
              }[];
              readonly warning?: string;
            };
          }
        | { readonly ok: false }
      >;
    };
    await backend.write("/semantic/auth.ts", "retry logic with exponential backoff");

    expect(typeof backend.semanticSearch).toBe("function");
    const result = await backend.semanticSearch?.("retry logic", {
      scope: "semantic/**/*.ts",
      maxResults: 5,
      minScore: 0.3,
    });
    expect(result?.ok).toBe(true);
    if (result?.ok) {
      expect(result.value.results.length).toBeGreaterThanOrEqual(1);
      expect(result.value.results[0]?.path).toContain("auth.ts");
      expect(result.value.results[0]?.score).toBeGreaterThan(0);
    }
  });

  test("semanticSearch accepts wrapped HTTP RPC responses", async () => {
    const transport = createFakeNexusTransport();
    const backend = createNexusFileSystem({
      url: "http://fake",
      transport,
    }) as FileSystemBackend & {
      readonly semanticSearch?: (query: string) => Promise<
        | {
            readonly ok: true;
            readonly value: {
              readonly results: readonly {
                readonly path: string;
                readonly snippet: string;
                readonly score: number;
                readonly lineStart: number;
                readonly lineEnd: number;
              }[];
            };
          }
        | { readonly ok: false }
      >;
    };

    await backend.write("/semantic/http-shape.ts", "semantic transport shape");
    const result = await backend.semanticSearch?.("transport shape");
    expect(result?.ok).toBe(true);
    if (result?.ok) {
      expect(result.value.results[0]?.path).toContain("http-shape.ts");
    }
  });

  test("semanticSearch over-fetches so scope filter cannot drop in-scope matches", async () => {
    const transport = createFakeNexusTransport();
    const backend = createNexusFileSystem({
      url: "http://fake",
      transport,
    }) as FileSystemBackend & {
      readonly semanticSearch?: (
        query: string,
        options?: {
          readonly scope?: string;
          readonly maxResults?: number;
          readonly minScore?: number;
        },
      ) => Promise<
        | {
            readonly ok: true;
            readonly value: {
              readonly results: readonly { readonly path: string }[];
              readonly warning?: string;
            };
          }
        | { readonly ok: false }
      >;
    };

    // 8 out-of-scope files containing the query come first by insertion
    // order, then 2 in-scope files. With pre-fix behaviour fetchLimit=2
    // would slice off both in-scope hits before the client-side scope
    // filter ever saw them.
    for (let i = 0; i < 8; i++) {
      await backend.write(`/other/file-${i}.ts`, "needle in haystack");
    }
    await backend.write("/scoped/a.ts", "needle in scoped a");
    await backend.write("/scoped/b.ts", "needle in scoped b");

    const result = await backend.semanticSearch?.("needle", {
      scope: "scoped/**",
      maxResults: 2,
    });
    expect(result?.ok).toBe(true);
    if (result?.ok) {
      expect(result.value.results.map((r) => r.path).sort()).toEqual([
        "/scoped/a.ts",
        "/scoped/b.ts",
      ]);
    }
  });

  test("semanticSearch keeps over-fetch headroom even when maxResults exceeds the cap", async () => {
    // Regression: previous formula collapsed `fetchLimit` back to
    // `requestedLimit` once `requestedLimit*FACTOR` exceeded the cap, so
    // a leading run of out-of-scope hits could starve all in-scope ones.
    let observedLimit: number | undefined;
    type SemanticSearchOptions = {
      readonly scope?: string;
      readonly maxResults?: number;
      readonly minScore?: number;
    };
    type SemanticSearchOk = {
      readonly ok: true;
      readonly value: { readonly results: readonly unknown[]; readonly warning?: string };
    };
    const transport: NexusTransport = {
      call: async <T>(method: string, params?: Record<string, unknown>) => {
        if (method === "semantic_search") {
          observedLimit = params?.limit as number | undefined;
          return { ok: true, value: { results: [] } as T };
        }
        return { ok: true, value: undefined as T };
      },
      close: () => {},
      subscribe: () => () => {},
      submitAuthCode: () => {},
    };
    const backend = createNexusFileSystem({
      url: "http://fake",
      transport,
    }) as FileSystemBackend & {
      readonly semanticSearch?: (
        query: string,
        options?: SemanticSearchOptions,
      ) => Promise<SemanticSearchOk | { readonly ok: false }>;
    };
    await backend.semanticSearch?.("needle", { scope: "any/**", maxResults: 300 });
    expect(observedLimit).toBeGreaterThan(300);
  });

  test("semanticSearch never under-fetches when caller's maxResults exceeds the over-fetch cap", async () => {
    const transport = createFakeNexusTransport();
    const backend = createNexusFileSystem({
      url: "http://fake",
      transport,
    }) as FileSystemBackend & {
      readonly semanticSearch?: (
        query: string,
        options?: {
          readonly scope?: string;
          readonly maxResults?: number;
        },
      ) => Promise<
        | {
            readonly ok: true;
            readonly value: { readonly results: readonly { readonly path: string }[] };
          }
        | { readonly ok: false }
      >;
    };
    // Seed 250 in-scope files. Caller asks for 250 with scope active; cap
    // (200) must NOT clip the request, otherwise the contract is silently
    // broken on large repos.
    for (let i = 0; i < 250; i++) {
      await backend.write(`/big/f${i}.ts`, "needle text");
    }
    const result = await backend.semanticSearch?.("needle", {
      scope: "big/**",
      maxResults: 250,
    });
    expect(result?.ok).toBe(true);
    if (result?.ok) {
      expect(result.value.results.length).toBe(250);
    }
  });

  test("list returns structured entries with kind", async () => {
    const transport = createFakeNexusTransport();
    const backend = createNexusFileSystem({ url: "http://fake", transport });
    await backend.write("/list-test/file.txt", "content");
    const result = await backend.list("/list-test");
    expect(result.ok).toBe(true);
    if (result.ok) {
      const fileEntry = result.value.entries.find((e) => e.path.endsWith("file.txt"));
      expect(fileEntry).toBeDefined();
      expect(fileEntry?.kind).toBe("file");
    }
  });
});
