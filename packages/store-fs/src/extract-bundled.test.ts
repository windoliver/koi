import { beforeEach, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_PROVENANCE } from "@koi/test-utils";
import { extractBundled } from "./extract-bundled.js";
import { brickPath } from "./paths.js";

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

let testCounter = 0;

async function freshDir(): Promise<string> {
  testCounter += 1;
  const dir = join(tmpdir(), `koi-extract-bundled-test-${Date.now()}-${testCounter}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

function minimalBrick(id: string): Record<string, unknown> {
  return {
    id,
    kind: "tool",
    name: `brick-${id}`,
    description: "test brick",
    scope: "agent",
    trustTier: "sandbox",
    lifecycle: "active",
    provenance: DEFAULT_PROVENANCE,
    version: "1.0.0",
    tags: [],
    usageCount: 0,
    contentHash: "hash-abc",
    implementation: "return 1;",
    inputSchema: { type: "object" },
  };
}

let sourceDir: string;
let targetDir: string;

beforeEach(async () => {
  sourceDir = await freshDir();
  targetDir = await freshDir();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("extractBundled", () => {
  test("extracts valid bricks into shard layout", async () => {
    await writeFile(join(sourceDir, "a.json"), JSON.stringify(minimalBrick("brick_aaa")));
    await writeFile(join(sourceDir, "b.json"), JSON.stringify(minimalBrick("brick_bbb")));

    const result = await extractBundled({ sourceDir, targetDir });

    expect(result.extracted).toBe(2);
    expect(result.skipped).toBe(0);
    expect(result.errors).toHaveLength(0);

    // Verify shard layout
    const fileA = Bun.file(brickPath(targetDir, "brick_aaa"));
    expect(await fileA.exists()).toBe(true);
    const fileB = Bun.file(brickPath(targetDir, "brick_bbb"));
    expect(await fileB.exists()).toBe(true);
  });

  test("skips existing files when overwrite=false", async () => {
    await writeFile(join(sourceDir, "a.json"), JSON.stringify(minimalBrick("brick_aaa")));

    // First extraction
    await extractBundled({ sourceDir, targetDir });

    // Modify source to detect if overwrite happens
    const modified = { ...minimalBrick("brick_aaa"), name: "modified" };
    await writeFile(join(sourceDir, "a.json"), JSON.stringify(modified));

    // Second extraction — should skip
    const result = await extractBundled({ sourceDir, targetDir, overwrite: false });
    expect(result.extracted).toBe(0);
    expect(result.skipped).toBe(1);

    // Original content preserved
    const content = await Bun.file(brickPath(targetDir, "brick_aaa")).json();
    expect((content as Record<string, unknown>).name).toBe("brick-brick_aaa");
  });

  test("overwrites existing files when overwrite=true", async () => {
    await writeFile(join(sourceDir, "a.json"), JSON.stringify(minimalBrick("brick_aaa")));
    await extractBundled({ sourceDir, targetDir });

    const modified = { ...minimalBrick("brick_aaa"), name: "modified" };
    await writeFile(join(sourceDir, "a.json"), JSON.stringify(modified));

    const result = await extractBundled({ sourceDir, targetDir, overwrite: true });
    expect(result.extracted).toBe(1);
    expect(result.skipped).toBe(0);

    const content = await Bun.file(brickPath(targetDir, "brick_aaa")).json();
    expect((content as Record<string, unknown>).name).toBe("modified");
  });

  test("reports errors for invalid JSON", async () => {
    await writeFile(join(sourceDir, "bad.json"), "not valid json {{{");

    const result = await extractBundled({ sourceDir, targetDir });

    expect(result.extracted).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("bad.json");
  });

  test("reports errors for JSON missing id field", async () => {
    await writeFile(join(sourceDir, "no-id.json"), JSON.stringify({ name: "no id" }));

    const result = await extractBundled({ sourceDir, targetDir });

    expect(result.extracted).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("missing 'id' field");
  });

  test("handles empty source directory", async () => {
    const result = await extractBundled({ sourceDir, targetDir });

    expect(result.extracted).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.errors).toHaveLength(0);
  });

  test("handles missing source directory gracefully", async () => {
    const result = await extractBundled({
      sourceDir: join(sourceDir, "nonexistent"),
      targetDir,
    });

    expect(result.extracted).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.errors).toHaveLength(0);
  });

  test("ignores non-JSON files in source directory", async () => {
    await writeFile(join(sourceDir, "readme.md"), "# Hello");
    await writeFile(join(sourceDir, "a.json"), JSON.stringify(minimalBrick("brick_aaa")));

    const result = await extractBundled({ sourceDir, targetDir });

    expect(result.extracted).toBe(1);
    expect(result.skipped).toBe(0);
  });
});
