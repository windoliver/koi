import { describe, expect, test } from "bun:test";
import type {
  FileListResult,
  FileReadResult,
  FileSystemBackend,
  KoiError,
  MemoryRecordId,
  Result,
} from "@koi/core";
import { estimateTokens } from "@koi/token-estimator";
import { recallMemories, selectWithinBudget } from "../recall.js";
import type { ScoredMemory } from "../salience.js";
import type { ScannedMemory } from "../scan.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeScored(name: string, content: string, score: number): ScoredMemory {
  const memory: ScannedMemory = {
    record: {
      id: `mem-${name}` as MemoryRecordId,
      name,
      description: `desc of ${name}`,
      type: "user",
      content,
      filePath: `${name}.md`,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
    fileSize: content.length,
  };
  return { memory, salienceScore: score, decayScore: 1.0, typeRelevance: 1.0 };
}

function createMockFs(
  files: ReadonlyArray<{
    readonly path: string;
    readonly content: string;
    readonly modifiedAt: number;
  }>,
): FileSystemBackend {
  return {
    name: "mock-fs",
    read(path): Result<FileReadResult, KoiError> {
      const file = files.find((f) => f.path === path);
      if (!file) {
        return { ok: false, error: { code: "NOT_FOUND", message: "not found", retryable: false } };
      }
      return {
        ok: true,
        value: { content: file.content, path: file.path, size: file.content.length },
      };
    },
    list(path): Result<FileListResult, KoiError> {
      const entries = files
        .filter((f) => f.path.startsWith(path) && f.path.endsWith(".md"))
        .map((f) => ({
          path: f.path,
          kind: "file" as const,
          size: f.content.length,
          modifiedAt: f.modifiedAt,
        }));
      return { ok: true, value: { entries, truncated: false } };
    },
    write() {
      return {
        ok: false,
        error: { code: "INTERNAL" as const, message: "not implemented", retryable: false },
      };
    },
    edit() {
      return {
        ok: false,
        error: { code: "INTERNAL" as const, message: "not implemented", retryable: false },
      };
    },
    search() {
      return {
        ok: false,
        error: { code: "INTERNAL" as const, message: "not implemented", retryable: false },
      };
    },
  };
}

function makeMemoryFileContent(name: string, type: string, content: string): string {
  return ["---", `name: ${name}`, "description: test", `type: ${type}`, "---", "", content].join(
    "\n",
  );
}

// ---------------------------------------------------------------------------
// selectWithinBudget
// ---------------------------------------------------------------------------

