import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { processIncludes } from "./include.js";

const TMP_DIR = "/tmp/koi-include-test";

afterEach(async () => {
  // Clean up temp files
  try {
    const { rm } = await import("node:fs/promises");
    await rm(TMP_DIR, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

async function writeTemp(name: string, content: string): Promise<string> {
  const path = join(TMP_DIR, name);
  await Bun.write(path, content);
  return path;
}

describe("processIncludes", () => {
  test("returns object unchanged when no $include key", async () => {
    const parsed = { logLevel: "debug", limits: { maxTurns: 10 } };
    const result = await processIncludes(parsed, "/tmp/koi.yaml");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual(parsed);
    }
  });

  test("merges a single included file", async () => {
    await writeTemp("limits.yaml", "limits:\n  maxTurns: 50\n");
    const mainPath = await writeTemp("koi.yaml", "logLevel: debug\n");

    const parsed = {
      $include: "limits.yaml",
      logLevel: "debug",
    };

    const result = await processIncludes(parsed, mainPath);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.logLevel).toBe("debug"); // main wins
      const limits = result.value.limits as Record<string, unknown>;
      expect(limits.maxTurns).toBe(50); // from include
      expect(result.value.$include).toBeUndefined(); // stripped
    }
  });

  test("merges multiple included files in order", async () => {
    await writeTemp("a.yaml", "key1: a\nkey2: a\n");
    await writeTemp("b.yaml", "key2: b\nkey3: b\n");
    const mainPath = await writeTemp("koi.yaml", "");

    const parsed = {
      $include: ["a.yaml", "b.yaml"],
      key3: "main",
    };

    const result = await processIncludes(parsed, mainPath);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.key1).toBe("a"); // from a
      expect(result.value.key2).toBe("b"); // b overrides a
      expect(result.value.key3).toBe("main"); // main wins
    }
  });

  test("resolves nested $include directives", async () => {
    await writeTemp("deep.yaml", "deepKey: deep\n");
    await writeTemp("mid.yaml", "$include: deep.yaml\nmidKey: mid\n");
    const mainPath = await writeTemp("koi.yaml", "");

    const parsed = {
      $include: "mid.yaml",
      topKey: "top",
    };

    const result = await processIncludes(parsed, mainPath);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.deepKey).toBe("deep");
      expect(result.value.midKey).toBe("mid");
      expect(result.value.topKey).toBe("top");
    }
  });

  test("detects include cycles and returns error", async () => {
    const aPath = join(TMP_DIR, "a.yaml");
    const bPath = join(TMP_DIR, "b.yaml");
    await Bun.write(aPath, "$include: b.yaml\nfoo: a\n");
    await Bun.write(bPath, `$include: a.yaml\nbar: b\n`);

    const parsed = { $include: "a.yaml" };
    const result = await processIncludes(parsed, await writeTemp("main.yaml", ""));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message).toContain("cycle");
    }
  });

  test("enforces max depth", async () => {
    // Create a chain: d3 -> d2 -> d1 -> d0 (4 levels deep)
    await writeTemp("d0.yaml", "leaf: true\n");
    await writeTemp("d1.yaml", "$include: d0.yaml\n");
    await writeTemp("d2.yaml", "$include: d1.yaml\n");
    await writeTemp("d3.yaml", "$include: d2.yaml\n");
    const mainPath = await writeTemp("main.yaml", "");

    // maxDepth=2 means at most 2 levels of nesting
    const parsed = { $include: "d3.yaml" };
    const result = await processIncludes(parsed, mainPath, { maxDepth: 2 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message).toContain("depth");
    }
  });

  test("returns error for invalid $include type", async () => {
    const parsed = { $include: 42 };
    const result = await processIncludes(parsed, "/tmp/koi.yaml");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
    }
  });

  test("returns error when included file not found", async () => {
    const mainPath = await writeTemp("koi.yaml", "");
    const parsed = { $include: "nonexistent.yaml" };
    const result = await processIncludes(parsed, mainPath);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NOT_FOUND");
    }
  });

  test("does not mutate input", async () => {
    await writeTemp("extra.yaml", "extra: value\n");
    const mainPath = await writeTemp("koi.yaml", "");
    const parsed = {
      $include: "extra.yaml",
      logLevel: "debug",
      nested: { key: "original" },
    };
    const snapshot = JSON.parse(JSON.stringify(parsed)) as typeof parsed;
    await processIncludes(parsed, mainPath);
    expect(parsed).toEqual(snapshot);
  });

  test("allows diamond-shaped include graphs", async () => {
    // Both a.yaml and b.yaml include shared.yaml — not a cycle
    await writeTemp("shared.yaml", "shared: true\n");
    await writeTemp("a.yaml", "$include: shared.yaml\na: true\n");
    await writeTemp("b.yaml", "$include: shared.yaml\nb: true\n");
    const mainPath = await writeTemp("main.yaml", "");

    const parsed = { $include: ["a.yaml", "b.yaml"] };
    const result = await processIncludes(parsed, mainPath);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.shared).toBe(true);
      expect(result.value.a).toBe(true);
      expect(result.value.b).toBe(true);
    }
  });

  test("returns error for $include array with non-string elements", async () => {
    const parsed = { $include: ["valid.yaml", 42] };
    const result = await processIncludes(parsed, "/tmp/koi.yaml");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
    }
  });

  test("returns error when included file is not a plain object", async () => {
    await writeTemp("array.yaml", "- item1\n- item2\n");
    const mainPath = await writeTemp("koi.yaml", "");
    const parsed = { $include: "array.yaml" };
    const result = await processIncludes(parsed, mainPath);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message).toContain("plain object");
    }
  });
});
