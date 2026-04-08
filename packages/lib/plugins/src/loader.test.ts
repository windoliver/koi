import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverPlugins } from "./loader.js";
import { pluginId } from "./plugin-id.js";

describe("discoverPlugins", () => {
  let testDir: string;
  let bundledRoot: string;
  let userRoot: string;
  let managedRoot: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `koi-plugins-test-${Date.now()}`);
    bundledRoot = join(testDir, "bundled");
    userRoot = join(testDir, "user");
    managedRoot = join(testDir, "managed");
    await mkdir(bundledRoot, { recursive: true });
    await mkdir(userRoot, { recursive: true });
    await mkdir(managedRoot, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  async function writePlugin(
    root: string,
    name: string,
    manifest: Record<string, unknown>,
  ): Promise<void> {
    const dir = join(root, name);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "plugin.json"), JSON.stringify(manifest));
  }

  const MANIFEST_A = { name: "plugin-a", version: "1.0.0", description: "Plugin A" };
  const MANIFEST_B = { name: "plugin-b", version: "2.0.0", description: "Plugin B" };

  test("discovers from all 3 sources", async () => {
    await writePlugin(bundledRoot, "plugin-a", MANIFEST_A);
    await writePlugin(userRoot, "plugin-b", MANIFEST_B);

    const result = await discoverPlugins({ bundledRoot, userRoot, managedRoot });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const names = result.value.plugins.map((p) => p.name).sort();
      expect(names).toEqual(["plugin-a", "plugin-b"]);
    }
  });

  test("missing root directory skipped silently", async () => {
    const result = await discoverPlugins({
      bundledRoot: join(testDir, "nonexistent"),
      userRoot: join(testDir, "also-missing"),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.plugins).toHaveLength(0);
      expect(result.value.errors).toHaveLength(0);
    }
  });

  test("shadowing: managed > user > bundled", async () => {
    // Same plugin name in all 3 sources with different versions
    await writePlugin(bundledRoot, "shared", {
      name: "shared",
      version: "1.0.0",
      description: "Bundled",
    });
    await writePlugin(userRoot, "shared", {
      name: "shared",
      version: "2.0.0",
      description: "User",
    });
    await writePlugin(managedRoot, "shared", {
      name: "shared",
      version: "3.0.0",
      description: "Managed",
    });

    const result = await discoverPlugins({ bundledRoot, userRoot, managedRoot });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.plugins).toHaveLength(1);
      const plugin = result.value.plugins[0];
      expect(plugin).toBeDefined();
      expect(plugin?.source).toBe("managed");
      expect(plugin?.version).toBe("3.0.0");
    }
  });

  test("user shadows bundled when managed is absent", async () => {
    await writePlugin(bundledRoot, "shared", {
      name: "shared",
      version: "1.0.0",
      description: "Bundled",
    });
    await writePlugin(userRoot, "shared", {
      name: "shared",
      version: "2.0.0",
      description: "User",
    });

    const result = await discoverPlugins({ bundledRoot, userRoot });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.plugins).toHaveLength(1);
      expect(result.value.plugins[0]?.source).toBe("user");
    }
  });

  test("per-plugin errors collected — bad manifest does not block others", async () => {
    await writePlugin(bundledRoot, "good", MANIFEST_A);
    // Invalid manifest — missing required fields
    const badDir = join(bundledRoot, "bad");
    await mkdir(badDir, { recursive: true });
    await writeFile(join(badDir, "plugin.json"), JSON.stringify({ name: "Bad Name!" }));

    const result = await discoverPlugins({ bundledRoot });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.plugins).toHaveLength(1);
      expect(result.value.plugins[0]?.name).toBe("plugin-a");
      expect(result.value.errors).toHaveLength(1);
      expect(result.value.errors[0]?.error.code).toBe("VALIDATION");
    }
  });

  test("isAvailable() false marks plugin as unavailable", async () => {
    await writePlugin(bundledRoot, "plugin-a", MANIFEST_A);
    await writePlugin(bundledRoot, "plugin-b", MANIFEST_B);

    const result = await discoverPlugins({
      bundledRoot,
      isAvailable: (manifest) => manifest.name !== "plugin-a",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const pluginA = result.value.plugins.find((p) => p.name === "plugin-a");
      const pluginB = result.value.plugins.find((p) => p.name === "plugin-b");
      expect(pluginA?.available).toBe(false);
      expect(pluginB?.available).toBe(true);
    }
  });

  test("directories without plugin.json are skipped", async () => {
    await mkdir(join(bundledRoot, "no-manifest"), { recursive: true });
    await writePlugin(bundledRoot, "valid", MANIFEST_A);

    const result = await discoverPlugins({ bundledRoot });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.plugins).toHaveLength(1);
    }
  });

  test("symlinked plugin directory outside root is rejected", async () => {
    const outsideDir = join(testDir, "outside-plugins", "escape-plugin");
    await mkdir(outsideDir, { recursive: true });
    await writeFile(
      join(outsideDir, "plugin.json"),
      JSON.stringify({ name: "escape-plugin", version: "1.0.0", description: "Escaped" }),
    );

    // Create symlink inside bundledRoot pointing outside
    await symlink(outsideDir, join(bundledRoot, "escape-plugin"));

    const result = await discoverPlugins({ bundledRoot });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.plugins).toHaveLength(0);
      expect(result.value.errors).toHaveLength(1);
      expect(result.value.errors[0]?.error.code).toBe("PERMISSION");
    }
  });

  test("malformed plugin.json records error instead of silent skip", async () => {
    const badDir = join(bundledRoot, "bad-json");
    await mkdir(badDir, { recursive: true });
    await writeFile(join(badDir, "plugin.json"), "{ not valid json");

    const result = await discoverPlugins({ bundledRoot });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.plugins).toHaveLength(0);
      expect(result.value.errors).toHaveLength(1);
      expect(result.value.errors[0]?.error.code).toBe("VALIDATION");
    }
  });

  test("plugin meta has correct structure", async () => {
    await writePlugin(bundledRoot, "plugin-a", MANIFEST_A);

    const result = await discoverPlugins({ bundledRoot });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const plugin = result.value.plugins[0];
      expect(plugin).toBeDefined();
      expect(plugin?.id).toBe(pluginId("plugin-a"));
      expect(plugin?.name).toBe("plugin-a");
      expect(plugin?.source).toBe("bundled");
      expect(plugin?.version).toBe("1.0.0");
      expect(plugin?.description).toBe("Plugin A");
      const expectedDir = await realpath(join(bundledRoot, "plugin-a"));
      expect(plugin?.dirPath).toBe(expectedDir);
      expect(plugin?.manifest).toEqual(MANIFEST_A);
      expect(plugin?.available).toBe(true);
    }
  });
});
