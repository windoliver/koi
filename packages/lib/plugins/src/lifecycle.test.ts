import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  disablePlugin,
  enablePlugin,
  installPlugin,
  listPlugins,
  removePlugin,
  updatePlugin,
} from "./lifecycle.js";
import { createPluginRegistry } from "./registry.js";
import { readPluginState } from "./state.js";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const SUFFIX = Math.random().toString(36).slice(2, 8);
const tmpRoot = join(import.meta.dir, `../tmpkoi-lifecycle-test-${SUFFIX}`);
const userRoot = join(tmpRoot, "user-plugins");
const sourceDir = join(tmpRoot, "source");

async function writePluginJson(dir: string, name: string, version = "1.0.0"): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "plugin.json"),
    JSON.stringify({ name, version, description: `Test plugin ${name}` }),
    "utf-8",
  );
}

function createConfig(): {
  readonly userRoot: string;
  readonly registry: ReturnType<typeof createPluginRegistry>;
} {
  const registry = createPluginRegistry({ userRoot });
  return { userRoot, registry };
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeEach(async () => {
  await mkdir(tmpRoot, { recursive: true });
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// installPlugin
// ---------------------------------------------------------------------------

describe("installPlugin", () => {
  test("installs plugin from source path", async () => {
    const src = join(sourceDir, "my-plugin");
    await writePluginJson(src, "my-plugin");
    const config = createConfig();

    const result = await installPlugin(config, src);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.name).toBe("my-plugin");
      expect(result.value.version).toBe("1.0.0");
    }
  });

  test("returns CONFLICT when plugin already installed", async () => {
    const src = join(sourceDir, "my-plugin");
    await writePluginJson(src, "my-plugin");
    const config = createConfig();

    await installPlugin(config, src);
    const result = await installPlugin(config, src);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("CONFLICT");
    }
  });

  test("creates userRoot if it does not exist", async () => {
    const src = join(sourceDir, "new-plugin");
    await writePluginJson(src, "new-plugin");
    const deepRoot = join(tmpRoot, "deep", "nested", "plugins");
    const config = { userRoot: deepRoot, registry: createPluginRegistry({ userRoot: deepRoot }) };

    const result = await installPlugin(config, src);
    expect(result.ok).toBe(true);
  });

  test("returns NOT_FOUND for missing source plugin.json", async () => {
    const src = join(sourceDir, "empty");
    await mkdir(src, { recursive: true });
    const config = createConfig();

    const result = await installPlugin(config, src);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NOT_FOUND");
    }
  });

  test("rejects plugin with invalid name (path traversal)", async () => {
    const src = join(sourceDir, "evil");
    await mkdir(src, { recursive: true });
    await writeFile(
      join(src, "plugin.json"),
      JSON.stringify({ name: "../../evil", version: "1.0.0", description: "bad" }),
      "utf-8",
    );
    const config = createConfig();

    const result = await installPlugin(config, src);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
    }
  });
});

// ---------------------------------------------------------------------------
// removePlugin
// ---------------------------------------------------------------------------

describe("removePlugin", () => {
  test("removes an installed plugin", async () => {
    const src = join(sourceDir, "removable");
    await writePluginJson(src, "removable");
    const config = createConfig();

    await installPlugin(config, src);
    const result = await removePlugin(config, "removable");
    expect(result.ok).toBe(true);
  });

  test("returns NOT_FOUND for non-existent plugin", async () => {
    const config = createConfig();
    await mkdir(userRoot, { recursive: true });

    const result = await removePlugin(config, "does-not-exist");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NOT_FOUND");
    }
  });

  test("cleans up disabled state on remove", async () => {
    const src = join(sourceDir, "disabled-removed");
    await writePluginJson(src, "disabled-removed");
    const config = createConfig();

    await installPlugin(config, src);
    await disablePlugin(config, "disabled-removed");

    // Verify it's disabled
    const stateBefore = await readPluginState(userRoot);
    expect(stateBefore.ok).toBe(true);
    if (stateBefore.ok) {
      expect(stateBefore.value.has("disabled-removed")).toBe(true);
    }

    await removePlugin(config, "disabled-removed");

    // Verify disabled state is cleaned up
    const stateAfter = await readPluginState(userRoot);
    expect(stateAfter.ok).toBe(true);
    if (stateAfter.ok) {
      expect(stateAfter.value.has("disabled-removed")).toBe(false);
    }
  });

  test("rejects invalid plugin name", async () => {
    const config = createConfig();
    await mkdir(userRoot, { recursive: true });

    const result = await removePlugin(config, "../../etc");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
    }
  });
});

