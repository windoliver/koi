/**
 * Integration test for createRegistryProvider — full ComponentProvider assembly.
 *
 * Uses real SQLite-backed registries with in-memory databases to verify
 * the provider creates all expected tools, skill, and REGISTRY singleton.
 */

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import type { KoiError, Result, Tool } from "@koi/core";
import { REGISTRY, skillToken, toolToken } from "@koi/core";
import { createMockAgent, createTestToolArtifact } from "@koi/test-utils";
import { createSqliteBrickRegistry } from "../brick-registry.js";
import { createRegistryProvider } from "../registry-component-provider.js";
import { createSqliteSkillRegistry } from "../skill-registry.js";
import { createSqliteVersionIndex } from "../version-index.js";

function createTestBackends(): {
  readonly bricks: ReturnType<typeof createSqliteBrickRegistry>;
  readonly skills: ReturnType<typeof createSqliteSkillRegistry>;
  readonly versions: ReturnType<typeof createSqliteVersionIndex>;
} {
  const db = new Database(":memory:");
  db.run("PRAGMA foreign_keys = ON");
  return {
    bricks: createSqliteBrickRegistry({ db }),
    skills: createSqliteSkillRegistry({ db }),
    versions: createSqliteVersionIndex({ db }),
  };
}

function extractToolFromMap(components: ReadonlyMap<string, unknown>, toolName: string): Tool {
  const tool = components.get(toolToken(toolName) as string) as Tool | undefined;
  if (tool === undefined) {
    throw new Error(`Tool "${toolName}" not found in component map`);
  }
  return tool;
}

describe("createRegistryProvider", () => {
  test("provider name is 'registry-sqlite'", () => {
    const backends = createTestBackends();
    const provider = createRegistryProvider(backends);
    expect(provider.name).toBe("registry-sqlite");
  });

  test("attaches 4 tools + skill + REGISTRY singleton", async () => {
    const backends = createTestBackends();
    const provider = createRegistryProvider(backends);
    const agent = createMockAgent();

    const result = await provider.attach(agent);
    const components = result as ReadonlyMap<string, unknown>;

    // 4 tools + 1 skill + 1 REGISTRY singleton = 6 entries
    expect(components.size).toBe(6);
    expect(components.has(REGISTRY as string)).toBe(true);
    expect(components.has(toolToken("registry_search") as string)).toBe(true);
    expect(components.has(toolToken("registry_get") as string)).toBe(true);
    expect(components.has(toolToken("registry_list_versions") as string)).toBe(true);
    expect(components.has(toolToken("registry_install") as string)).toBe(true);
    expect(components.has(skillToken("registry-guide") as string)).toBe(true);
  });

  test("search tool finds registered bricks", async () => {
    const backends = createTestBackends();
    const toolArtifact = createTestToolArtifact({ name: "http-fetch", tags: ["http"] });
    await backends.bricks.register(toolArtifact);

    const provider = createRegistryProvider(backends);
    const agent = createMockAgent();
    const components = (await provider.attach(agent)) as ReadonlyMap<string, unknown>;

    const searchTool = extractToolFromMap(components, "registry_search");
    const result = (await searchTool.execute({ text: "http" })) as Record<string, unknown>;
    const items = result.items as readonly Record<string, unknown>[];

    expect(items.length).toBeGreaterThanOrEqual(1);
    expect(items[0]?.name).toBe("http-fetch");
  });

  test("get tool returns brick details", async () => {
    const backends = createTestBackends();
    const toolArtifact = createTestToolArtifact({ name: "my-tool" });
    await backends.bricks.register(toolArtifact);

    const provider = createRegistryProvider(backends);
    const agent = createMockAgent();
    const components = (await provider.attach(agent)) as ReadonlyMap<string, unknown>;

    const getTool = extractToolFromMap(components, "registry_get");
    const result = (await getTool.execute({
      kind: "tool",
      name: "my-tool",
      detail: "full",
    })) as Record<string, unknown>;

    expect(result.name).toBe("my-tool");
    expect(result.implementation).toBeDefined();
  });

  test("install tool with onInstall callback works end-to-end", async () => {
    const backends = createTestBackends();
    const toolArtifact = createTestToolArtifact({ name: "installable" });
    await backends.bricks.register(toolArtifact);

    let installed = false;
    const onInstall = async (): Promise<Result<void, KoiError>> => {
      installed = true;
      return { ok: true, value: undefined };
    };

    const provider = createRegistryProvider({ ...backends, onInstall });
    const agent = createMockAgent();
    const components = (await provider.attach(agent)) as ReadonlyMap<string, unknown>;

    const installTool = extractToolFromMap(components, "registry_install");
    const result = (await installTool.execute({
      kind: "tool",
      name: "installable",
    })) as Record<string, unknown>;

    expect(result.installed).toBe(true);
    expect(installed).toBe(true);
  });

  test("install tool without onInstall returns artifact data", async () => {
    const backends = createTestBackends();
    const toolArtifact = createTestToolArtifact({ name: "download-only" });
    await backends.bricks.register(toolArtifact);

    const provider = createRegistryProvider(backends);
    const agent = createMockAgent();
    const components = (await provider.attach(agent)) as ReadonlyMap<string, unknown>;

    const installTool = extractToolFromMap(components, "registry_install");
    const result = (await installTool.execute({
      kind: "tool",
      name: "download-only",
    })) as Record<string, unknown>;

    expect(result.installed).toBe(false);
    const artifact = result.artifact as Record<string, unknown>;
    expect(artifact.name).toBe("download-only");
  });

  test("install tool uses promoted trust tier", async () => {
    const backends = createTestBackends();
    const provider = createRegistryProvider(backends);
    const agent = createMockAgent();
    const components = (await provider.attach(agent)) as ReadonlyMap<string, unknown>;

    const installTool = extractToolFromMap(components, "registry_install");
    expect(installTool.policy.sandbox).toBe(false);
  });

  test("read tools use verified trust tier by default", async () => {
    const backends = createTestBackends();
    const provider = createRegistryProvider(backends);
    const agent = createMockAgent();
    const components = (await provider.attach(agent)) as ReadonlyMap<string, unknown>;

    const searchTool = extractToolFromMap(components, "registry_search");
    const getTool = extractToolFromMap(components, "registry_get");
    const versionsTool = extractToolFromMap(components, "registry_list_versions");

    expect(searchTool.policy.sandbox).toBe(false);
    expect(getTool.policy.sandbox).toBe(false);
    expect(versionsTool.policy.sandbox).toBe(false);
  });

  test("custom prefix applies to all tool names", async () => {
    const backends = createTestBackends();
    const provider = createRegistryProvider({ ...backends, prefix: "reg" });
    const agent = createMockAgent();
    const components = (await provider.attach(agent)) as ReadonlyMap<string, unknown>;

    expect(components.has(toolToken("reg_search") as string)).toBe(true);
    expect(components.has(toolToken("reg_get") as string)).toBe(true);
    expect(components.has(toolToken("reg_list_versions") as string)).toBe(true);
    expect(components.has(toolToken("reg_install") as string)).toBe(true);
  });
});
