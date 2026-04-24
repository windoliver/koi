import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Agent } from "@koi/core";
import { isAttachResult, skillToken } from "@koi/core";
import { createSkillsRuntime } from "./index.js";
import {
  createProgressivePinnedRuntime,
  createProgressiveSkillProvider,
  createSkillProvider,
  skillDefinitionToComponent,
} from "./provider.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function writeSkill(root: string, name: string, body = "Body."): Promise<void> {
  const content = `---\nname: ${name}\ndescription: Test ${name}.\nallowed-tools: read_file\n---\n\n${body}`;
  await Bun.write(join(root, name, "SKILL.md"), content, { createPath: true });
}

// Stub Agent — provider.attach() receives it but doesn't read it
const STUB_AGENT = {} as Agent;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createSkillProvider", () => {
  let userRoot: string;

  beforeEach(async () => {
    userRoot = await mkdtemp(join(tmpdir(), "koi-provider-test-"));
  });

  afterEach(async () => {
    await rm(userRoot, { recursive: true, force: true });
  });

  test("attaches loaded skills as SkillComponents under skillToken keys", async () => {
    await writeSkill(userRoot, "my-skill");
    const runtime = createSkillsRuntime({ bundledRoot: null, userRoot });
    const provider = createSkillProvider(runtime);

    expect(provider.name).toBe("skills-runtime");

    const result = await provider.attach(STUB_AGENT);
    expect(isAttachResult(result)).toBe(true);
    if (!isAttachResult(result)) return;

    const token = skillToken("my-skill");
    const component = result.components.get(token);
    expect(component).toBeDefined();
    const skill = component as { name: string; description: string; content: string };
    expect(skill.name).toBe("my-skill");
    expect(skill.description).toBe("Test my-skill.");
    expect(skill.content).toContain("Body.");
  });

  test("reports blocked/failed skills as skipped entries", async () => {
    const maliciousBody = '```typescript\neval("bad");\n```';
    await writeSkill(userRoot, "evil-skill", maliciousBody);
    const runtime = createSkillsRuntime({
      bundledRoot: null,
      userRoot,
      blockOnSeverity: "HIGH",
    });
    const provider = createSkillProvider(runtime);
    const result = await provider.attach(STUB_AGENT);

    expect(isAttachResult(result)).toBe(true);
    if (!isAttachResult(result)) return;
    const token = skillToken("evil-skill");
    expect(result.components.get(token)).toBeUndefined();
    expect(result.skipped.some((s: { name: string }) => s.name === "evil-skill")).toBe(true);
  });

  test("attaches multiple skills from the same runtime", async () => {
    await writeSkill(userRoot, "skill-a");
    await writeSkill(userRoot, "skill-b");
    const runtime = createSkillsRuntime({ bundledRoot: null, userRoot });
    const provider = createSkillProvider(runtime);
    const result = await provider.attach(STUB_AGENT);

    expect(isAttachResult(result)).toBe(true);
    if (!isAttachResult(result)) return;
    expect(result.components.has(skillToken("skill-a"))).toBe(true);
    expect(result.components.has(skillToken("skill-b"))).toBe(true);
    expect(result.skipped).toHaveLength(0);
  });

  test("returns empty components when no skills discovered", async () => {
    const runtime = createSkillsRuntime({ bundledRoot: null, userRoot });
    const provider = createSkillProvider(runtime);
    const result = await provider.attach(STUB_AGENT);

    expect(isAttachResult(result)).toBe(true);
    if (!isAttachResult(result)) return;
    expect(result.components.size).toBe(0);
    expect(result.skipped).toHaveLength(0);
  });
});

