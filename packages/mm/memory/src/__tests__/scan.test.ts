import { describe, expect, test } from "bun:test";
import type {
  FileListEntry,
  FileListResult,
  FileReadResult,
  FileSystemBackend,
  KoiError,
  Result,
} from "@koi/core";
import { scanMemoryDirectory } from "../scan.js";

// ---------------------------------------------------------------------------
// Mock FileSystemBackend factory
// ---------------------------------------------------------------------------

interface MockFile {
  readonly path: string;
  readonly content: string;
  readonly size: number;
  readonly modifiedAt: number;
}

function createMockFs(files: readonly MockFile[]): FileSystemBackend {
  return {
    name: "mock-fs",
    read(path): Result<FileReadResult, KoiError> {
      const file = files.find((f) => f.path === path);
      if (!file) {
        return {
          ok: false,
          error: { code: "NOT_FOUND", message: `File not found: ${path}`, retryable: false },
        };
      }
      return { ok: true, value: { content: file.content, path: file.path, size: file.size } };
    },
    list(path, options): Result<FileListResult, KoiError> {
      const glob = options?.glob;
      const entries: FileListEntry[] = files
        .filter((f) => {
          if (!f.path.startsWith(path)) return false;
          if (glob === "*.md") return f.path.endsWith(".md");
          return true;
        })
        .map(
          (f): FileListEntry => ({
            path: f.path,
            kind: "file",
            size: f.size,
            modifiedAt: f.modifiedAt,
          }),
        );
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

function makeMemoryFile(name: string, type: string, content: string, daysAgo: number): MockFile {
  const body = [
    "---",
    `name: ${name}`,
    `description: test memory`,
    `type: ${type}`,
    "---",
    "",
    content,
  ].join("\n");
  return {
    path: `/memory/${name.replace(/\s/g, "_").toLowerCase()}.md`,
    content: body,
    size: body.length,
    modifiedAt: Date.now() - daysAgo * 86_400_000,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("scanMemoryDirectory", () => {
  test("parses valid memory files", async () => {
    const files = [
      makeMemoryFile("User role", "user", "Senior engineer", 0),
      makeMemoryFile("Testing feedback", "feedback", "Use integration tests", 5),
      makeMemoryFile("Project goal", "project", "Ship v2 by Q2", 10),
    ];
    const fs = createMockFs(files);
    const result = await scanMemoryDirectory(fs, { memoryDir: "/memory" });

    expect(result.memories.length).toBe(3);
    expect(result.skipped.length).toBe(0);
    expect(result.totalFiles).toBe(3);
    expect(result.truncated).toBe(false);
    expect(result.listFailed).toBe(false);
  });

  test("sorts by modifiedAt descending (newest first)", async () => {
    const files = [
      makeMemoryFile("Old", "user", "old content", 30),
      makeMemoryFile("New", "user", "new content", 1),
      makeMemoryFile("Middle", "user", "mid content", 15),
    ];
    const fs = createMockFs(files);
    const result = await scanMemoryDirectory(fs, { memoryDir: "/memory" });

    expect(result.memories[0]?.record.name).toBe("New");
    expect(result.memories[1]?.record.name).toBe("Middle");
    expect(result.memories[2]?.record.name).toBe("Old");
  });

  test("skips files with malformed frontmatter", async () => {
    const goodFile = makeMemoryFile("Good", "user", "valid", 0);
    const badFile: MockFile = {
      path: "/memory/bad.md",
      content: "no frontmatter here",
      size: 20,
      modifiedAt: Date.now(),
    };
    const fs = createMockFs([goodFile, badFile]);
    const result = await scanMemoryDirectory(fs, { memoryDir: "/memory" });

    expect(result.memories.length).toBe(1);
    expect(result.skipped.length).toBe(1);
    expect(result.skipped[0]?.filePath).toBe("bad.md");
    expect(result.skipped[0]?.reason).toContain("frontmatter");
  });

  test("returns empty result for empty directory", async () => {
    const fs = createMockFs([]);
    const result = await scanMemoryDirectory(fs, { memoryDir: "/memory" });

    expect(result.memories.length).toBe(0);
    expect(result.skipped.length).toBe(0);
    expect(result.totalFiles).toBe(0);
  });

  test("respects maxFiles cap", async () => {
    const files = [
      makeMemoryFile("A", "user", "a", 0),
      makeMemoryFile("B", "user", "b", 1),
      makeMemoryFile("C", "user", "c", 2),
    ];
    const fs = createMockFs(files);
    const result = await scanMemoryDirectory(fs, { memoryDir: "/memory", maxFiles: 2 });

    expect(result.memories.length).toBe(2);
    expect(result.totalFiles).toBe(3);
  });

  test("handles read failure gracefully", async () => {
    const goodFile = makeMemoryFile("Good", "user", "valid", 0);
    // Create a FS where one file exists in listing but read fails
    const baseFs = createMockFs([goodFile]);
    const failingFs: FileSystemBackend = {
      ...baseFs,
      list(path, options) {
        const result = baseFs.list(path, options);
        if (!("ok" in result) || !result.ok) return result;
        return {
          ok: true as const,
          value: {
            entries: [
              ...result.value.entries,
              { path: "/memory/ghost.md", kind: "file" as const, size: 10, modifiedAt: Date.now() },
            ],
            truncated: false,
          },
        };
      },
      read(path) {
        if (path === "/memory/ghost.md") {
          return {
            ok: false as const,
            error: { code: "NOT_FOUND" as const, message: "gone", retryable: false },
          };
        }
        return baseFs.read(path);
      },
    };

    const result = await scanMemoryDirectory(failingFs, { memoryDir: "/memory" });
    expect(result.memories.length).toBe(1);
    expect(result.skipped.length).toBe(1);
    expect(result.skipped[0]?.reason).toContain("read");
  });

  test("sets listFailed when fs.list returns error", async () => {
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
    const result = await scanMemoryDirectory(failFs, { memoryDir: "/memory" });
    expect(result.listFailed).toBe(true);
    expect(result.memories.length).toBe(0);
  });

  test("sets truncated when backend reports truncated listing", async () => {
    const goodFile = makeMemoryFile("Good", "user", "valid", 0);
    const baseFs = createMockFs([goodFile]);
    const truncatedFs: FileSystemBackend = {
      ...baseFs,
      list(path, options) {
        const result = baseFs.list(path, options);
        if (!("ok" in result) || !result.ok) return result;
        return {
          ok: true as const,
          value: { entries: result.value.entries, truncated: true },
        };
      },
    };
    const result = await scanMemoryDirectory(truncatedFs, { memoryDir: "/memory" });
    expect(result.truncated).toBe(true);
    expect(result.listFailed).toBe(false);
    expect(result.memories.length).toBe(1);
  });

  test("rejects paths outside the memory directory", async () => {
    const goodFile = makeMemoryFile("Good", "user", "valid", 0);
    const baseFs = createMockFs([goodFile]);
    const escapedFs: FileSystemBackend = {
      ...baseFs,
      list(path, options) {
        const result = baseFs.list(path, options);
        if (!("ok" in result) || !result.ok) return result;
        return {
          ok: true as const,
          value: {
            entries: [
              ...result.value.entries,
              {
                path: "/other/secret.md",
                kind: "file" as const,
                size: 100,
                modifiedAt: Date.now(),
              },
              {
                path: "/memory/../etc/passwd.md",
                kind: "file" as const,
                size: 100,
                modifiedAt: Date.now(),
              },
            ],
            truncated: false,
          },
        };
      },
    };
    const result = await scanMemoryDirectory(escapedFs, { memoryDir: "/memory" });
    expect(result.memories.length).toBe(1);
    expect(result.skipped.length).toBe(2);
    expect(result.skipped[0]?.reason).toContain("outside memory directory");
  });

  test("caps read attempts to prevent unbounded I/O", async () => {
    // Create many corrupt files — with maxFiles=2, read attempts capped at 2*3=6
    const files: MockFile[] = Array.from({ length: 20 }, (_, i) => ({
      path: `/memory/bad${i}.md`,
      content: "corrupt",
      size: 7,
      modifiedAt: Date.now() - i * 1000,
    }));
    const fs = createMockFs(files);
    const result = await scanMemoryDirectory(fs, { memoryDir: "/memory", maxFiles: 2 });

    // Should have stopped after 6 read attempts (2 * 3 multiplier), not all 20
    expect(result.skipped.length).toBeLessThanOrEqual(6);
    expect(result.memories.length).toBe(0);
  });

  test("cap applies to valid memories, not raw entries — skips corrupt and reaches older valid", async () => {
    // 2 newest files are corrupt, 2 older files are valid — maxFiles=2 should still find both valid
    const files: MockFile[] = [
      { path: "/memory/bad1.md", content: "corrupt1", size: 8, modifiedAt: Date.now() },
      { path: "/memory/bad2.md", content: "corrupt2", size: 8, modifiedAt: Date.now() - 1000 },
      makeMemoryFile("Valid1", "user", "content1", 5),
      makeMemoryFile("Valid2", "user", "content2", 10),
    ];
    const fs = createMockFs(files);
    const result = await scanMemoryDirectory(fs, { memoryDir: "/memory", maxFiles: 2 });

    expect(result.memories.length).toBe(2);
    expect(result.skipped.length).toBe(2);
    expect(result.memories[0]?.record.name).toBe("Valid1");
    expect(result.memories[1]?.record.name).toBe("Valid2");
  });

  test("populates record fields correctly", async () => {
    const file = makeMemoryFile("My Memory", "feedback", "Important feedback", 5);
    const fs = createMockFs([file]);
    const result = await scanMemoryDirectory(fs, { memoryDir: "/memory" });

    expect(result.memories.length).toBe(1);
    const first = result.memories[0];
    expect(first).toBeDefined();
    // biome-ignore lint/style/noNonNullAssertion: length checked above
    const record = first!.record;
    expect(record.name).toBe("My Memory");
    expect(record.description).toBe("test memory");
    expect(record.type).toBe("feedback");
    expect(record.content).toBe("Important feedback");
    expect(record.filePath).toBe("my_memory.md");
    // biome-ignore lint/style/noNonNullAssertion: length checked above
    expect(first!.fileSize).toBe(file.size);
  });
});
