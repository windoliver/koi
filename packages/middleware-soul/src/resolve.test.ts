import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveSoulContent, resolveUserContent } from "./resolve.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = join(import.meta.dir, "__test_tmp__", crypto.randomUUID());
  await mkdir(tmpDir, { recursive: true });
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// resolveSoulContent — file mode
// ---------------------------------------------------------------------------

describe("resolveSoulContent — file mode", () => {
  test("reads content from file path", async () => {
    const filePath = join(tmpDir, "SOUL.md");
    await writeFile(filePath, "You are a helpful assistant.");

    const result = await resolveSoulContent({
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
    const result = await resolveSoulContent({
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
    const filePath = join(tmpDir, "empty.md");
    await writeFile(filePath, "");

    const result = await resolveSoulContent({
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
    const filePath = join(tmpDir, "big.md");
    // 4 chars per token, 10 tokens = 40 chars max
    await writeFile(filePath, "A".repeat(100));

    const result = await resolveSoulContent({
      input: "big.md",
      maxTokens: 10,
      label: "soul",
      basePath: tmpDir,
    });

    expect(result.text.length).toBe(40); // 10 tokens * 4 chars
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("truncated");
  });
});

// ---------------------------------------------------------------------------
// resolveSoulContent — inline mode
// ---------------------------------------------------------------------------

describe("resolveSoulContent — inline mode", () => {
  test("returns inline content directly", async () => {
    const result = await resolveSoulContent({
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
    const longContent = `Line one\n${"A".repeat(100)}`;

    const result = await resolveSoulContent({
      input: longContent,
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
// resolveSoulContent — directory mode
// ---------------------------------------------------------------------------

describe("resolveSoulContent — directory mode", () => {
  test("reads SOUL.md + STYLE.md + INSTRUCTIONS.md from directory", async () => {
    const soulDir = join(tmpDir, "soul");
    await mkdir(soulDir, { recursive: true });
    await writeFile(join(soulDir, "SOUL.md"), "I am helpful.");
    await writeFile(join(soulDir, "STYLE.md"), "Be concise.");
    await writeFile(join(soulDir, "INSTRUCTIONS.md"), "Always cite sources.");

    const result = await resolveSoulContent({
      input: "soul",
      maxTokens: 4000,
      label: "soul",
      basePath: tmpDir,
    });

    expect(result.text).toContain("## Soul");
    expect(result.text).toContain("I am helpful.");
    expect(result.text).toContain("## Style");
    expect(result.text).toContain("Be concise.");
    expect(result.text).toContain("## Instructions");
    expect(result.text).toContain("Always cite sources.");
    expect(result.sources).toHaveLength(3);
    expect(result.warnings).toHaveLength(0);
  });

  test("works with only SOUL.md present", async () => {
    const soulDir = join(tmpDir, "soul-only");
    await mkdir(soulDir, { recursive: true });
    await writeFile(join(soulDir, "SOUL.md"), "Just the soul.");

    const result = await resolveSoulContent({
      input: "soul-only",
      maxTokens: 4000,
      label: "soul",
      basePath: tmpDir,
    });

    expect(result.text).toContain("## Soul");
    expect(result.text).toContain("Just the soul.");
    expect(result.sources).toHaveLength(1);
    expect(result.warnings).toHaveLength(0);
  });

  test("returns error when directory missing SOUL.md", async () => {
    const soulDir = join(tmpDir, "no-soul");
    await mkdir(soulDir, { recursive: true });
    await writeFile(join(soulDir, "STYLE.md"), "Some style.");

    const result = await resolveSoulContent({
      input: "no-soul",
      maxTokens: 4000,
      label: "soul",
      basePath: tmpDir,
    });

    expect(result.text).toBe("");
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("missing required SOUL.md");
  });

  test("truncates directory content exceeding maxTokens", async () => {
    const soulDir = join(tmpDir, "big-soul");
    await mkdir(soulDir, { recursive: true });
    await writeFile(join(soulDir, "SOUL.md"), "A".repeat(200));

    const result = await resolveSoulContent({
      input: "big-soul",
      maxTokens: 10,
      label: "soul",
      basePath: tmpDir,
    });

    // ## Soul\n + content = truncated
    expect(result.text.length).toBe(40);
    expect(result.warnings.some((w) => w.includes("truncated"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// resolveSoulContent — token estimation
// ---------------------------------------------------------------------------

describe("resolveSoulContent — token estimation", () => {
  test("estimates tokens at 4 chars per token", async () => {
    const result = await resolveSoulContent({
      input: "Hello\nWorld",
      maxTokens: 4000,
      label: "soul",
      basePath: tmpDir,
    });

    // "Hello\nWorld" = 11 chars → ceil(11/4) = 3 tokens
    expect(result.tokens).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// resolveUserContent
// ---------------------------------------------------------------------------

describe("resolveUserContent", () => {
  test("reads content from file path", async () => {
    const filePath = join(tmpDir, "USER.md");
    await writeFile(filePath, "User prefers dark mode.");

    const result = await resolveUserContent({
      input: "USER.md",
      maxTokens: 2000,
      label: "user",
      basePath: tmpDir,
    });

    expect(result.text).toBe("User prefers dark mode.");
    expect(result.sources).toHaveLength(1);
    expect(result.warnings).toHaveLength(0);
  });

  test("returns inline content directly", async () => {
    const result = await resolveUserContent({
      input: "Name: Alice\nRole: Developer",
      maxTokens: 2000,
      label: "user",
      basePath: tmpDir,
    });

    expect(result.text).toBe("Name: Alice\nRole: Developer");
    expect(result.sources).toEqual(["inline"]);
  });

  test("returns empty with warning for missing file", async () => {
    const result = await resolveUserContent({
      input: "missing-user.md",
      maxTokens: 2000,
      label: "user",
      basePath: tmpDir,
    });

    expect(result.text).toBe("");
    expect(result.tokens).toBe(0);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("not found");
  });

  test("truncates content exceeding maxTokens", async () => {
    const filePath = join(tmpDir, "big-user.md");
    await writeFile(filePath, "B".repeat(200));

    const result = await resolveUserContent({
      input: "big-user.md",
      maxTokens: 10,
      label: "user",
      basePath: tmpDir,
    });

    expect(result.text.length).toBe(40);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("truncated");
  });

  test("warns on empty file", async () => {
    const filePath = join(tmpDir, "empty-user.md");
    await writeFile(filePath, "");

    const result = await resolveUserContent({
      input: "empty-user.md",
      maxTokens: 2000,
      label: "user",
      basePath: tmpDir,
    });

    expect(result.text).toBe("");
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("empty");
  });
});
