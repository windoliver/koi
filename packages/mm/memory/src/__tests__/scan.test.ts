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
          if (glob === "**/*.md" || glob === "*.md") return f.path.endsWith(".md");
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

  test("skips symlinks", async () => {
    const goodFile = makeMemoryFile("Good", "user", "valid", 0);
    const baseFs = createMockFs([goodFile]);
    const symlinkFs: FileSystemBackend = {
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
                path: "/memory/link.md",
                kind: "symlink" as const,
                size: 10,
                modifiedAt: Date.now(),
              },
            ],
            truncated: false,
          },
        };
      },
    };
    const result = await scanMemoryDirectory(symlinkFs, { memoryDir: "/memory" });
    expect(result.memories.length).toBe(1);
    expect(result.skipped.some((s) => s.reason.includes("symlink"))).toBe(true);
  });

  test("skips oversized files", async () => {
    const hugeFile: MockFile = {
      path: "/memory/huge.md",
      content: "x".repeat(100000),
      size: 100000,
      modifiedAt: Date.now(),
    };
    const fs = createMockFs([hugeFile]);
    const result = await scanMemoryDirectory(fs, { memoryDir: "/memory" });
    expect(result.memories.length).toBe(0);
    expect(result.skipped.length).toBe(1);
    expect(result.skipped[0]?.reason).toContain("too large");
  });

  test("discovers nested memory files in subdirectories", async () => {
    const nestedFile: MockFile = {
      path: "/memory/team/user_role.md",
      content: [
        "---",
        "name: Nested",
        "description: test",
        "type: user",
        "---",
        "",
        "nested content",
      ].join("\n"),
      size: 60,
      modifiedAt: Date.now(),
    };
    const fs = createMockFs([nestedFile]);
    const result = await scanMemoryDirectory(fs, { memoryDir: "/memory" });
    expect(result.memories.length).toBe(1);
    expect(result.memories[0]?.record.filePath).toBe("team/user_role.md");
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

  test("scans past corrupt files to find valid ones (default unlimited budget)", async () => {
    // 100 corrupt files followed by 5 valid ones — default scans exhaustively
    const corruptFiles: MockFile[] = Array.from({ length: 100 }, (_, i) => ({
      path: `/memory/bad${i}.md`,
      content: "corrupt",
      size: 7,
      modifiedAt: Date.now() - i * 1000,
    }));
    const validFiles = Array.from({ length: 5 }, (_, i) =>
      makeMemoryFile(`Valid${i}`, "user", `content${i}`, 200 + i),
    );
    const fs = createMockFs([...corruptFiles, ...validFiles]);
    const result = await scanMemoryDirectory(fs, { memoryDir: "/memory", maxFiles: 5 });

    // All 5 valid memories must be found despite 100 corrupt files preceding them
    expect(result.memories.length).toBe(5);
    expect(result.skipped.length).toBe(100);
    expect(result.starved).toBe(false);
    expect(result.candidateLimitHit).toBe(false);
  });

  test("caps candidate examination to bound work from poisoned directories", async () => {
    // With explicit maxCandidates=20, 50 corrupt files should be capped
    const files: MockFile[] = Array.from({ length: 50 }, (_, i) => ({
      path: `/memory/bad${i}.md`,
      content: "corrupt",
      size: 7,
      modifiedAt: Date.now() - i * 1000,
    }));
    const fs = createMockFs(files);
    const result = await scanMemoryDirectory(fs, {
      memoryDir: "/memory",
      maxFiles: 2,
      maxCandidates: 20,
    });

    // Should have stopped after 20 examined entries, not all 50
    expect(result.skipped.length).toBeLessThanOrEqual(20);
    expect(result.memories.length).toBe(0);
    // candidateLimitHit distinguishes budget exhaustion from true starvation
    expect(result.candidateLimitHit).toBe(true);
    expect(result.starved).toBe(false);
  });

  test("ignores invalid maxCandidates (zero/negative) and scans exhaustively", async () => {
    const files = [
      makeMemoryFile("Good", "user", "content", 0),
      makeMemoryFile("Also good", "feedback", "more content", 5),
    ];
    const fs = createMockFs(files);
    // maxCandidates=0 should be treated as unlimited
    const result0 = await scanMemoryDirectory(fs, {
      memoryDir: "/memory",
      maxCandidates: 0,
    });
    expect(result0.memories.length).toBe(2);
    expect(result0.candidateLimitHit).toBe(false);

    // maxCandidates=-1 should also be treated as unlimited
    const resultNeg = await scanMemoryDirectory(fs, {
      memoryDir: "/memory",
      maxCandidates: -1,
    });
    expect(resultNeg.memories.length).toBe(2);
    expect(resultNeg.candidateLimitHit).toBe(false);
  });

  test("skips corrupt and reaches older valid memories", async () => {
    // 2 newest files are corrupt, 2 older files are valid — should find both valid
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
    expect(result.starved).toBe(false);
  });

  test("candidateLimitHit=false when directory size equals maxCandidates (full exhaustion)", async () => {
    // Exactly maxCandidates=5 corrupt files — loop exhausts directory, not budget
    const files: MockFile[] = Array.from({ length: 5 }, (_, i) => ({
      path: `/memory/bad${i}.md`,
      content: "corrupt",
      size: 7,
      modifiedAt: Date.now() - i * 1000,
    }));
    const fs = createMockFs(files);
    const result = await scanMemoryDirectory(fs, {
      memoryDir: "/memory",
      maxFiles: 2,
      maxCandidates: 5,
    });

    // All 5 files examined — directory exhausted, not budget-limited
    expect(result.skipped.length).toBe(5);
    expect(result.memories.length).toBe(0);
    expect(result.candidateLimitHit).toBe(false);
    expect(result.starved).toBe(true);
  });

  test("sets starved=true when all files are corrupt and fully examined", async () => {
    // 10 corrupt files with default maxFiles=200, maxCandidates=2000 — all examined
    const files: MockFile[] = Array.from({ length: 10 }, (_, i) => ({
      path: `/memory/bad${i}.md`,
      content: "corrupt",
      size: 7,
      modifiedAt: Date.now() - i * 1000,
    }));
    const fs = createMockFs(files);
    const result = await scanMemoryDirectory(fs, { memoryDir: "/memory" });

    expect(result.memories.length).toBe(0);
    expect(result.starved).toBe(true);
    expect(result.candidateLimitHit).toBe(false);
    expect(result.totalFiles).toBe(10);
  });

  test("sets starved=false when valid memories are found", async () => {
    const files = [makeMemoryFile("Good", "user", "content", 0)];
    const fs = createMockFs(files);
    const result = await scanMemoryDirectory(fs, { memoryDir: "/memory" });

    expect(result.memories.length).toBe(1);
    expect(result.starved).toBe(false);
  });

  test("sets starved=false for empty directory", async () => {
    const fs = createMockFs([]);
    const result = await scanMemoryDirectory(fs, { memoryDir: "/memory" });

    expect(result.memories.length).toBe(0);
    expect(result.starved).toBe(false);
    expect(result.totalFiles).toBe(0);
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
