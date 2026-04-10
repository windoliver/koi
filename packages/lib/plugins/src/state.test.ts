import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readPluginState, writePluginState } from "./state.js";

describe("readPluginState", () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const tmpDir = join(import.meta.dir, `../tmpkoi-state-test-${suffix}`);

  beforeEach(async () => {
    await mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("returns empty set when state.json does not exist", async () => {
    const result = await readPluginState(tmpDir);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.size).toBe(0);
    }
  });

  test("round-trips disabled set correctly", async () => {
    const disabled = new Set(["plugin-a", "plugin-b"]);
    const writeResult = await writePluginState(tmpDir, disabled);
    expect(writeResult.ok).toBe(true);

    const readResult = await readPluginState(tmpDir);
    expect(readResult.ok).toBe(true);
    if (readResult.ok) {
      expect(readResult.value).toEqual(disabled);
    }
  });

  test("returns validation error for corrupt JSON", async () => {
    await writeFile(join(tmpDir, "state.json"), "not json", "utf-8");
    const result = await readPluginState(tmpDir);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
    }
  });

  test("returns validation error for invalid schema", async () => {
    await writeFile(join(tmpDir, "state.json"), '{"wrong": true}', "utf-8");
    const result = await readPluginState(tmpDir);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
    }
  });

  test("writes sorted disabled array", async () => {
    const disabled = new Set(["z-plugin", "a-plugin", "m-plugin"]);
    await writePluginState(tmpDir, disabled);

    const content = await Bun.file(join(tmpDir, "state.json")).text();
    const parsed = JSON.parse(content) as { disabled: readonly string[] };
    expect(parsed.disabled).toEqual(["a-plugin", "m-plugin", "z-plugin"]);
  });
});