describe("selectWithinBudget", () => {
  test("returns empty for empty input", () => {
    const result = selectWithinBudget([], 8000);
    expect(result.selected.length).toBe(0);
    expect(result.totalTokens).toBe(0);
    expect(result.truncated).toBe(false);
  });

  test("includes single memory within budget", () => {
    const memories = [makeScored("test", "short content", 1.0)];
    const result = selectWithinBudget(memories, 8000);
    expect(result.selected.length).toBe(1);
    expect(result.truncated).toBe(false);
  });

  test("skips memory that exceeds remaining budget", () => {
    // Create a memory with very large content
    const large = makeScored("big", "x".repeat(40000), 1.0);
    const small = makeScored("small", "tiny", 0.5);
    const result = selectWithinBudget([large, small], 100);
    // Large is skipped, small fits
    expect(result.selected.length).toBe(1);
    expect(result.selected[0]?.memory.record.name).toBe("small");
    expect(result.truncated).toBe(true);
  });

  test("fills budget with multiple memories", () => {
    const memories = [
      makeScored("a", "content a", 1.0),
      makeScored("b", "content b", 0.9),
      makeScored("c", "content c", 0.8),
    ];
    const result = selectWithinBudget(memories, 8000);
    expect(result.selected.length).toBe(3);
    expect(result.totalTokens).toBeGreaterThan(0);
  });

  test("stops when budget is exhausted", () => {
    // Each memory ~10 tokens of content + heading overhead
    const memories = Array.from({ length: 100 }, (_, i) =>
      makeScored(`mem${i}`, "some reasonable content here that uses tokens", 1.0 - i * 0.001),
    );
    const result = selectWithinBudget(memories, 50);
    expect(result.selected.length).toBeLessThan(100);
    expect(result.truncated).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// recallMemories (end-to-end with mock FS)
// ---------------------------------------------------------------------------

describe("recallMemories", () => {
  const now = Date.now();

  test("returns formatted memories from directory scan", async () => {
    const files = [
      {
        path: "/mem/user_role.md",
        content: makeMemoryFileContent("User role", "user", "Senior engineer"),
        modifiedAt: now,
      },
      {
        path: "/mem/feedback.md",
        content: makeMemoryFileContent("Testing", "feedback", "Use integration tests"),
        modifiedAt: now - 86_400_000,
      },
    ];
    const fs = createMockFs(files);
    const result = await recallMemories(fs, { memoryDir: "/mem", now });

    expect(result.totalScanned).toBe(2);
    expect(result.selected.length).toBe(2);
    expect(result.formatted).toContain("## Memory");
    expect(result.formatted).toContain("Senior engineer");
    expect(result.formatted).toContain("Use integration tests");
    expect(result.totalTokens).toBeGreaterThan(0);
  });

  test("respects token budget", async () => {
    const files = Array.from({ length: 20 }, (_, i) => ({
      path: `/mem/mem${i}.md`,
      content: makeMemoryFileContent(`Memory ${i}`, "user", "x".repeat(500)),
      modifiedAt: now - i * 86_400_000,
    }));
    const fs = createMockFs(files);
    const result = await recallMemories(fs, { memoryDir: "/mem", tokenBudget: 200, now });

    expect(result.selected.length).toBeLessThan(20);
    expect(result.truncated).toBe(true);
  });

  test("returns empty result for empty directory", async () => {
    const fs = createMockFs([]);
    const result = await recallMemories(fs, { memoryDir: "/mem", now });

    expect(result.selected.length).toBe(0);
    expect(result.formatted).toBe("");
    expect(result.totalScanned).toBe(0);
    expect(result.truncated).toBe(false);
    expect(result.degraded).toBe(false);
  });

  test("sets degraded when list fails", async () => {
    const failFs: FileSystemBackend = {
      name: "fail-fs",
      list() {
        return {
          ok: false as const,
          error: { code: "INTERNAL" as const, message: "backend down", retryable: false },
        };
      },
      read() {
        return {
          ok: false as const,
          error: { code: "INTERNAL" as const, message: "not implemented", retryable: false },
        };
      },
      write() {
        return {
          ok: false as const,
          error: { code: "INTERNAL" as const, message: "not implemented", retryable: false },
        };
      },
      edit() {
        return {
          ok: false as const,
          error: { code: "INTERNAL" as const, message: "not implemented", retryable: false },
        };
      },
      search() {
        return {
          ok: false as const,
          error: { code: "INTERNAL" as const, message: "not implemented", retryable: false },
        };
      },
    };
    const result = await recallMemories(failFs, { memoryDir: "/mem", now });
    expect(result.degraded).toBe(true);
    expect(result.selected.length).toBe(0);
  });

  test("formatted output tokens do not exceed budget", async () => {
    const files = Array.from({ length: 10 }, (_, i) => ({
      path: `/mem/mem${i}.md`,
      content: makeMemoryFileContent(`Memory ${i}`, "user", "x".repeat(200)),
      modifiedAt: now - i * 86_400_000,
    }));
    const fs = createMockFs(files);
    const budget = 300;
    const result = await recallMemories(fs, { memoryDir: "/mem", tokenBudget: budget, now });

    const actualTokens = estimateTokens(result.formatted);
    expect(actualTokens).toBeLessThanOrEqual(budget);
  });
});
