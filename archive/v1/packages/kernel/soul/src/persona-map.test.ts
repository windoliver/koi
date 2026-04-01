import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CHARS_PER_TOKEN } from "@koi/file-resolution";
import { DEFAULT_IDENTITY_MAX_TOKENS } from "./config.js";
import {
  createPersonaMap,
  createPersonaWatchedPaths,
  generatePersonaText,
  resolvePersonaContent,
} from "./persona-map.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = join(import.meta.dir, "__test_tmp__", crypto.randomUUID());
  await mkdir(tmpDir, { recursive: true });
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// resolvePersonaContent
// ---------------------------------------------------------------------------

describe("resolvePersonaContent", () => {
  test("returns inline instructions with no sources tracked", async () => {
    const result = await resolvePersonaContent(
      { channelId: "@koi/channel-telegram", instructions: "Be casual." },
      undefined,
    );
    expect(result.channelId).toBe("@koi/channel-telegram");
    expect(result.instructions).toBe("Be casual.");
    expect(result.sources).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });

  test("returns empty instructions when not provided", async () => {
    const result = await resolvePersonaContent({ channelId: "@koi/channel-cli" }, undefined);
    expect(result.instructions).toBe("");
    expect(result.sources).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });

  test("reads file instructions asynchronously", async () => {
    const filePath = join(tmpDir, "persona.md");
    await writeFile(filePath, "Be helpful and concise.");

    const result = await resolvePersonaContent(
      { channelId: "@koi/channel-telegram", instructions: { path: "persona.md" } },
      tmpDir,
    );
    expect(result.instructions).toBe("Be helpful and concise.");
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]).toContain("persona.md");
    expect(result.warnings).toHaveLength(0);
  });

  test("returns empty instructions for missing file", async () => {
    const result = await resolvePersonaContent(
      { channelId: "@koi/channel-telegram", instructions: { path: "missing.md" } },
      tmpDir,
    );
    expect(result.instructions).toBe("");
    expect(result.sources).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });

  test("includes name and avatar when provided", async () => {
    const result = await resolvePersonaContent(
      { channelId: "@koi/channel-slack", name: "Alex", avatar: "casual.png" },
      undefined,
    );
    expect(result.name).toBe("Alex");
    expect(result.avatar).toBe("casual.png");
  });

  test("omits name and avatar when not provided", async () => {
    const result = await resolvePersonaContent({ channelId: "@koi/channel-cli" }, undefined);
    expect("name" in result).toBe(false);
    expect("avatar" in result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// generatePersonaText
// ---------------------------------------------------------------------------

describe("generatePersonaText", () => {
  test("returns name + instructions when both present", () => {
    const text = generatePersonaText({
      channelId: "@koi/channel-telegram",
      name: "Alex",
      instructions: "Be casual.",
      sources: [],
      warnings: [],
    });
    expect(text).toBe("You are Alex.\n\nBe casual.");
  });

  test("returns name only when no instructions", () => {
    const text = generatePersonaText({
      channelId: "@koi/channel-telegram",
      name: "Alex",
      instructions: "",
      sources: [],
      warnings: [],
    });
    expect(text).toBe("You are Alex.");
  });

  test("returns instructions only when no name", () => {
    const text = generatePersonaText({
      channelId: "@koi/channel-telegram",
      instructions: "Be casual.",
      sources: [],
      warnings: [],
    });
    expect(text).toBe("Be casual.");
  });

  test("returns undefined when neither name nor instructions", () => {
    const text = generatePersonaText({
      channelId: "@koi/channel-telegram",
      instructions: "",
      sources: [],
      warnings: [],
    });
    expect(text).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// createPersonaMap
// ---------------------------------------------------------------------------

describe("createPersonaMap", () => {
  test("creates map entries for personas with injectable content", async () => {
    const { map, warnings } = await createPersonaMap(
      [
        { channelId: "@koi/channel-telegram", name: "Alex", instructions: "Be casual." },
        { channelId: "@koi/channel-slack", instructions: "Be formal." },
      ],
      undefined,
    );
    expect(map.size).toBe(2);
    expect(map.has("@koi/channel-telegram")).toBe(true);
    expect(map.has("@koi/channel-slack")).toBe(true);
    expect(warnings).toHaveLength(0);
  });

  test("excludes personas with no name and no instructions", async () => {
    const { map } = await createPersonaMap(
      [{ channelId: "@koi/channel-cli" }, { channelId: "@koi/channel-telegram", name: "Alex" }],
      undefined,
    );
    expect(map.size).toBe(1);
    expect(map.has("@koi/channel-cli")).toBe(false);
  });

  test("stores text instead of pre-built message", async () => {
    const { map } = await createPersonaMap(
      [{ channelId: "@koi/channel-telegram", name: "Alex", instructions: "Be casual." }],
      undefined,
    );
    const cached = map.get("@koi/channel-telegram");
    expect(cached).toBeDefined();
    expect(cached?.text).toContain("You are Alex.");
    expect(cached?.text).toContain("Be casual.");
  });

  test("returns empty map for empty personas array", async () => {
    const { map } = await createPersonaMap([], undefined);
    expect(map.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// createPersonaWatchedPaths
// ---------------------------------------------------------------------------

describe("createPersonaWatchedPaths", () => {
  test("collects file paths from cached persona sources", async () => {
    const filePath = join(tmpDir, "persona.md");
    await writeFile(filePath, "Be helpful.");

    const { map } = await createPersonaMap(
      [{ channelId: "@koi/channel-telegram", instructions: { path: "persona.md" } }],
      tmpDir,
    );
    const paths = createPersonaWatchedPaths(map);
    expect(paths.size).toBe(1);
  });

  test("returns empty set for inline-only personas", async () => {
    const { map } = await createPersonaMap(
      [{ channelId: "@koi/channel-telegram", name: "Alex" }],
      undefined,
    );
    const paths = createPersonaWatchedPaths(map);
    expect(paths.size).toBe(0);
  });

  test("returns empty set for empty map", () => {
    const paths = createPersonaWatchedPaths(new Map());
    expect(paths.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Token budget enforcement
// ---------------------------------------------------------------------------

describe("token budget enforcement", () => {
  const defaultMaxChars = DEFAULT_IDENTITY_MAX_TOKENS * CHARS_PER_TOKEN; // 2000 * 4 = 8000

  test("file content truncated to default budget", async () => {
    const filePath = join(tmpDir, "large-persona.md");
    const oversized = "x".repeat(defaultMaxChars + 1000);
    await writeFile(filePath, oversized);

    const result = await resolvePersonaContent(
      { channelId: "@koi/channel-telegram", instructions: { path: "large-persona.md" } },
      tmpDir,
    );
    expect(result.instructions.length).toBeLessThanOrEqual(defaultMaxChars);
  });

  test("inline content truncated to default budget", async () => {
    const oversized = "y".repeat(defaultMaxChars + 500);

    const result = await resolvePersonaContent(
      { channelId: "@koi/channel-telegram", instructions: oversized },
      undefined,
    );
    expect(result.instructions.length).toBeLessThanOrEqual(defaultMaxChars);
  });

  test("warnings returned when truncation occurs", async () => {
    const filePath = join(tmpDir, "big-persona.md");
    await writeFile(filePath, "z".repeat(defaultMaxChars + 2000));

    const result = await resolvePersonaContent(
      { channelId: "@koi/channel-telegram", instructions: { path: "big-persona.md" } },
      tmpDir,
    );
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0]).toContain("truncated");
  });

  test("per-persona maxTokens override honored", async () => {
    const customMaxTokens = 500;
    const customMaxChars = customMaxTokens * CHARS_PER_TOKEN; // 2000
    const filePath = join(tmpDir, "custom-persona.md");
    await writeFile(filePath, "a".repeat(customMaxChars + 500));

    const result = await resolvePersonaContent(
      {
        channelId: "@koi/channel-telegram",
        instructions: { path: "custom-persona.md", maxTokens: customMaxTokens },
      },
      tmpDir,
    );
    expect(result.instructions.length).toBeLessThanOrEqual(customMaxChars);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  test("content within budget passes through unchanged", async () => {
    const filePath = join(tmpDir, "small-persona.md");
    const content = "Short persona instructions.";
    await writeFile(filePath, content);

    const result = await resolvePersonaContent(
      { channelId: "@koi/channel-telegram", instructions: { path: "small-persona.md" } },
      tmpDir,
    );
    expect(result.instructions).toBe(content);
    expect(result.warnings).toHaveLength(0);
  });

  test("createPersonaMap aggregates warnings from multiple personas", async () => {
    const oversized = "w".repeat(defaultMaxChars + 1000);
    const filePath = join(tmpDir, "p1.md");
    await writeFile(filePath, oversized);

    const { warnings } = await createPersonaMap(
      [
        { channelId: "@koi/channel-telegram", instructions: oversized },
        { channelId: "@koi/channel-slack", instructions: { path: "p1.md" } },
      ],
      tmpDir,
    );
    expect(warnings.length).toBe(2);
  });
});
