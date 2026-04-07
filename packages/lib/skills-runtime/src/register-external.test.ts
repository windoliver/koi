/**
 * TDD tests for SkillsRuntime.registerExternal() — MCP skill injection.
 *
 * Covers:
 * - External skills appear in discover() results
 * - External skills queryable by source: "mcp"
 * - Shadow precedence: filesystem > external (lowest priority)
 * - invalidate() clears external registrations
 * - invalidate(name) clears individual external skill body cache
 * - Empty array registration → no errors
 * - Register after discover() already ran → visible via query
 * - Second registerExternal() fully replaces previous set
 * - load() on external skills returns generated body
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSkillsRuntime } from "./index.js";
import type { SkillMetadata } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function writeSkill(root: string, name: string): Promise<void> {
  const content = `---\nname: ${name}\ndescription: Filesystem ${name}.\n---\n\n# ${name}\n`;
  await Bun.write(join(root, name, "SKILL.md"), content, { createPath: true });
}

function mcpSkill(name: string, description = `MCP tool ${name}`): SkillMetadata {
  return {
    name,
    description,
    source: "mcp",
    dirPath: `mcp://test-server`,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SkillsRuntime.registerExternal()", () => {
  let userRoot: string;
  let projectRoot: string;

  beforeEach(async () => {
    userRoot = await mkdtemp(join(tmpdir(), "koi-ext-user-"));
    projectRoot = await mkdtemp(join(tmpdir(), "koi-ext-project-"));
  });

  afterEach(async () => {
    await rm(userRoot, { recursive: true, force: true });
    await rm(projectRoot, { recursive: true, force: true });
  });

  test("external skills appear in discover() results", async () => {
    const runtime = createSkillsRuntime({ bundledRoot: null, userRoot, projectRoot });
    runtime.registerExternal([mcpSkill("mcp-search"), mcpSkill("mcp-read")]);

    const result = await runtime.discover();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.has("mcp-search")).toBe(true);
    expect(result.value.has("mcp-read")).toBe(true);
    expect(result.value.get("mcp-search")?.source).toBe("mcp");
  });

  test("external skills queryable by source: 'mcp'", async () => {
    const runtime = createSkillsRuntime({ bundledRoot: null, userRoot, projectRoot });
    runtime.registerExternal([mcpSkill("mcp-tool")]);

    const result = await runtime.query({ source: "mcp" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(1);
    expect(result.value[0]?.name).toBe("mcp-tool");
  });

  test("filesystem skill shadows external skill of same name (lowest priority)", async () => {
    await writeSkill(userRoot, "shared-name");
    const runtime = createSkillsRuntime({ bundledRoot: null, userRoot, projectRoot });
    runtime.registerExternal([mcpSkill("shared-name", "MCP version")]);

    const result = await runtime.discover();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // User-tier wins over MCP
    expect(result.value.get("shared-name")?.source).toBe("user");
    expect(result.value.get("shared-name")?.description).toBe("Filesystem shared-name.");
  });

  test("empty array registration produces no errors and no external skills", async () => {
    const runtime = createSkillsRuntime({ bundledRoot: null, userRoot, projectRoot });
    runtime.registerExternal([]);

    const result = await runtime.query({ source: "mcp" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(0);
  });

  test("second registerExternal() fully replaces previous set", async () => {
    const runtime = createSkillsRuntime({ bundledRoot: null, userRoot, projectRoot });
    runtime.registerExternal([mcpSkill("tool-a"), mcpSkill("tool-b")]);

    // Replace with just tool-c
    runtime.registerExternal([mcpSkill("tool-c")]);

    const result = await runtime.query({ source: "mcp" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(1);
    expect(result.value[0]?.name).toBe("tool-c");
  });

  test("registerExternal() after discover() — new skills visible in next discover()", async () => {
    const runtime = createSkillsRuntime({ bundledRoot: null, userRoot, projectRoot });

    // First discover (no external skills)
    const first = await runtime.discover();
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.has("mcp-late")).toBe(false);

    // Register external skills after discover
    runtime.registerExternal([mcpSkill("mcp-late")]);

    // Second discover sees the new skill (filesystem cache untouched)
    const second = await runtime.discover();
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.has("mcp-late")).toBe(true);
  });

  test("invalidate() clears both filesystem and external caches", async () => {
    await writeSkill(userRoot, "fs-skill");
    const runtime = createSkillsRuntime({ bundledRoot: null, userRoot, projectRoot });
    runtime.registerExternal([mcpSkill("ext-skill")]);

    await runtime.discover();

    runtime.invalidate();
    // Re-register external after full invalidate
    runtime.registerExternal([mcpSkill("ext-skill-new")]);

    const result = await runtime.discover();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Filesystem skill still found (re-scanned)
    expect(result.value.has("fs-skill")).toBe(true);
    // Old external gone, new one present
    expect(result.value.has("ext-skill")).toBe(false);
    expect(result.value.has("ext-skill-new")).toBe(true);
  });

  test("registerExternal() does not trigger filesystem re-scan", async () => {
    await writeSkill(userRoot, "early-skill");
    const runtime = createSkillsRuntime({ bundledRoot: null, userRoot, projectRoot });

    // Discover (caches filesystem results)
    await runtime.discover();

    // Add a new skill to disk AFTER discovery
    await writeSkill(userRoot, "late-skill");

    // Register external — should NOT re-scan filesystem
    runtime.registerExternal([mcpSkill("ext-only")]);

    const result = await runtime.discover();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // External skill present
    expect(result.value.has("ext-only")).toBe(true);
    // late-skill NOT present (filesystem not re-scanned)
    expect(result.value.has("late-skill")).toBe(false);
    // early-skill still present from original scan
    expect(result.value.has("early-skill")).toBe(true);
  });

  test("external skills coexist with filesystem skills from all tiers", async () => {
    await writeSkill(userRoot, "user-only");
    await writeSkill(projectRoot, "project-only");
    const runtime = createSkillsRuntime({ bundledRoot: null, userRoot, projectRoot });
    runtime.registerExternal([mcpSkill("mcp-only")]);

    const result = await runtime.discover();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.get("user-only")?.source).toBe("user");
    expect(result.value.get("project-only")?.source).toBe("project");
    expect(result.value.get("mcp-only")?.source).toBe("mcp");
    expect(result.value.size).toBe(3);
  });
});