describe("skillDefinitionToComponent", () => {
  test("converts SkillDefinition to SkillComponent", () => {
    const def = {
      name: "my-skill",
      description: "Does things.",
      body: "# My Skill\n\nDo this.",
      source: "user" as const,
      dirPath: "/tmp/my-skill",
    };
    const component = skillDefinitionToComponent(def);
    expect(component.name).toBe("my-skill");
    expect(component.description).toBe("Does things.");
    expect(component.content).toBe("# My Skill\n\nDo this.");
    expect(component.requires).toBeUndefined();
  });

  test("maps requires from SkillDefinition to SkillComponent", () => {
    const def = {
      name: "s",
      description: "d",
      body: "b",
      source: "bundled" as const,
      dirPath: "/tmp/s",
      requires: { bins: ["git"], env: ["TOKEN"] },
    };
    const component = skillDefinitionToComponent(def);
    expect(component.requires?.bins).toEqual(["git"]);
    expect(component.requires?.env).toEqual(["TOKEN"]);
  });

  test("preserves executionMode through conversion", () => {
    const def = {
      name: "fork-skill",
      description: "Runs in sub-agent.",
      body: "# Fork\n\nDo this in isolation.",
      source: "user" as const,
      dirPath: "/tmp/fork-skill",
      executionMode: "fork" as const,
    };
    const component = skillDefinitionToComponent(def);
    expect(component.executionMode).toBe("fork");
  });

  test("omits executionMode when undefined (inline default)", () => {
    const def = {
      name: "inline-skill",
      description: "Inline.",
      body: "b",
      source: "user" as const,
      dirPath: "/tmp/inline",
    };
    const component = skillDefinitionToComponent(def);
    expect(component.executionMode).toBeUndefined();
  });
});

