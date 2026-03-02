import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FileSystemBackend, KoiError, Result } from "@koi/core";
import { HEURISTIC_ESTIMATOR } from "@koi/token-estimator";
import { scanDirectory } from "./source-directory.js";
import type { DirectorySourceConfig } from "./types.js";
import { DEFAULT_MAX_INDEX_CHARS, DEFAULT_MAX_WARNINGS } from "./types.js";

const defaultOptions = {
  maxIndexCharsPerDoc: DEFAULT_MAX_INDEX_CHARS,
  maxWarnings: DEFAULT_MAX_WARNINGS,
  batchSize: 64,
  estimator: HEURISTIC_ESTIMATOR,
};

// Track temp dirs for cleanup
const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "kv-test-"));
  tempDirs.push(dir);
  return dir;
}

async function writeFile(dir: string, path: string, content: string): Promise<void> {
  const fullPath = join(dir, path);
  await Bun.write(fullPath, content);
}

afterEach(async () => {
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true });
  }
  tempDirs.length = 0;
});

describe("scanDirectory", () => {
  test("scans markdown files in directory", async () => {
    const dir = await createTempDir();
    await writeFile(dir, "doc1.md", "---\ntitle: Doc One\n---\nContent one.");
    await writeFile(dir, "doc2.md", "---\ntitle: Doc Two\n---\nContent two.");

    const config: DirectorySourceConfig = { kind: "directory", path: dir };
    const result = await scanDirectory(config, defaultOptions);

    expect(result.documents).toHaveLength(2);
    expect(result.warnings).toHaveLength(0);

    const titles = result.documents.map((d) => d.title).sort();
    expect(titles).toEqual(["Doc One", "Doc Two"]);
  });

  test("respects glob pattern", async () => {
    const dir = await createTempDir();
    await writeFile(dir, "readme.md", "Markdown file");
    await writeFile(dir, "notes.txt", "Text file");

    const config: DirectorySourceConfig = {
      kind: "directory",
      path: dir,
      glob: "**/*.md",
    };
    const result = await scanDirectory(config, defaultOptions);

    expect(result.documents).toHaveLength(1);
    expect(result.documents[0]?.path).toBe("readme.md");
  });

  test("handles binary files gracefully (warning, not crash)", async () => {
    const dir = await createTempDir();
    await writeFile(dir, "good.md", "Good content");
    // Write a file with null bytes (binary)
    const binaryPath = join(dir, "binary.md");
    const buf = Buffer.from([0x48, 0x65, 0x6c, 0x00, 0x6f]);
    await Bun.write(binaryPath, buf);

    const config: DirectorySourceConfig = { kind: "directory", path: dir };
    const result = await scanDirectory(config, defaultOptions);

    expect(result.documents).toHaveLength(1);
    expect(result.warnings.length).toBeGreaterThanOrEqual(1);
    expect(result.warnings[0]).toContain("Binary file skipped");
  });

  test("handles empty directory", async () => {
    const dir = await createTempDir();

    const config: DirectorySourceConfig = { kind: "directory", path: dir };
    const result = await scanDirectory(config, defaultOptions);

    expect(result.documents).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });

  test("respects exclude list", async () => {
    const dir = await createTempDir();
    await writeFile(dir, "keep.md", "Keep this");
    await writeFile(dir, "templates/skip.md", "Skip this");

    const config: DirectorySourceConfig = {
      kind: "directory",
      path: dir,
      exclude: ["templates/**"],
    };
    const result = await scanDirectory(config, defaultOptions);

    expect(result.documents).toHaveLength(1);
    expect(result.documents[0]?.path).toBe("keep.md");
  });

  test("truncates content to maxIndexCharsPerDoc", async () => {
    const dir = await createTempDir();
    const longContent = "x".repeat(5000);
    await writeFile(dir, "long.md", longContent);

    const config: DirectorySourceConfig = { kind: "directory", path: dir };
    const result = await scanDirectory(config, {
      ...defaultOptions,
      maxIndexCharsPerDoc: 100,
    });

    expect(result.documents).toHaveLength(1);
    expect(result.documents[0]?.body.length).toBeLessThanOrEqual(100);
  });

  test("extracts title from frontmatter or filename", async () => {
    const dir = await createTempDir();
    await writeFile(dir, "with-title.md", "---\ntitle: Custom Title\n---\nBody.");
    await writeFile(dir, "my-doc-name.md", "No frontmatter body.");

    const config: DirectorySourceConfig = { kind: "directory", path: dir };
    const result = await scanDirectory(config, defaultOptions);

    const byPath = new Map(result.documents.map((d) => [d.path, d]));
    expect(byPath.get("with-title.md")?.title).toBe("Custom Title");
    expect(byPath.get("my-doc-name.md")?.title).toBe("my doc name");
  });

  test("extracts tags from frontmatter", async () => {
    const dir = await createTempDir();
    await writeFile(dir, "tagged.md", "---\ntitle: Tagged\ntags: [api, auth]\n---\nBody.");

    const config: DirectorySourceConfig = { kind: "directory", path: dir };
    const result = await scanDirectory(config, defaultOptions);

    expect(result.documents[0]?.tags).toEqual(["api", "auth"]);
  });
});