// ---------------------------------------------------------------------------
// enablePlugin / disablePlugin
// ---------------------------------------------------------------------------

describe("enablePlugin / disablePlugin", () => {
  test("disable then enable round-trips", async () => {
    const src = join(sourceDir, "test-plugin");
    await writePluginJson(src, "test-plugin");
    const config = createConfig();
    await installPlugin(config, src);

    const d = await disablePlugin(config, "test-plugin");
    expect(d.ok).toBe(true);

    const state1 = await readPluginState(userRoot);
    expect(state1.ok).toBe(true);
    if (state1.ok) {
      expect(state1.value.has("test-plugin")).toBe(true);
    }

    const e = await enablePlugin(config, "test-plugin");
    expect(e.ok).toBe(true);

    const state2 = await readPluginState(userRoot);
    expect(state2.ok).toBe(true);
    if (state2.ok) {
      expect(state2.value.has("test-plugin")).toBe(false);
    }
  });

  test("enable is idempotent for installed plugin", async () => {
    const src = join(sourceDir, "already-enabled");
    await writePluginJson(src, "already-enabled");
    const config = createConfig();
    await installPlugin(config, src);

    const r1 = await enablePlugin(config, "already-enabled");
    expect(r1.ok).toBe(true);
    const r2 = await enablePlugin(config, "already-enabled");
    expect(r2.ok).toBe(true);
  });

  test("disable is idempotent for installed plugin", async () => {
    const src = join(sourceDir, "to-disable");
    await writePluginJson(src, "to-disable");
    const config = createConfig();
    await installPlugin(config, src);

    const r1 = await disablePlugin(config, "to-disable");
    expect(r1.ok).toBe(true);
    const r2 = await disablePlugin(config, "to-disable");
    expect(r2.ok).toBe(true);
  });

  test("rejects non-existent plugin names", async () => {
    const config = createConfig();
    await mkdir(userRoot, { recursive: true });

    const r1 = await enablePlugin(config, "no-such-plugin");
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.error.code).toBe("NOT_FOUND");

    const r2 = await disablePlugin(config, "no-such-plugin");
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.error.code).toBe("NOT_FOUND");
  });
});

// ---------------------------------------------------------------------------
// updatePlugin
// ---------------------------------------------------------------------------

describe("updatePlugin", () => {
  test("updates plugin with new version", async () => {
    const srcV1 = join(sourceDir, "updatable-v1");
    await writePluginJson(srcV1, "updatable", "1.0.0");
    const config = createConfig();
    await installPlugin(config, srcV1);

    const srcV2 = join(sourceDir, "updatable-v2");
    await writePluginJson(srcV2, "updatable", "2.0.0");

    const result = await updatePlugin(config, "updatable", srcV2);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.version).toBe("2.0.0");
    }
  });

  test("returns NOT_FOUND for non-installed plugin", async () => {
    const config = createConfig();
    await mkdir(userRoot, { recursive: true });
    const src = join(sourceDir, "not-installed");
    await writePluginJson(src, "not-installed");

    const result = await updatePlugin(config, "not-installed", src);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NOT_FOUND");
    }
  });

  test("rejects name mismatch between source and target", async () => {
    const src = join(sourceDir, "original");
    await writePluginJson(src, "original");
    const config = createConfig();
    await installPlugin(config, src);

    const wrongSrc = join(sourceDir, "different");
    await writePluginJson(wrongSrc, "different");

    const result = await updatePlugin(config, "original", wrongSrc);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
    }
  });
});

// ---------------------------------------------------------------------------
// listPlugins
// ---------------------------------------------------------------------------

describe("listPlugins", () => {
  test("lists plugins with enabled status", async () => {
    const src1 = join(sourceDir, "list-a");
    const src2 = join(sourceDir, "list-b");
    await writePluginJson(src1, "list-a");
    await writePluginJson(src2, "list-b");
    const config = createConfig();

    await installPlugin(config, src1);
    await installPlugin(config, src2);
    await disablePlugin(config, "list-b");

    const result = await listPlugins(config);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const entries = result.value;
      const entryA = entries.find((e) => e.meta.name === "list-a");
      const entryB = entries.find((e) => e.meta.name === "list-b");
      expect(entryA?.enabled).toBe(true);
      expect(entryB?.enabled).toBe(false);
    }
  });

  test("returns empty list when no plugins installed", async () => {
    const config = createConfig();
    await mkdir(userRoot, { recursive: true });

    const result = await listPlugins(config);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.length).toBe(0);
    }
  });
});