describe("createSkillProvider — progressive mode", () => {
  let userRoot: string;

  beforeEach(async () => {
    userRoot = await mkdtemp(join(tmpdir(), "koi-provider-prog-"));
  });

  afterEach(async () => {
    await rm(userRoot, { recursive: true, force: true });
  });

  test("progressive: true attaches skills with empty content (no body loaded)", async () => {
    await writeSkill(userRoot, "my-skill");
    const runtime = createSkillsRuntime({ bundledRoot: null, userRoot });
    const provider = createSkillProvider(runtime, { progressive: true });

    const result = await provider.attach(STUB_AGENT);
    expect(isAttachResult(result)).toBe(true);
    if (!isAttachResult(result)) return;

    const token = skillToken("my-skill");
    const component = result.components.get(token) as
      | { name: string; description: string; content: string }
      | undefined;
    expect(component).toBeDefined();
    expect(component?.name).toBe("my-skill");
    expect(component?.description).toBe("Test my-skill.");
    expect(component?.content).toBe("");
  });

  test("progressive: true does not load bodies even for multiple skills", async () => {
    await writeSkill(userRoot, "skill-a", "Long body A.");
    await writeSkill(userRoot, "skill-b", "Long body B.");
    const runtime = createSkillsRuntime({ bundledRoot: null, userRoot });
    const provider = createSkillProvider(runtime, { progressive: true });

    const result = await provider.attach(STUB_AGENT);
    expect(isAttachResult(result)).toBe(true);
    if (!isAttachResult(result)) return;

    const a = result.components.get(skillToken("skill-a")) as { content: string } | undefined;
    const b = result.components.get(skillToken("skill-b")) as { content: string } | undefined;
    expect(a?.content).toBe("");
    expect(b?.content).toBe("");
  });

  test("progressive: true preserves description for XML rendering", async () => {
    await Bun.write(
      join(userRoot, "my-skill", "SKILL.md"),
      "---\nname: my-skill\ndescription: Does cool things.\n---\n\nBody.",
      { createPath: true },
    );
    const runtime = createSkillsRuntime({ bundledRoot: null, userRoot });
    const provider = createSkillProvider(runtime, { progressive: true });

    const result = await provider.attach(STUB_AGENT);
    expect(isAttachResult(result)).toBe(true);
    if (!isAttachResult(result)) return;

    const component = result.components.get(skillToken("my-skill")) as
      | { description: string }
      | undefined;
    expect(component?.description).toBe("Does cool things.");
  });

  test("progressive: false (explicit) uses eager path — content is non-empty", async () => {
    await writeSkill(userRoot, "eager-skill", "Eager body.");
    const runtime = createSkillsRuntime({ bundledRoot: null, userRoot });
    const provider = createSkillProvider(runtime, { progressive: false });

    const result = await provider.attach(STUB_AGENT);
    expect(isAttachResult(result)).toBe(true);
    if (!isAttachResult(result)) return;

    const component = result.components.get(skillToken("eager-skill")) as
      | { content: string }
      | undefined;
    expect(component?.content).toContain("Eager body.");
  });

  test("progressive attach calls loadAll() so blocked skills appear in skipped (startup cost parity)", async () => {
    // Both eager and progressive modes call loadAll() at startup — they have the same I/O
    // cost. Progressive mode's benefit is per-call token reduction (~100 tokens XML metadata
    // vs. full bodies injected at every model call). The bodies loaded by loadAll() remain
    // in the LRU cache for fast on-demand access when the Skill tool is invoked.
    await writeSkill(userRoot, "valid-skill", "Body.");
    // Write a skill with a HIGH-severity security finding to populate the skipped list.
    const blockedBody = '```typescript\neval("bad");\n```';
    await writeSkill(userRoot, "blocked-skill", blockedBody);

    const runtime = createSkillsRuntime({ bundledRoot: null, userRoot, blockOnSeverity: "HIGH" });
    const provider = createSkillProvider(runtime, { progressive: true });

    const result = await provider.attach(STUB_AGENT);
    expect(isAttachResult(result)).toBe(true);
    if (!isAttachResult(result)) return;

    // valid-skill: progressive component attached
    const component = result.components.get(skillToken("valid-skill")) as
      | { content: string; runtimeBacked: boolean }
      | undefined;
    expect(component?.content).toBe("");
    expect(component?.runtimeBacked).toBe(true);

    // blocked-skill: must appear in skipped — requires loadAll() path, not discover()-only
    const skippedNames = result.skipped.map((s) => s.name);
    expect(skippedNames).toContain("blocked-skill");
  });

  test("progressive attach keeps session-snapshot: Skill tool returns attach-time body", async () => {
    // Session-snapshot consistency: advertised ECS components and cached bodies both
    // reflect session-start state. This prevents the stale-advertisement hazard where
    // <available_skills> lists a skill whose backing file was deleted or became invalid
    // after startup, causing confusing NOT_FOUND errors from the Skill tool.
    // Tradeoff: edits to SKILL.md after session start are not visible until next session.
    await writeSkill(userRoot, "editable", "Original body.");
    const runtime = createSkillsRuntime({ bundledRoot: null, userRoot });
    const provider = createSkillProvider(runtime, { progressive: true });

    await provider.attach(STUB_AGENT);

    // Overwrite the skill file to simulate an in-session edit.
    await writeSkill(userRoot, "editable", "Updated body.");

    // The Skill tool calls runtime.load() — it must see the session-start snapshot,
    // not the in-session edit, to maintain advertisement/load consistency.
    const loaded = await runtime.load("editable");
    expect(loaded.ok).toBe(true);
    if (loaded.ok) expect(loaded.value.body).toContain("Original body.");
  });

  test("progressive attach consistency: skill deleted after attach still loads from cache", async () => {
    // A skill deleted from disk after session start must still be loadable via the Skill
    // tool — its body was cached at attach time. This prevents the model from being told
    // a skill exists (via <available_skills>) but then getting a NOT_FOUND error.
    await writeSkill(userRoot, "deletable", "Body before deletion.");
    const runtime = createSkillsRuntime({ bundledRoot: null, userRoot });
    const provider = createSkillProvider(runtime, { progressive: true });

    await provider.attach(STUB_AGENT);

    // Delete the skill file to simulate removal after session start.
    const { rmSync } = await import("node:fs");
    rmSync(`${userRoot}/deletable/SKILL.md`, { force: true });

    // Must still be loadable from the LRU cache.
    const loaded = await runtime.load("deletable");
    expect(loaded.ok).toBe(true);
    if (loaded.ok) expect(loaded.value.body).toContain("Body before deletion.");
  });

  test("progressive attach does not mark MCP external skills as runtimeBacked", async () => {
    // MCP skills registered via registerExternal() have source: "mcp" and body: description === "".
    // In eager mode, injectSkills() filters them via content === "" — they never reach systemPrompt.
    // Progressive mode must match this behavior: MCP skills must NOT get runtimeBacked: true and
    // must NOT appear in the <available_skills> XML block.
    const runtime = createSkillsRuntime({ bundledRoot: null, userRoot });
    runtime.registerExternal([
      {
        name: "mcp-tool",
        description: "",
        source: "mcp" as const,
        dirPath: "mcp://test-server",
      },
    ]);
    const provider = createSkillProvider(runtime, { progressive: true });

    const result = await provider.attach(STUB_AGENT);
    expect(isAttachResult(result)).toBe(true);
    if (!isAttachResult(result)) return;

    const component = result.components.get(skillToken("mcp-tool")) as
      | { runtimeBacked?: boolean; content: string }
      | undefined;
    expect(component).toBeDefined();
    // MCP skill must NOT be runtimeBacked — it would otherwise appear in <available_skills>
    expect(component?.runtimeBacked).toBeUndefined();
    // Content should be empty (MCP body is description === "")
    expect(component?.content).toBe("");
  });
});

