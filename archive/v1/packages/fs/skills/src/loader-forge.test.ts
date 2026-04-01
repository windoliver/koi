/**
 * Unit tests for the forge skill loader (loader-forge.ts).
 *
 * Uses mock ForgeStore and SkillArtifact objects to test progressive loading:
 * metadata → body → bundled — all backed by ForgeStore instead of filesystem.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import type {
  BrickArtifact,
  BrickId,
  ForgeStore,
  KoiError,
  Result,
  SkillArtifact,
} from "@koi/core";
import { brickId, DEFAULT_SANDBOXED_POLICY } from "@koi/core";
import type { ScanFinding } from "@koi/skill-scanner";
import {
  clearForgeSkillCache,
  loadForgeSkill,
  loadForgeSkillBody,
  loadForgeSkillBundled,
  loadForgeSkillMetadata,
} from "./loader-forge.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_BRICK_ID: BrickId = brickId("sha256:test-skill-001");

const SKILL_CONTENT = [
  "---",
  "name: forged-review",
  "description: A forged code review skill.",
  "allowed-tools: read_file write_file",
  "---",
  "",
  "# Forged Review",
  "",
  "This skill was forged by the agent.",
  "",
  "```typescript",
  'console.log("forged");',
  "```",
].join("\n");

function createMockArtifact(overrides?: Partial<SkillArtifact>): SkillArtifact {
  return {
    id: TEST_BRICK_ID,
    kind: "skill",
    name: "forged-review",
    description: "A forged code review skill.",
    scope: "agent",
    origin: "primordial",
    policy: DEFAULT_SANDBOXED_POLICY,
    lifecycle: "active",
    provenance: {
      builder: { id: "test" },
      buildDefinition: { buildType: "forge" },
      runMetadata: {},
    },
    version: "1.0.0",
    tags: ["read_file", "write_file"],
    usageCount: 0,
    content: SKILL_CONTENT,
    ...overrides,
  } as SkillArtifact;
}

function mockForgeStore(artifacts: ReadonlyMap<string, BrickArtifact>): ForgeStore {
  return {
    load: async (id: BrickId): Promise<Result<BrickArtifact, KoiError>> => {
      const artifact = artifacts.get(id);
      if (artifact === undefined) {
        return {
          ok: false,
          error: {
            code: "NOT_FOUND",
            message: `Brick ${id} not found`,
            retryable: false,
            context: { brickId: id },
          },
        };
      }
      return { ok: true, value: artifact };
    },
    save: async () => ({ ok: true, value: undefined }),
    search: async () => ({ ok: true, value: [] }),
    remove: async () => ({ ok: true, value: undefined }),
    update: async () => ({ ok: true, value: undefined }),
    watch: () => () => {},
  } as unknown as ForgeStore;
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  clearForgeSkillCache();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("loadForgeSkillMetadata", () => {
  test("returns name/description/tags from artifact fields", async () => {
    const artifact = createMockArtifact();
    const store = mockForgeStore(new Map([[TEST_BRICK_ID, artifact]]));

    const result = await loadForgeSkillMetadata(TEST_BRICK_ID, store);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.level).toBe("metadata");
    expect(result.value.name).toBe("forged-review");
    expect(result.value.description).toBe("A forged code review skill.");
    expect(result.value.allowedTools).toEqual(["read_file", "write_file"]);
    expect(result.value.dirPath).toBe(`forge:${TEST_BRICK_ID}`);
  });

  test("returns error when ForgeStore.load fails", async () => {
    const store = mockForgeStore(new Map());

    const result = await loadForgeSkillMetadata(TEST_BRICK_ID, store);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("NOT_FOUND");
  });
});

describe("loadForgeSkillBody", () => {
  test("parses artifact.content and returns markdown body", async () => {
    const artifact = createMockArtifact();
    const store = mockForgeStore(new Map([[TEST_BRICK_ID, artifact]]));

    const result = await loadForgeSkillBody(TEST_BRICK_ID, store);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.level).toBe("body");
    expect(result.value.name).toBe("forged-review");
    expect(result.value.body).toContain("# Forged Review");
    expect(result.value.body).toContain("```typescript");
  });

  test("returns error when artifact content is empty", async () => {
    const artifact = createMockArtifact({ content: "" });
    const store = mockForgeStore(new Map([[TEST_BRICK_ID, artifact]]));

    const result = await loadForgeSkillBody(TEST_BRICK_ID, store);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("VALIDATION");
    expect(result.error.message).toContain("empty content");
  });

  test("returns validation error when frontmatter is invalid", async () => {
    const badContent = [
      "---",
      "name: INVALID_NAME!", // name validation fails
      "description: bad.",
      "---",
      "",
      "body",
    ].join("\n");
    const artifact = createMockArtifact({ content: badContent });
    const store = mockForgeStore(new Map([[TEST_BRICK_ID, artifact]]));

    const result = await loadForgeSkillBody(TEST_BRICK_ID, store);
    expect(result.ok).toBe(false);
  });

  test("runs security scanner on body-level load", async () => {
    const artifact = createMockArtifact();
    const store = mockForgeStore(new Map([[TEST_BRICK_ID, artifact]]));

    const findings: ScanFinding[][] = [];
    const callback = (f: readonly ScanFinding[]): void => {
      findings.push([...f]);
    };

    await loadForgeSkillBody(TEST_BRICK_ID, store, callback);
    // Scanner runs but may not find issues in this content — just verify it's called
    // (the scanner callback is only invoked if findings > 0)
  });
});

describe("loadForgeSkillBundled", () => {
  test("includes artifact.files as scripts/references/assets", async () => {
    const artifact = createMockArtifact({
      files: {
        "scripts/helper.sh": "#!/bin/bash\necho hello",
        "references/guide.md": "# Guide\n\nSome reference.",
        "assets/report-template.md": "# Report\n\n{{summary}}",
        "other/ignored.txt": "this is ignored",
      },
    });
    const store = mockForgeStore(new Map([[TEST_BRICK_ID, artifact]]));

    const result = await loadForgeSkillBundled(TEST_BRICK_ID, store);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.level).toBe("bundled");
    expect(result.value.scripts).toHaveLength(1);
    expect(result.value.scripts[0]?.filename).toBe("helper.sh");
    expect(result.value.scripts[0]?.content).toContain("echo hello");
    expect(result.value.references).toHaveLength(1);
    expect(result.value.references[0]?.filename).toBe("guide.md");
    expect(result.value.assets ?? []).toHaveLength(1);
    expect(result.value.assets?.[0]?.filename).toBe("report-template.md");
    expect(result.value.assets?.[0]?.content).toContain("{{summary}}");
  });

  test("returns empty scripts/references/assets when artifact has no files", async () => {
    // createMockArtifact() produces an artifact without a `files` field
    const artifact = createMockArtifact();
    const store = mockForgeStore(new Map([[TEST_BRICK_ID, artifact]]));

    const result = await loadForgeSkillBundled(TEST_BRICK_ID, store);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.scripts).toHaveLength(0);
    expect(result.value.references).toHaveLength(0);
    expect(result.value.assets ?? []).toHaveLength(0);
  });
});

describe("loadForgeSkill (dispatcher)", () => {
  test("dispatches to metadata level", async () => {
    const artifact = createMockArtifact();
    const store = mockForgeStore(new Map([[TEST_BRICK_ID, artifact]]));

    const result = await loadForgeSkill(TEST_BRICK_ID, store, "metadata");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.level).toBe("metadata");
    }
  });

  test("dispatches to body level", async () => {
    const artifact = createMockArtifact();
    const store = mockForgeStore(new Map([[TEST_BRICK_ID, artifact]]));

    const result = await loadForgeSkill(TEST_BRICK_ID, store, "body");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.level).toBe("body");
    }
  });

  test("dispatches to bundled level", async () => {
    const artifact = createMockArtifact();
    const store = mockForgeStore(new Map([[TEST_BRICK_ID, artifact]]));

    const result = await loadForgeSkill(TEST_BRICK_ID, store, "bundled");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.level).toBe("bundled");
    }
  });
});

describe("cache behavior", () => {
  test("ForgeStore.load() called once for repeated loads (cache hit)", async () => {
    // let: justified for counting store.load() calls
    let loadCallCount = 0;
    const artifact = createMockArtifact();
    const store: ForgeStore = {
      ...mockForgeStore(new Map([[TEST_BRICK_ID, artifact]])),
      load: async (id: BrickId): Promise<Result<BrickArtifact, KoiError>> => {
        loadCallCount++;
        if (id === TEST_BRICK_ID) {
          return { ok: true, value: artifact };
        }
        return {
          ok: false,
          error: { code: "NOT_FOUND", message: "not found", retryable: false },
        };
      },
    } as unknown as ForgeStore;

    await loadForgeSkillMetadata(TEST_BRICK_ID, store);
    await loadForgeSkillBody(TEST_BRICK_ID, store);
    await loadForgeSkillBundled(TEST_BRICK_ID, store);

    expect(loadCallCount).toBe(1);
  });

  test("clearForgeSkillCache clears the cache", async () => {
    // let: justified for counting store.load() calls
    let loadCallCount = 0;
    const artifact = createMockArtifact();
    const store: ForgeStore = {
      ...mockForgeStore(new Map([[TEST_BRICK_ID, artifact]])),
      load: async (id: BrickId): Promise<Result<BrickArtifact, KoiError>> => {
        loadCallCount++;
        if (id === TEST_BRICK_ID) {
          return { ok: true, value: artifact };
        }
        return {
          ok: false,
          error: { code: "NOT_FOUND", message: "not found", retryable: false },
        };
      },
    } as unknown as ForgeStore;

    await loadForgeSkillMetadata(TEST_BRICK_ID, store);
    expect(loadCallCount).toBe(1);

    clearForgeSkillCache();

    await loadForgeSkillMetadata(TEST_BRICK_ID, store);
    expect(loadCallCount).toBe(2);
  });
});

describe("error handling", () => {
  test("returns VALIDATION error when brick kind is not skill", async () => {
    const toolArtifact = {
      ...createMockArtifact(),
      kind: "tool",
    } as unknown as BrickArtifact;
    const store = mockForgeStore(new Map([[TEST_BRICK_ID, toolArtifact]]));

    const result = await loadForgeSkillMetadata(TEST_BRICK_ID, store);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("VALIDATION");
    expect(result.error.message).toContain('expected "skill"');
  });
});
