import { describe, expect, mock, test } from "bun:test";
import type {
  AttachResult,
  FileSystemBackend,
  KoiError,
  Result,
  SkillComponent,
  Tool,
} from "@koi/core";
import { FILESYSTEM, isAttachResult, skillToken, toolToken } from "@koi/core";
import type { Retriever, SearchPage } from "@koi/search-provider";

function extractMap(
  result: AttachResult | ReadonlyMap<string, unknown>,
): ReadonlyMap<string, unknown> {
  return isAttachResult(result) ? result.components : result;
}

import { FS_SKILL_NAME } from "./constants.js";
import { createFileSystemProvider } from "./fs-component-provider.js";
import { createMockAgent, createMockBackend } from "./test-helpers.js";

function createMockRetriever(): Retriever & { readonly retrieve: ReturnType<typeof mock> } {
  const page: SearchPage = { results: [], hasMore: false };
  return {
    retrieve: mock(() =>
      Promise.resolve({ ok: true, value: page } satisfies Result<SearchPage, KoiError>),
    ),
  };
}

// ---------------------------------------------------------------------------
// createFileSystemProvider — attach
// ---------------------------------------------------------------------------

describe("createFileSystemProvider", () => {
  test("provider name includes backend name", () => {
    const backend = createMockBackend("nexus");
    const provider = createFileSystemProvider({ backend });
    expect(provider.name).toBe("filesystem:nexus");
  });

  test("attaches all 5 tools by default", async () => {
    const backend = createMockBackend("local");
    const provider = createFileSystemProvider({ backend });
    const components = extractMap(await provider.attach(createMockAgent()));

    expect(components.size).toBe(7); // 5 tools + FILESYSTEM token + 1 skill
    expect(components.has(toolToken("fs_read") as string)).toBe(true);
    expect(components.has(toolToken("fs_write") as string)).toBe(true);
    expect(components.has(toolToken("fs_edit") as string)).toBe(true);
    expect(components.has(toolToken("fs_list") as string)).toBe(true);
    expect(components.has(toolToken("fs_search") as string)).toBe(true);
  });

  test("attaches the backend under FILESYSTEM token", async () => {
    const backend = createMockBackend("nexus");
    const provider = createFileSystemProvider({ backend });
    const components = extractMap(await provider.attach(createMockAgent()));

    expect(components.get(FILESYSTEM as string)).toBe(backend);
  });

  test("respects custom prefix", async () => {
    const backend = createMockBackend("s3");
    const provider = createFileSystemProvider({ backend, prefix: "s3" });
    const components = extractMap(await provider.attach(createMockAgent()));

    expect(components.has(toolToken("s3_read") as string)).toBe(true);
    expect(components.has(toolToken("s3_write") as string)).toBe(true);
    expect(components.has(toolToken("fs_read") as string)).toBe(false);
  });

  test("respects custom trust tier", async () => {
    const backend = createMockBackend("local");
    const provider = createFileSystemProvider({ backend, trustTier: "sandbox" });
    const components = extractMap(await provider.attach(createMockAgent()));

    const tool = components.get(toolToken("fs_read") as string) as Tool;
    expect(tool.trustTier).toBe("sandbox");
  });

  test("defaults trust tier to verified", async () => {
    const backend = createMockBackend("local");
    const provider = createFileSystemProvider({ backend });
    const components = extractMap(await provider.attach(createMockAgent()));

    const tool = components.get(toolToken("fs_read") as string) as Tool;
    expect(tool.trustTier).toBe("verified");
  });

  test("respects operations filter", async () => {
    const backend = createMockBackend("local");
    const provider = createFileSystemProvider({
      backend,
      operations: ["read", "list"],
    });
    const components = extractMap(await provider.attach(createMockAgent()));

    // 2 tools + FILESYSTEM token + 1 skill (skill always attaches regardless of operations)
    expect(components.size).toBe(4);
    expect(components.has(toolToken("fs_read") as string)).toBe(true);
    expect(components.has(toolToken("fs_list") as string)).toBe(true);
    expect(components.has(toolToken("fs_write") as string)).toBe(false);
    expect(components.has(toolToken("fs_edit") as string)).toBe(false);
    expect(components.has(toolToken("fs_search") as string)).toBe(false);
  });

  test("empty operations throws", () => {
    const backend = createMockBackend("local");
    expect(() => createFileSystemProvider({ backend, operations: [] })).toThrow(
      /operations must not be empty/,
    );
  });
});

// ---------------------------------------------------------------------------
// createFileSystemProvider — detach
// ---------------------------------------------------------------------------