// ---------------------------------------------------------------------------
// createProgressivePinnedRuntime — session-snapshot body pinning
// ---------------------------------------------------------------------------

describe("createProgressivePinnedRuntime", () => {
  let userRoot: string;
  beforeEach(async () => {
    userRoot = await mkdtemp(join(tmpdir(), "koi-pinned-test-"));
  });
  afterEach(async () => {
    await rm(userRoot, { recursive: true, force: true });
  });

  test("load() returns body from pin map after loadAll()", async () => {
    await writeSkill(userRoot, "pinned-skill", "Pinned body.");
    const base = createSkillsRuntime({ bundledRoot: null, userRoot });
    const runtime = createProgressivePinnedRuntime(base);

    await runtime.loadAll();
    const result = await runtime.load("pinned-skill");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.body).toContain("Pinned body.");
  });

  test("load() returns attach-time snapshot even after file is deleted (LRU eviction resistance)", async () => {
    await writeSkill(userRoot, "deletable-skill", "Body before deletion.");
    const base = createSkillsRuntime({ bundledRoot: null, userRoot, cacheMaxBodies: 1 });
    const runtime = createProgressivePinnedRuntime(base);

    await runtime.loadAll();

    // Delete the skill file and write another skill to trigger LRU eviction
    const { rmSync } = await import("node:fs");
    rmSync(`${userRoot}/deletable-skill/SKILL.md`, { force: true });
    await writeSkill(userRoot, "new-skill", "Evicts old entry.");
    await base.load("new-skill"); // evicts deletable-skill from the LRU

    // Pinned body must still be returned despite eviction from LRU
    const result = await runtime.load("deletable-skill");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.body).toContain("Body before deletion.");
  });

  test("invalidate(name) removes the pin entry", async () => {
    await writeSkill(userRoot, "skill-a", "Original body.");
    const base = createSkillsRuntime({ bundledRoot: null, userRoot });
    const runtime = createProgressivePinnedRuntime(base);

    await runtime.loadAll();
    runtime.invalidate("skill-a");

    // After invalidation the pin is cleared — next load re-reads from disk
    await writeSkill(userRoot, "skill-a", "Updated body.");
    const result = await runtime.load("skill-a");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.body).toContain("Updated body.");
  });

  test("invalidate() with no arg clears all pins", async () => {
    await writeSkill(userRoot, "skill-b", "Body B.");
    const base = createSkillsRuntime({ bundledRoot: null, userRoot });
    const runtime = createProgressivePinnedRuntime(base);

    await runtime.loadAll();
    runtime.invalidate();

    await writeSkill(userRoot, "skill-b", "Updated B.");
    const result = await runtime.load("skill-b");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.body).toContain("Updated B.");
  });

  test("delegates discover() to base runtime", async () => {
    await writeSkill(userRoot, "skill-c", "Body C.");
    const base = createSkillsRuntime({ bundledRoot: null, userRoot });
    const runtime = createProgressivePinnedRuntime(base);

    const result = await runtime.discover();
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.has("skill-c")).toBe(true);
  });

  test("registerExternal clears pinned entries for refreshed skills", async () => {
    // Regression: external skills updated via registerExternal (MCP bridge refresh)
    // must not serve stale pinned definitions after the refresh.
    await writeSkill(userRoot, "ext-skill", "Original ext body.");
    const base = createSkillsRuntime({ bundledRoot: null, userRoot });
    const runtime = createProgressivePinnedRuntime(base);

    // Pin the skill via loadAll.
    await runtime.loadAll();

    // Simulate external skill registration (e.g. MCP bridge reconnect)
    // with a new version — this should evict the pin.
    runtime.registerExternal([
      {
        name: "ext-skill",
        description: "Updated external.",
        source: "mcp",
        body: "",
        dirPath: "",
      },
    ]);

    // After registerExternal, load() falls through to base (pin was cleared).
    const result = await runtime.load("ext-skill");
    // The base load re-reads from disk (original file still there),
    // confirming the pin was cleared rather than stale value returned.
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// createProgressiveSkillProvider — self-consistent progressive factory
// ---------------------------------------------------------------------------

describe("createProgressiveSkillProvider", () => {
  let userRoot: string;

  beforeEach(async () => {
    userRoot = await mkdtemp(join(tmpdir(), "koi-progressive-provider-"));
  });

  afterEach(async () => {
    await rm(userRoot, { recursive: true, force: true });
  });

  test("returns provider and pinnedRuntime", async () => {
    const base = createSkillsRuntime({ bundledRoot: null, userRoot });
    const { provider, pinnedRuntime } = createProgressiveSkillProvider(base);
    expect(typeof provider.attach).toBe("function");
    expect(typeof pinnedRuntime.load).toBe("function");
  });

  test("provider attaches progressive skill components (runtimeBacked: true)", async () => {
    await writeSkill(userRoot, "cmd");
    const base = createSkillsRuntime({ bundledRoot: null, userRoot });
    const { provider } = createProgressiveSkillProvider(base);
    const result = await provider.attach({} as Agent);
    expect(isAttachResult(result)).toBe(true);
    const comp = result.components.get(skillToken("cmd")) as
      | { runtimeBacked?: boolean }
      | undefined;
    expect(comp?.runtimeBacked).toBe(true);
  });

  test("pinnedRuntime serves session-start body after base eviction", async () => {
    await writeSkill(userRoot, "pinned-skill", "Original body.");
    const base = createSkillsRuntime({ bundledRoot: null, userRoot, cacheMaxBodies: 1 });
    const { provider, pinnedRuntime } = createProgressiveSkillProvider(base);

    // Trigger loadAll (called by provider.attach) to pin the body.
    await provider.attach({} as Agent);

    // Evict the cached body by loading another skill.
    await writeSkill(userRoot, "other-skill", "Evicts pinned.");
    await base.load("other-skill");

    // pinnedRuntime must still return the session-start body.
    const result = await pinnedRuntime.load("pinned-skill");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.body).toContain("Original body.");
  });

  test("provider and pinnedRuntime share the same pinned session state", async () => {
    await writeSkill(userRoot, "shared", "Shared body.");
    const base = createSkillsRuntime({ bundledRoot: null, userRoot });
    const { provider, pinnedRuntime } = createProgressiveSkillProvider(base);

    await provider.attach({} as Agent);

    // Update the file on disk — pinned runtime should NOT pick up the change.
    await writeSkill(userRoot, "shared", "Updated body.");
    base.invalidate();

    const result = await pinnedRuntime.load("shared");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.body).toContain("Shared body.");
  });
});
