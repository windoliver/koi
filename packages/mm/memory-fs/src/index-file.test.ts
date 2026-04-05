import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MemoryRecord } from "@koi/core/memory";
import { memoryRecordId } from "@koi/core/memory";
import { readIndex, rebuildIndex } from "./index-file.js";

const TEST_ROOT = join(tmpdir(), "koi-index-file-test");

afterEach(async () => {
  await rm(TEST_ROOT, { recursive: true, force: true });
});

function makeRecord(id: string, name: string, createdAt: number): MemoryRecord {
  return {
    id: memoryRecordId(id),
    name,
    description: `Description for ${name}`,
    type: "user",
    content: `Content for ${name}`,
    filePath: `${id}.md`,
    createdAt,
    updatedAt: createdAt,
  };
}

describe("rebuildIndex + readIndex", () => {
  test("roundtrips records through MEMORY.md", async () => {
    const dir = join(TEST_ROOT, "roundtrip");
    await mkdir(dir, { recursive: true });

    const records = [
      makeRecord("role", "User Role", 1000),
      makeRecord("pref", "Preferences", 2000),
    ];

    await rebuildIndex(dir, records);
    const index = await readIndex(dir);

    expect(index.entries.length).toBe(2);
    // Newest first
    expect(index.entries[0]?.title).toBe("Preferences");
    expect(index.entries[0]?.filePath).toBe("pref.md");
    expect(index.entries[1]?.title).toBe("User Role");
    expect(index.entries[1]?.filePath).toBe("role.md");
  });

  test("truncates at MEMORY_INDEX_MAX_LINES", async () => {
    const dir = join(TEST_ROOT, "truncate");
    await mkdir(dir, { recursive: true });

    const records: MemoryRecord[] = [];
    for (let i = 0; i < 250; i++) {
      records.push(makeRecord(`r${String(i)}`, `Record ${String(i)}`, i));
    }

    await rebuildIndex(dir, records);
    const index = await readIndex(dir);

    expect(index.entries.length).toBe(200);
    // Newest should be first
    expect(index.entries[0]?.title).toBe("Record 249");
  });

  test("empty records produce empty index", async () => {
    const dir = join(TEST_ROOT, "empty");
    await mkdir(dir, { recursive: true });

    await rebuildIndex(dir, []);
    const index = await readIndex(dir);

    expect(index.entries.length).toBe(0);
  });

  test("readIndex returns empty for missing file", async () => {
    const dir = join(TEST_ROOT, "missing");
    const index = await readIndex(dir);
    expect(index.entries.length).toBe(0);
  });

  test("creates directory if it does not exist", async () => {
    const dir = join(TEST_ROOT, "auto-create", "nested");
    const records = [makeRecord("r1", "Test", 1000)];

    await rebuildIndex(dir, records);
    const index = await readIndex(dir);

    expect(index.entries.length).toBe(1);
  });
});
