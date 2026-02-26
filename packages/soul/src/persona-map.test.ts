import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
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
  });

  test("returns empty instructions when not provided", async () => {
    const result = await resolvePersonaContent({ channelId: "@koi/channel-cli" }, undefined);
    expect(result.instructions).toBe("");
    expect(result.sources).toHaveLength(0);
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
  });

  test("returns empty instructions for missing file", async () => {
    const result = await resolvePersonaContent(
      { channelId: "@koi/channel-telegram", instructions: { path: "missing.md" } },
      tmpDir,
    );
    expect(result.instructions).toBe("");
    expect(result.sources).toHaveLength(0);
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
    });
    expect(text).toBe("You are Alex.\n\nBe casual.");
  });

  test("returns name only when no instructions", () => {
    const text = generatePersonaText({
      channelId: "@koi/channel-telegram",
      name: "Alex",
      instructions: "",
      sources: [],
    });
    expect(text).toBe("You are Alex.");
  });

  test("returns instructions only when no name", () => {
    const text = generatePersonaText({
      channelId: "@koi/channel-telegram",
      instructions: "Be casual.",
      sources: [],
    });
    expect(text).toBe("Be casual.");
  });

  test("returns undefined when neither name nor instructions", () => {
    const text = generatePersonaText({
      channelId: "@koi/channel-telegram",
      instructions: "",
      sources: [],
    });
    expect(text).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// createPersonaMap
// ---------------------------------------------------------------------------

describe("createPersonaMap", () => {
  test("creates map entries for personas with injectable content", async () => {
    const map = await createPersonaMap(
      [
        { channelId: "@koi/channel-telegram", name: "Alex", instructions: "Be casual." },
        { channelId: "@koi/channel-slack", instructions: "Be formal." },
      ],
      undefined,
    );
    expect(map.size).toBe(2);
    expect(map.has("@koi/channel-telegram")).toBe(true);
    expect(map.has("@koi/channel-slack")).toBe(true);
  });

  test("excludes personas with no name and no instructions", async () => {
    const map = await createPersonaMap(
      [{ channelId: "@koi/channel-cli" }, { channelId: "@koi/channel-telegram", name: "Alex" }],
      undefined,
    );
    expect(map.size).toBe(1);
    expect(map.has("@koi/channel-cli")).toBe(false);
  });

  test("stores text instead of pre-built message", async () => {
    const map = await createPersonaMap(
      [{ channelId: "@koi/channel-telegram", name: "Alex", instructions: "Be casual." }],
      undefined,
    );
    const cached = map.get("@koi/channel-telegram");
    expect(cached).toBeDefined();
    expect(cached?.text).toContain("You are Alex.");
    expect(cached?.text).toContain("Be casual.");
  });

  test("returns empty map for empty personas array", async () => {
    const map = await createPersonaMap([], undefined);
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

    const map = await createPersonaMap(
      [{ channelId: "@koi/channel-telegram", instructions: { path: "persona.md" } }],
      tmpDir,
    );
    const paths = createPersonaWatchedPaths(map);
    expect(paths.size).toBe(1);
  });

  test("returns empty set for inline-only personas", async () => {
    const map = await createPersonaMap(
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
