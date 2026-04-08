import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPluginRegistry } from "./registry.js";

describe("createPluginRegistry", () => {
  let testDir: string;
  let bundledRoot: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `koi-registry-test-${Date.now()}`);
    bundledRoot = join(testDir, "bundled");
    await mkdir(bundledRoot, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  async function writePlugin(
    root: string,
    name: string,
    manifest: Record<string, unknown>,
    files?: Record<string, string>,
  ): Promise<void> {
    const dir = join(root, name);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "plugin.json"), JSON.stringify(manifest));
    if (files) {
      for (const [path, content] of Object.entries(files)) {
        const fullPath = join(dir, path);
        await mkdir(join(fullPath, ".."), { recursive: true });
        await writeFile(fullPath, content);
      }
    }
  }

  const MANIFEST = { name: "test-plugin", version: "1.0.0", description: "Test" };

  // --- Resolver conformance ---

  test("discover() returns PluginMeta array", async () => {
    await writePlugin(bundledRoot, "test-plugin", MANIFEST);
    const registry = createPluginRegistry({ bundledRoot });
    const plugins = await registry.discover();
    expect(Array.isArray(plugins)).toBe(true);
    expect(plugins).toHaveLength(1);
    expect(plugins[0]?.name).toBe("test-plugin");
  });

  test("load() returns Result<LoadedPlugin, KoiError>", async () => {
    await writePlugin(bundledRoot, "test-plugin", MANIFEST);
    const registry = createPluginRegistry({ bundledRoot });
    const result = await registry.load("test-plugin");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.name).toBe("test-plugin");
      expect(result.value.skillPaths).toEqual([]);
      expect(result.value.middlewareNames).toEqual([]);
    }
  });

  // --- Load with paths ---

  test("load() resolves skill paths", async () => {
    const manifest = {
      ...MANIFEST,
      skills: ["./skills/greeting"],
    };
    await writePlugin(bundledRoot, "test-plugin", manifest, {
      "skills/greeting/SKILL.md": "# Greeting",
    });
    const registry = createPluginRegistry({ bundledRoot });
    const result = await registry.load("test-plugin");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.skillPaths).toHaveLength(1);
      expect(result.value.skillPaths[0]).toContain("skills/greeting");
    }
  });

  test("load() resolves hooks path", async () => {
    const manifest = { ...MANIFEST, hooks: "./hooks.json" };
    await writePlugin(bundledRoot, "test-plugin", manifest, {
      "hooks.json": "{}",
    });
    const registry = createPluginRegistry({ bundledRoot });
    const result = await registry.load("test-plugin");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.hookConfigPath).toContain("hooks.json");
    }
  });

  test("load() resolves mcpServers path", async () => {
    const manifest = { ...MANIFEST, mcpServers: "./.mcp.json" };
    await writePlugin(bundledRoot, "test-plugin", manifest, {
      ".mcp.json": "{}",
    });
    const registry = createPluginRegistry({ bundledRoot });
    const result = await registry.load("test-plugin");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.mcpConfigPath).toContain(".mcp.json");
    }
  });

  test("load() populates middlewareNames from manifest", async () => {
    const manifest = { ...MANIFEST, middleware: ["my-mw", "other-mw"] };
    await writePlugin(bundledRoot, "test-plugin", manifest);
    const registry = createPluginRegistry({ bundledRoot });
    const result = await registry.load("test-plugin");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.middlewareNames).toEqual(["my-mw", "other-mw"]);
    }
  });

  // --- Error cases ---

  test("load() unknown plugin returns NOT_FOUND", async () => {
    const registry = createPluginRegistry({ bundledRoot });
    const result = await registry.load("nonexistent");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NOT_FOUND");
    }
  });

  test("load() rejects path traversal in skills", async () => {
    const manifest = { ...MANIFEST, skills: ["../../../etc"] };
    await writePlugin(bundledRoot, "test-plugin", manifest);
    const registry = createPluginRegistry({ bundledRoot });
    const result = await registry.load("test-plugin");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("PERMISSION");
    }
  });

  // --- Availability filtering ---

  test("discover() filters out unavailable plugins", async () => {
    await writePlugin(bundledRoot, "available", {
      name: "available",
      version: "1.0.0",
      description: "Yes",
    });
    await writePlugin(bundledRoot, "hidden", {
      name: "hidden",
      version: "1.0.0",
      description: "No",
    });

    const registry = createPluginRegistry({
      bundledRoot,
      isAvailable: (m) => m.name !== "hidden",
    });
    const plugins = await registry.discover();
    expect(plugins).toHaveLength(1);
    expect(plugins[0]?.name).toBe("available");
  });

  // --- Invalidation ---

  test("invalidate() clears cache — next discover() re-scans", async () => {
    await writePlugin(bundledRoot, "test-plugin", MANIFEST);
    const registry = createPluginRegistry({ bundledRoot });

    const first = await registry.discover();
    expect(first).toHaveLength(1);

    // Add a new plugin
    await writePlugin(bundledRoot, "new-plugin", {
      name: "new-plugin",
      version: "1.0.0",
      description: "New",
    });

    // Without invalidate, cached result
    const cached = await registry.discover();
    expect(cached).toHaveLength(1);

    // After invalidate, re-scans
    registry.invalidate();
    const refreshed = await registry.discover();
    expect(refreshed).toHaveLength(2);
  });

  // --- Errors ---

  test("errors() returns per-plugin discovery errors", async () => {
    // Create an invalid plugin
    const badDir = join(bundledRoot, "bad");
    await mkdir(badDir, { recursive: true });
    await writeFile(join(badDir, "plugin.json"), JSON.stringify({ name: "Bad!" }));

    const registry = createPluginRegistry({ bundledRoot });
    await registry.discover();
    const errs = registry.errors();
    expect(errs).toHaveLength(1);
    expect(errs[0]?.error.code).toBe("VALIDATION");
  });

  // --- Inflight dedup ---

  test("concurrent discover() calls return same result", async () => {
    await writePlugin(bundledRoot, "test-plugin", MANIFEST);
    const registry = createPluginRegistry({ bundledRoot });

    const [a, b] = await Promise.all([registry.discover(), registry.discover()]);
    expect(a).toBe(b); // Same reference = deduped
  });

  test("concurrent load() calls return same result", async () => {
    await writePlugin(bundledRoot, "test-plugin", MANIFEST);
    const registry = createPluginRegistry({ bundledRoot });

    const [a, b] = await Promise.all([registry.load("test-plugin"), registry.load("test-plugin")]);
    expect(a).toBe(b); // Same reference = deduped
  });
});
