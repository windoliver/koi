/**
 * TDD tests for SkillsRuntime.query() and invalidate() — written before implementation (Issue 9A).
 *
 * Covers:
 * - No filter (returns all)
 * - Filter by source tier
 * - Filter by single tag
 * - Filter by multiple tags — AND semantics (all tags required)
 * - Skills with no tags excluded from tag filter
 * - Filter by capability (allowedTools)
 * - Empty result set
 * - Metadata available from query() without calling load()
 * - invalidate(name) clears body cache only
 * - invalidate() clears everything
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
  const content = `---\nname: ${name}\ndescription: Test ${name}.\n---\n\n# ${name}\n`;
  await Bun.write(join(root, name, "SKILL.md"), content, { createPath: true });
}

async function writeTaggedSkill(
  root: string,
  name: string,
  tags: readonly string[],
): Promise<void> {
  const tagsYaml = tags.map((t: string) => `  - ${t}`).join("\n");
  const content = `---\nname: ${name}\ndescription: Tagged ${name}.\ntags:\n${tagsYaml}\n---\n\n# ${name}\n`;
  await Bun.write(join(root, name, "SKILL.md"), content, { createPath: true });
}

async function writeCapabilitySkill(
  root: string,
  name: string,
  allowedTools: readonly string[],
): Promise<void> {
  const toolsYaml = allowedTools.join(" ");
  const content = `---\nname: ${name}\ndescription: Capable ${name}.\nallowed-tools: ${toolsYaml}\n---\n\n# ${name}\n`;
  await Bun.write(join(root, name, "SKILL.md"), content, { createPath: true });
}

// ---------------------------------------------------------------------------
// Tests: query()
// ---------------------------------------------------------------------------

describe("SkillsRuntime.query()", () => {
  let userRoot: string;
  let projectRoot: string;

  beforeEach(async () => {
    userRoot = await mkdtemp(join(tmpdir(), "koi-query-user-"));
    projectRoot = await mkdtemp(join(tmpdir(), "koi-query-project-"));
  });

  afterEach(async () => {
    await rm(userRoot, { recursive: true, force: true });
    await rm(projectRoot, { recursive: true, force: true });
  });

  test("returns all skills when called with no filter", async () => {
    await writeSkill(userRoot, "skill-a");
    await writeSkill(userRoot, "skill-b");
    const runtime = createSkillsRuntime({ bundledRoot: null, userRoot, projectRoot });

    const result = await runtime.query();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(2);
    const names = result.value.map((m: SkillMetadata) => m.name);
    expect(names).toContain("skill-a");
    expect(names).toContain("skill-b");
  });

  test("returns empty array when no skills exist", async () => {
    const runtime = createSkillsRuntime({ bundledRoot: null, userRoot, projectRoot });

    const result = await runtime.query();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(0);
  });

  test("returns empty array with empty filter object", async () => {
    const runtime = createSkillsRuntime({ bundledRoot: null, userRoot, projectRoot });

    const result = await runtime.query({});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(0);
  });

  test("filters by source tier — user only", async () => {
    await writeSkill(userRoot, "user-skill");
    await writeSkill(projectRoot, "project-skill");
    const runtime = createSkillsRuntime({ bundledRoot: null, userRoot, projectRoot });

    const result = await runtime.query({ source: "user" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(1);
    expect(result.value[0]?.name).toBe("user-skill");
    expect(result.value[0]?.source).toBe("user");
  });

  test("filters by source tier — project only", async () => {
    await writeSkill(userRoot, "user-skill");
    await writeSkill(projectRoot, "project-skill");
    const runtime = createSkillsRuntime({ bundledRoot: null, userRoot, projectRoot });

    const result = await runtime.query({ source: "project" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(1);
    expect(result.value[0]?.name).toBe("project-skill");
  });

  test("filters by single tag", async () => {
    await writeTaggedSkill(userRoot, "tagged-a", ["refactor", "typescript"]);
    await writeTaggedSkill(userRoot, "tagged-b", ["refactor"]);
    await writeSkill(userRoot, "untagged");
    const runtime = createSkillsRuntime({ bundledRoot: null, userRoot, projectRoot });

    const result = await runtime.query({ tags: ["refactor"] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(2);
    const names = result.value.map((m: SkillMetadata) => m.name);
    expect(names).toContain("tagged-a");
    expect(names).toContain("tagged-b");
    expect(names).not.toContain("untagged");
  });

  test("multi-tag filter uses AND semantics — skill must have ALL specified tags", async () => {
    await writeTaggedSkill(userRoot, "both-tags", ["refactor", "typescript"]);
    await writeTaggedSkill(userRoot, "one-tag", ["refactor"]);
    const runtime = createSkillsRuntime({ bundledRoot: null, userRoot, projectRoot });

    const result = await runtime.query({ tags: ["refactor", "typescript"] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(1);
    expect(result.value[0]?.name).toBe("both-tags");
  });

  test("skills with no tags are excluded from tag filter results", async () => {
    await writeSkill(userRoot, "no-tags");
    const runtime = createSkillsRuntime({ bundledRoot: null, userRoot, projectRoot });

    const result = await runtime.query({ tags: ["any-tag"] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(0);
  });

  test("empty tags array in filter returns all skills (treated as no tag filter)", async () => {
    await writeSkill(userRoot, "skill-a");
    const runtime = createSkillsRuntime({ bundledRoot: null, userRoot, projectRoot });

    const result = await runtime.query({ tags: [] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(1);
  });

  test("filters by capability (allowedTools)", async () => {
    await writeCapabilitySkill(userRoot, "tool-skill", ["read_file", "write_file"]);
    await writeSkill(userRoot, "no-tools");
    const runtime = createSkillsRuntime({ bundledRoot: null, userRoot, projectRoot });

    const result = await runtime.query({ capability: "read_file" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(1);
    expect(result.value[0]?.name).toBe("tool-skill");
  });

  test("returns empty array when capability not found in any skill", async () => {
    await writeSkill(userRoot, "no-tools-skill");
    const runtime = createSkillsRuntime({ bundledRoot: null, userRoot, projectRoot });

    const result = await runtime.query({ capability: "nonexistent_tool" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(0);
  });

  test("metadata is available from query() without calling load() (progressive loading)", async () => {
    await writeTaggedSkill(userRoot, "meta-skill", ["tag1", "tag2"]);
    const runtime = createSkillsRuntime({ bundledRoot: null, userRoot, projectRoot });

    // Do NOT call load() — query() alone should return full frontmatter metadata
    const result = await runtime.query();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const skill = result.value.find((m: SkillMetadata) => m.name === "meta-skill");
    expect(skill).toBeDefined();
    expect(skill?.description).toBe("Tagged meta-skill.");
    expect(skill?.tags).toContain("tag1");
    expect(skill?.tags).toContain("tag2");
    expect(skill?.source).toBe("user");
    // SkillMetadata has no 'body' field — body is only on SkillDefinition
    expect(Object.keys(skill ?? {})).not.toContain("body");
  });

  test("query() auto-runs discover() if not yet called", async () => {
    await writeSkill(userRoot, "auto-discover");
    const runtime = createSkillsRuntime({ bundledRoot: null, userRoot, projectRoot });

    const result = await runtime.query();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.some((m: SkillMetadata) => m.name === "auto-discover")).toBe(true);
  });

  test("combining source and tags filters together", async () => {
    await writeTaggedSkill(userRoot, "user-typed", ["typescript"]);
    await writeTaggedSkill(projectRoot, "project-typed", ["typescript"]);
    const runtime = createSkillsRuntime({ bundledRoot: null, userRoot, projectRoot });

    const result = await runtime.query({ source: "user", tags: ["typescript"] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(1);
    expect(result.value[0]?.name).toBe("user-typed");
  });
});

// ---------------------------------------------------------------------------
// Tests: invalidate()
// ---------------------------------------------------------------------------

describe("SkillsRuntime.invalidate()", () => {
  let userRoot: string;

  beforeEach(async () => {
    userRoot = await mkdtemp(join(tmpdir(), "koi-invalidate-"));
  });

  afterEach(async () => {
    await rm(userRoot, { recursive: true, force: true });
  });

  test("invalidate(name) clears body cache for a specific skill", async () => {
    const content = `---\nname: my-skill\ndescription: Original.\n---\n\nOriginal body.`;
    await Bun.write(join(userRoot, "my-skill", "SKILL.md"), content, { createPath: true });

    const runtime = createSkillsRuntime({ bundledRoot: null, userRoot });

    const first = await runtime.load("my-skill");
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.body).toContain("Original body.");

    // Overwrite the file on disk
    const updated = `---\nname: my-skill\ndescription: Updated.\n---\n\nUpdated body.`;
    await Bun.write(join(userRoot, "my-skill", "SKILL.md"), updated);

    // Without invalidate, load returns stale cached result
    const stale = await runtime.load("my-skill");
    expect(stale.ok).toBe(true);
    if (!stale.ok) return;
    expect(stale.value.body).toContain("Original body.");

    // Invalidate the specific skill body cache
    runtime.invalidate("my-skill");

    // After invalidate, load re-reads from disk
    const fresh = await runtime.load("my-skill");
    expect(fresh.ok).toBe(true);
    if (!fresh.ok) return;
    expect(fresh.value.body).toContain("Updated body.");
    expect(fresh.value.description).toBe("Updated.");
  });

  test("invalidate(name) preserves discovery metadata", async () => {
    await Bun.write(
      join(userRoot, "my-skill", "SKILL.md"),
      `---\nname: my-skill\ndescription: Desc.\n---\n\nBody.`,
      { createPath: true },
    );

    const runtime = createSkillsRuntime({ bundledRoot: null, userRoot });
    await runtime.discover();

    runtime.invalidate("my-skill");

    // query() still works without re-discovering
    const result = await runtime.query();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.some((m: SkillMetadata) => m.name === "my-skill")).toBe(true);
  });

  test("invalidate() with no arg resets everything — next discover re-scans", async () => {
    await Bun.write(
      join(userRoot, "original-skill", "SKILL.md"),
      `---\nname: original-skill\ndescription: Original.\n---\n\nBody.`,
      { createPath: true },
    );

    const runtime = createSkillsRuntime({ bundledRoot: null, userRoot });

    const first = await runtime.discover();
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.has("original-skill")).toBe(true);
    expect(first.value.has("new-skill")).toBe(false);

    // Add a new skill to disk after discovery
    await Bun.write(
      join(userRoot, "new-skill", "SKILL.md"),
      `---\nname: new-skill\ndescription: New.\n---\n\nBody.`,
      { createPath: true },
    );

    // Full invalidate — clears discovery cache
    runtime.invalidate();

    // Next discover re-scans and picks up the new skill
    const second = await runtime.discover();
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.has("original-skill")).toBe(true);
    expect(second.value.has("new-skill")).toBe(true);
  });

  test("full invalidate() clears all body caches", async () => {
    const original = `---\nname: my-skill\ndescription: Orig.\n---\n\nOrig body.`;
    await Bun.write(join(userRoot, "my-skill", "SKILL.md"), original, { createPath: true });

    const runtime = createSkillsRuntime({ bundledRoot: null, userRoot });
    await runtime.load("my-skill");

    // Overwrite on disk + full invalidate
    const updated = `---\nname: my-skill\ndescription: Updated.\n---\n\nUpdated body.`;
    await Bun.write(join(userRoot, "my-skill", "SKILL.md"), updated);
    runtime.invalidate();

    const result = await runtime.load("my-skill");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.body).toContain("Updated body.");
  });
});
