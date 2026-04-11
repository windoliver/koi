import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveDirectoryContent } from "./directory.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = join(tmpdir(), "koi-file-resolution-test", crypto.randomUUID());
  await mkdir(tmpDir, { recursive: true });
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe("resolveDirectoryContent", () => {
  test("reads SOUL.md + STYLE.md + INSTRUCTIONS.md", async () => {
    await writeFile(join(tmpDir, "SOUL.md"), "I am helpful.");
    await writeFile(join(tmpDir, "STYLE.md"), "Be concise.");
    await writeFile(join(tmpDir, "INSTRUCTIONS.md"), "Always cite sources.");

    const result = await resolveDirectoryContent(tmpDir, "soul");

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
    await writeFile(join(tmpDir, "SOUL.md"), "Just the soul.");

    const result = await resolveDirectoryContent(tmpDir, "soul");

    expect(result.text).toContain("## Soul");
    expect(result.text).toContain("Just the soul.");
    expect(result.sources).toHaveLength(1);
    expect(result.warnings).toHaveLength(0);
  });

  test("returns error when directory missing SOUL.md", async () => {
    await writeFile(join(tmpDir, "STYLE.md"), "Some style.");

    const result = await resolveDirectoryContent(tmpDir, "soul");

    expect(result.text).toBe("");
    expect(result.sources).toHaveLength(0);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("missing required SOUL.md");
  });

  test("warns on empty SOUL.md", async () => {
    await writeFile(join(tmpDir, "SOUL.md"), "");

    const result = await resolveDirectoryContent(tmpDir, "soul");

    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("empty");
  });

  test("warns on empty optional file", async () => {
    await writeFile(join(tmpDir, "SOUL.md"), "Core soul.");
    await writeFile(join(tmpDir, "STYLE.md"), "");

    const result = await resolveDirectoryContent(tmpDir, "soul");

    expect(result.sources).toHaveLength(2);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("STYLE.md is empty");
  });

  test("includes label in warning messages", async () => {
    const result = await resolveDirectoryContent(join(tmpDir, "missing"), "custom-label");

    expect(result.warnings[0]).toContain("custom-label");
  });
});