describe("createFileSystemProvider — detach", () => {
  test("calls backend.dispose on detach", async () => {
    let disposed = false;
    const backend: FileSystemBackend = {
      ...createMockBackend("local"),
      dispose: () => {
        disposed = true;
      },
    };
    const provider = createFileSystemProvider({ backend });

    await provider.detach?.(createMockAgent());
    expect(disposed).toBe(true);
  });

  test("detach is safe when backend has no dispose", async () => {
    const backend = createMockBackend("local");
    const provider = createFileSystemProvider({ backend });

    // Should not throw
    await provider.detach?.(createMockAgent());
  });

  test("detach awaits async dispose", async () => {
    let disposed = false;
    const backend: FileSystemBackend = {
      ...createMockBackend("local"),
      dispose: async () => {
        await Promise.resolve();
        disposed = true;
      },
    };
    const provider = createFileSystemProvider({ backend });

    await provider.detach?.(createMockAgent());
    expect(disposed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tool descriptors
// ---------------------------------------------------------------------------

describe("tool descriptors", () => {
  test("each tool has correct name and non-empty description", async () => {
    const backend = createMockBackend("test");
    const provider = createFileSystemProvider({ backend });
    const components = extractMap(await provider.attach(createMockAgent()));

    const expectedNames = ["fs_read", "fs_write", "fs_edit", "fs_list", "fs_search"];
    for (const name of expectedNames) {
      const tool = components.get(toolToken(name) as string) as Tool;
      expect(tool.descriptor.name).toBe(name);
      expect(tool.descriptor.description.length).toBeGreaterThan(0);
      expect(tool.descriptor.description).toContain("test");
    }
  });

  test("each tool has inputSchema with required fields", async () => {
    const backend = createMockBackend("test");
    const provider = createFileSystemProvider({ backend });
    const components = extractMap(await provider.attach(createMockAgent()));

    for (const name of ["fs_read", "fs_write", "fs_edit", "fs_list", "fs_search"]) {
      const tool = components.get(toolToken(name) as string) as Tool;
      const schema = tool.descriptor.inputSchema as Record<string, unknown>;
      expect(schema.type).toBe("object");
      expect(schema.required).toBeDefined();
    }
  });
});

// ---------------------------------------------------------------------------
// SkillComponent
// ---------------------------------------------------------------------------

describe("SkillComponent", () => {
  test("attaches filesystem skill component", async () => {
    const backend = createMockBackend("local");
    const provider = createFileSystemProvider({ backend });
    const components = extractMap(await provider.attach(createMockAgent()));

    expect(components.has(skillToken(FS_SKILL_NAME) as string)).toBe(true);
  });

  test("skill has name, description, and non-empty content", async () => {
    const backend = createMockBackend("local");
    const provider = createFileSystemProvider({ backend });
    const components = extractMap(await provider.attach(createMockAgent()));

    const skill = components.get(skillToken(FS_SKILL_NAME) as string) as SkillComponent;
    expect(skill.name).toBe(FS_SKILL_NAME);
    expect(skill.description.length).toBeGreaterThan(0);
    expect(skill.content.length).toBeGreaterThan(0);
  });

  test("skill content covers edit vs write and search vs list guidance", async () => {
    const backend = createMockBackend("local");
    const provider = createFileSystemProvider({ backend });
    const components = extractMap(await provider.attach(createMockAgent()));

    const skill = components.get(skillToken(FS_SKILL_NAME) as string) as SkillComponent;
    expect(skill.content).toContain("fs_edit");
    expect(skill.content).toContain("fs_write");
    expect(skill.content).toContain("fs_search");
    expect(skill.content).toContain("fs_list");
    expect(skill.content).toContain("fs_read");
  });

  test("skill attaches even when operations are filtered", async () => {
    const backend = createMockBackend("local");
    const provider = createFileSystemProvider({ backend, operations: ["read"] });
    const components = extractMap(await provider.attach(createMockAgent()));

    expect(components.has(skillToken(FS_SKILL_NAME) as string)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Semantic search — retriever integration
// ---------------------------------------------------------------------------

describe("createFileSystemProvider — semantic search", () => {
  test("does NOT attach semantic_search tool when no retriever provided", async () => {
    const backend = createMockBackend("local");
    const provider = createFileSystemProvider({ backend });
    const components = extractMap(await provider.attach(createMockAgent()));

    expect(components.has(toolToken("fs_semantic_search") as string)).toBe(false);
  });

  test("attaches semantic_search tool when retriever provided", async () => {
    const backend = createMockBackend("local");
    const retriever = createMockRetriever();
    const provider = createFileSystemProvider({ backend, retriever });
    const components = extractMap(await provider.attach(createMockAgent()));

    expect(components.has(toolToken("fs_semantic_search") as string)).toBe(true);
  });

  test("semantic search tool has correct name with prefix", async () => {
    const backend = createMockBackend("local");
    const retriever = createMockRetriever();
    const provider = createFileSystemProvider({ backend, retriever, prefix: "cloud" });
    const components = extractMap(await provider.attach(createMockAgent()));

    expect(components.has(toolToken("cloud_semantic_search") as string)).toBe(true);
    const tool = components.get(toolToken("cloud_semantic_search") as string) as Tool;
    expect(tool.descriptor.name).toBe("cloud_semantic_search");
  });

  test("component count includes semantic search tool when retriever provided", async () => {
    const backend = createMockBackend("local");
    const retriever = createMockRetriever();
    const provider = createFileSystemProvider({ backend, retriever });
    const components = extractMap(await provider.attach(createMockAgent()));

    // 5 standard tools + FILESYSTEM token + 1 skill + 1 semantic_search tool = 8
    expect(components.size).toBe(8);
  });

  test("skill content includes semantic search guidance when retriever provided", async () => {
    const backend = createMockBackend("local");
    const retriever = createMockRetriever();
    const provider = createFileSystemProvider({ backend, retriever });
    const components = extractMap(await provider.attach(createMockAgent()));

    const skill = components.get(skillToken(FS_SKILL_NAME) as string) as SkillComponent;
    expect(skill.content).toContain("fs_semantic_search");
    expect(skill.content).toContain("conceptually related");
  });

  test("skill content does NOT include semantic search guidance when no retriever", async () => {
    const backend = createMockBackend("local");
    const provider = createFileSystemProvider({ backend });
    const components = extractMap(await provider.attach(createMockAgent()));

    const skill = components.get(skillToken(FS_SKILL_NAME) as string) as SkillComponent;
    expect(skill.content).not.toContain("fs_semantic_search");
  });
});
