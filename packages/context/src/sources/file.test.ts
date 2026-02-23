import { afterEach, describe, expect, test } from "bun:test";
import { unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveFileSource } from "./file.js";

describe("resolveFileSource", () => {
  const tempFiles: string[] = [];

  function createTempFile(content: string): string {
    const path = join(
      tmpdir(),
      `koi-test-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`,
    );
    writeFileSync(path, content);
    tempFiles.push(path);
    return path;
  }

  afterEach(() => {
    for (const f of tempFiles) {
      try {
        unlinkSync(f);
      } catch {
        /* ignore */
      }
    }
    tempFiles.length = 0;
  });

  test("reads file content from disk", async () => {
    const path = createTempFile("file content here");
    const result = await resolveFileSource({ kind: "file", path });
    expect(result.content).toBe("file content here");
  });

  test("uses file path as default label", async () => {
    const path = createTempFile("test");
    const result = await resolveFileSource({ kind: "file", path });
    expect(result.label).toBe(path);
  });

  test("uses custom label when provided", async () => {
    const path = createTempFile("test");
    const result = await resolveFileSource({
      kind: "file",
      path,
      label: "My File",
    });
    expect(result.label).toBe("My File");
  });

  test("throws for non-existent file", async () => {
    await expect(
      resolveFileSource({ kind: "file", path: "/nonexistent/path.txt" }),
    ).rejects.toThrow();
  });

  test("reads empty file", async () => {
    const path = createTempFile("");
    const result = await resolveFileSource({ kind: "file", path });
    expect(result.content).toBe("");
  });

  test("preserves source reference", async () => {
    const path = createTempFile("test");
    const source = { kind: "file" as const, path, priority: 10 };
    const result = await resolveFileSource(source);
    expect(result.source).toBe(source);
  });
});