// ---------------------------------------------------------------------------
// FileSystemBackend path
// ---------------------------------------------------------------------------

function createMockBackend(files: ReadonlyMap<string, string>): FileSystemBackend {
  return {
    name: "mock",
    list: (_path, options) => {
      const entries = [...files.keys()]
        .filter((p) => {
          if (options?.glob === undefined) return true;
          const glob = new Bun.Glob(options.glob);
          return glob.match(p);
        })
        .map((p) => ({ path: p, kind: "file" as const }));
      return { ok: true, value: { entries, truncated: false } } satisfies Result<
        {
          readonly entries: readonly { readonly path: string; readonly kind: "file" }[];
          readonly truncated: boolean;
        },
        KoiError
      >;
    },
    read: (path) => {
      const content = files.get(path);
      if (content === undefined) {
        return {
          ok: false,
          error: { code: "NOT_FOUND", message: `Not found: ${path}`, retryable: false },
        } satisfies Result<never, KoiError>;
      }
      return {
        ok: true,
        value: { content, path, size: content.length },
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
}

describe("scanDirectory with FileSystemBackend", () => {
  test("uses backend list() + read()", async () => {
    const files = new Map([
      ["docs/auth.md", "---\ntitle: Auth\n---\nAuthentication content."],
      ["docs/api.md", "---\ntitle: API\n---\nAPI design content."],
    ]);
    const backend = createMockBackend(files);

    const config: DirectorySourceConfig = {
      kind: "directory",
      path: "/vault",
      backend,
    };
    const result = await scanDirectory(config, defaultOptions);

    expect(result.documents).toHaveLength(2);
    expect(result.warnings).toHaveLength(0);
    const titles = result.documents.map((d) => d.title).sort();
    expect(titles).toEqual(["API", "Auth"]);
  });

  test("handles read failure as warning", async () => {
    const backend: FileSystemBackend = {
      name: "failing-mock",
      list: () => ({
        ok: true,
        value: {
          entries: [
            { path: "good.md", kind: "file" as const },
            { path: "bad.md", kind: "file" as const },
          ],
          truncated: false,
        },
      }),
      read: (path) => {
        if (path === "good.md") {
          return { ok: true, value: { content: "Good content.", path, size: 13 } };
        }
        return {
          ok: false,
          error: { code: "INTERNAL", message: "Disk error", retryable: false },
        } satisfies Result<never, KoiError>;
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

    const config: DirectorySourceConfig = {
      kind: "directory",
      path: "/vault",
      backend,
    };
    const result = await scanDirectory(config, defaultOptions);

    expect(result.documents).toHaveLength(1);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("Disk error");
  });

  test("without backend uses Bun APIs (backward compat)", async () => {
    const dir = await createTempDir();
    await writeFile(dir, "compat.md", "---\ntitle: Compat\n---\nBackward compatible.");

    const config: DirectorySourceConfig = { kind: "directory", path: dir };
    const result = await scanDirectory(config, defaultOptions);

    expect(result.documents).toHaveLength(1);
    expect(result.documents[0]?.title).toBe("Compat");
    // Bun path should produce real mtimeMs (not Date.now())
    expect(result.documents[0]?.lastModified).toBeLessThanOrEqual(Date.now());
    expect(result.documents[0]?.lastModified).toBeGreaterThan(0);
  });
});
