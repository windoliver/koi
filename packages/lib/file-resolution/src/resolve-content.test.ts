import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveContent } from "./resolve-content.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = join(tmpdir(), "koi-file-resolution-test", crypto.randomUUID());
  await mkdir(tmpDir, { recursive: true });
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Inline mode
// ---------------------------------------------------------------------------

describe("resolveContent — inline mode", () => {
  test("returns inline content directly", async () => {
    const result = await resolveContent({
      input: "You are kind.\nYou help everyone.",
      maxTokens: 4000,
      label: "soul",
      basePath: tmpDir,
    });

    expect(result.text).toBe("You are kind.\nYou help everyone.");
    expect(result.sources).toEqual(["inline"]);
    expect(result.warnings).toHaveLength(0);
  });

  test("truncates inline content exceeding maxTokens", async () => {
    const result = await resolveContent({
      input: `Line one\n${"A".repeat(100)}`,
      maxTokens: 10,
      label: "soul",
      basePath: tmpDir,
    });

    expect(result.text.length).toBe(40);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("truncated");
  });
});

// ---------------------------------------------------------------------------
// File mode
// ---------------------------------------------------------------------------

describe("resolveContent — file mode", () => {
  test("reads content from file path", async () => {
    await writeFile(join(tmpDir, "SOUL.md"), "You are a helpful assistant.");

    const result = await resolveContent({
      input: "SOUL.md",
      maxTokens: 4000,
      label: "soul",
      basePath: tmpDir,
    });

    expect(result.text).toBe("You are a helpful assistant.");
    expect(result.tokens).toBeGreaterThan(0);
    expect(result.sources).toHaveLength(1);
    expect(result.warnings).toHaveLength(0);
  });

  test("returns empty with warning for non-existent file", async () => {
    const result = await resolveContent({
      input: "missing.md",
      maxTokens: 4000,
      label: "soul",
      basePath: tmpDir,
    });

    expect(result.text).toBe("");
    expect(result.tokens).toBe(0);
    expect(result.sources).toHaveLength(0);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("not found");
  });

  test("warns on empty file", async () => {
    await writeFile(join(tmpDir, "empty.md"), "");

    const result = await resolveContent({
      input: "empty.md",
      maxTokens: 4000,
      label: "soul",
      basePath: tmpDir,
    });

    expect(result.text).toBe("");
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("empty");
  });

  test("truncates content exceeding maxTokens", async () => {
    await writeFile(join(tmpDir, "big.md"), "A".repeat(100));

    const result = await resolveContent({
      input: "big.md",
      maxTokens: 10,
      label: "soul",
      basePath: tmpDir,
    });

    expect(result.text.length).toBe(40);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("truncated");
  });
});

// ---------------------------------------------------------------------------
// Directory mode (allowDirectory: true)
// ---------------------------------------------------------------------------

describe("resolveContent — directory mode", () => {
  test("reads directory when allowDirectory is true", async () => {
    const soulDir = join(tmpDir, "soul");
    await mkdir(soulDir, { recursive: true });
    await writeFile(join(soulDir, "SOUL.md"), "I am helpful.");
    await writeFile(join(soulDir, "STYLE.md"), "Be concise.");

    const result = await resolveContent({
      input: "soul",
      maxTokens: 4000,
      label: "soul",
      basePath: tmpDir,
      allowDirectory: true,
    });

    expect(result.text).toContain("## Soul");
    expect(result.text).toContain("I am helpful.");
    expect(result.text).toContain("## Style");
    expect(result.sources).toHaveLength(2);
  });

  test("treats directory as file when allowDirectory is false", async () => {
    const soulDir = join(tmpDir, "soul");
    await mkdir(soulDir, { recursive: true });
    await writeFile(join(soulDir, "SOUL.md"), "I am helpful.");

    const result = await resolveContent({
      input: "soul",
      maxTokens: 4000,
      label: "user",
      basePath: tmpDir,
      allowDirectory: false,
    });

    // Directory path is not a file — should report not found
    expect(result.text).toBe("");
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("not found");
  });

  test("defaults allowDirectory to false", async () => {
    const soulDir = join(tmpDir, "soul");
    await mkdir(soulDir, { recursive: true });
    await writeFile(join(soulDir, "SOUL.md"), "I am helpful.");

    const result = await resolveContent({
      input: "soul",
      maxTokens: 4000,
      label: "user",
      basePath: tmpDir,
    });

    // Without allowDirectory, should treat as file and fail
    expect(result.text).toBe("");
  });

  test("truncates directory content exceeding maxTokens", async () => {
    const soulDir = join(tmpDir, "big-soul");
    await mkdir(soulDir, { recursive: true });
    await writeFile(join(soulDir, "SOUL.md"), "A".repeat(200));

    const result = await resolveContent({
      input: "big-soul",
      maxTokens: 10,
      label: "soul",
      basePath: tmpDir,
      allowDirectory: true,
    });

    expect(result.text.length).toBe(40);
    expect(result.warnings.some((w) => w.includes("truncated"))).toBe(true);
  });

  test("returns error when directory missing SOUL.md", async () => {
    const soulDir = join(tmpDir, "no-soul");
    await mkdir(soulDir, { recursive: true });
    await writeFile(join(soulDir, "STYLE.md"), "Some style.");

    const result = await resolveContent({
      input: "no-soul",
      maxTokens: 4000,
      label: "soul",
      basePath: tmpDir,
      allowDirectory: true,
    });

    expect(result.text).toBe("");
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("missing required SOUL.md");
  });
});

// ---------------------------------------------------------------------------
// Token estimation
// ---------------------------------------------------------------------------

describe("resolveContent — token estimation", () => {
  test("estimates tokens at 4 chars per token", async () => {
    const result = await resolveContent({
      input: "Hello\nWorld",
      maxTokens: 4000,
      label: "soul",
      basePath: tmpDir,
    });

    // "Hello\nWorld" = 11 chars => ceil(11/4) = 3 tokens
    expect(result.tokens).toBe(3);
  });
});
