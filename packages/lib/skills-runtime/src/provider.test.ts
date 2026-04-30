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

async function writeSkillWithCredential(
  root: string,
  name: string,
  credKey: string,
): Promise<void> {
  const content = `---\nname: ${name}\ndescription: Test ${name}.\nrequires:\n  credentials:\n    primary:\n      kind: api_key\n      ref: ${credKey}\n---\n\nBody.`;
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

  test("attaches a skill whose credential ref is in scope (gov-15)", async () => {
    await writeSkillWithCredential(userRoot, "ok-skill", "openai_api_key");
    const runtime = createSkillsRuntime({ bundledRoot: null, userRoot });
    const credentials = {
      get: async (key: string): Promise<string | undefined> =>
        key === "openai_api_key" ? "sk-test" : undefined,
    };
    const provider = createSkillProvider(runtime, { credentials });
    const result = await provider.attach(STUB_AGENT);
    if (!isAttachResult(result)) throw new Error("expected AttachResult");
    expect(result.components.has(skillToken("ok-skill"))).toBe(true);
    expect(result.skipped).toHaveLength(0);
  });

  test("skips a skill whose credential ref is out of scope (gov-15)", async () => {
    await writeSkillWithCredential(userRoot, "blocked-skill", "stripe_secret");
    const runtime = createSkillsRuntime({ bundledRoot: null, userRoot });
    const credentials = {
      // Only openai_* is reachable; stripe_secret returns undefined → skip
      get: async (key: string): Promise<string | undefined> =>
        key.startsWith("openai_") ? "sk-test" : undefined,
    };
    const provider = createSkillProvider(runtime, { credentials });
    const result = await provider.attach(STUB_AGENT);
    if (!isAttachResult(result)) throw new Error("expected AttachResult");
    expect(result.components.has(skillToken("blocked-skill"))).toBe(false);
    const skip = result.skipped.find((s) => s.name === "blocked-skill");
    expect(skip).toBeDefined();
    // gov-15: reason must be the CONSTANT denial string. The skipped
    // reason is reachable by operators/telemetry, so it must not echo the
    // skill's required credential ref name (which would let an attacker
    // enumerate keys via skill discovery).
    expect(skip?.reason).toBe("credentials not in scope");
    expect(skip?.reason).not.toContain("stripe");
  });

  test("when no CredentialComponent is wired, skill credential requirements are not enforced (backwards-compat)", async () => {
    await writeSkillWithCredential(userRoot, "legacy-skill", "any_key");
    const runtime = createSkillsRuntime({ bundledRoot: null, userRoot });
    const provider = createSkillProvider(runtime);
    const result = await provider.attach(STUB_AGENT);
    if (!isAttachResult(result)) throw new Error("expected AttachResult");
    expect(result.components.has(skillToken("legacy-skill"))).toBe(true);
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

describe("createProgressiveSkillProvider — progressive attach behavior", () => {
  let userRoot: string;

  beforeEach(async () => {
    userRoot = await mkdtemp(join(tmpdir(), "koi-provider-prog-"));
  });

  afterEach(async () => {
    await rm(userRoot, { recursive: true, force: true });
  });

  test("attaches skills with empty content (no body loaded)", async () => {
    await writeSkill(userRoot, "my-skill");
    const base = createSkillsRuntime({ bundledRoot: null, userRoot });
    const { provider } = createProgressiveSkillProvider(base);

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

  test("does not load bodies even for multiple skills", async () => {
    await writeSkill(userRoot, "skill-a", "Long body A.");
    await writeSkill(userRoot, "skill-b", "Long body B.");
    const base = createSkillsRuntime({ bundledRoot: null, userRoot });
    const { provider } = createProgressiveSkillProvider(base);

    const result = await provider.attach(STUB_AGENT);
    expect(isAttachResult(result)).toBe(true);
    if (!isAttachResult(result)) return;

    const a = result.components.get(skillToken("skill-a")) as { content: string } | undefined;
    const b = result.components.get(skillToken("skill-b")) as { content: string } | undefined;
    expect(a?.content).toBe("");
    expect(b?.content).toBe("");
  });

  test("preserves description for XML rendering", async () => {
    await Bun.write(
      join(userRoot, "my-skill", "SKILL.md"),
      "---\nname: my-skill\ndescription: Does cool things.\n---\n\nBody.",
      { createPath: true },
    );
    const base = createSkillsRuntime({ bundledRoot: null, userRoot });
    const { provider } = createProgressiveSkillProvider(base);

    const result = await provider.attach(STUB_AGENT);
    expect(isAttachResult(result)).toBe(true);
    if (!isAttachResult(result)) return;

    const component = result.components.get(skillToken("my-skill")) as
      | { description: string }
      | undefined;
    expect(component?.description).toBe("Does cool things.");
  });

  test("calls loadAll() so blocked skills appear in skipped (startup cost parity)", async () => {
    // Both eager and progressive modes call loadAll() at startup — they have the same I/O
    // cost. Progressive mode's benefit is per-call token reduction (~100 tokens XML metadata
    // vs. full bodies injected at every model call). The bodies loaded by loadAll() remain
    // in the LRU cache for fast on-demand access when the Skill tool is invoked.
    await writeSkill(userRoot, "valid-skill", "Body.");
    // Write a skill with a HIGH-severity security finding to populate the skipped list.
    const blockedBody = '```typescript\neval("bad");\n```';
    await writeSkill(userRoot, "blocked-skill", blockedBody);

    const base = createSkillsRuntime({ bundledRoot: null, userRoot, blockOnSeverity: "HIGH" });
    const { provider } = createProgressiveSkillProvider(base);

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

  test("keeps session-snapshot: pinnedRuntime returns attach-time body after in-session edit", async () => {
    // Session-snapshot consistency: advertised ECS components and cached bodies both
    // reflect session-start state. This prevents the stale-advertisement hazard where
    // <available_skills> lists a skill whose backing file was deleted or became invalid
    // after startup, causing confusing NOT_FOUND errors from the Skill tool.
    // Tradeoff: edits to SKILL.md after session start are not visible until next session.
    await writeSkill(userRoot, "editable", "Original body.");
    const base = createSkillsRuntime({ bundledRoot: null, userRoot });
    const { provider, pinnedRuntime } = createProgressiveSkillProvider(base);

    await provider.attach(STUB_AGENT);

    // Overwrite the skill file to simulate an in-session edit.
    await writeSkill(userRoot, "editable", "Updated body.");

    // The Skill tool calls pinnedRuntime.load() — it must see the session-start snapshot,
    // not the in-session edit, to maintain advertisement/load consistency.
    const loaded = await pinnedRuntime.load("editable");
    expect(loaded.ok).toBe(true);
    if (loaded.ok) expect(loaded.value.body).toContain("Original body.");
  });

  test("skill deleted after attach still loads from pinned snapshot", async () => {
    // A skill deleted from disk after session start must still be loadable via the Skill
    // tool — its body was cached at attach time. This prevents the model from being told
    // a skill exists (via <available_skills>) but then getting a NOT_FOUND error.
    await writeSkill(userRoot, "deletable", "Body before deletion.");
    const base = createSkillsRuntime({ bundledRoot: null, userRoot });
    const { provider, pinnedRuntime } = createProgressiveSkillProvider(base);

    await provider.attach(STUB_AGENT);

    // Delete the skill file to simulate removal after session start.
    const { rmSync } = await import("node:fs");
    rmSync(`${userRoot}/deletable/SKILL.md`, { force: true });

    // Must still be loadable from the pinned session-snapshot map.
    const loaded = await pinnedRuntime.load("deletable");
    expect(loaded.ok).toBe(true);
    if (loaded.ok) expect(loaded.value.body).toContain("Body before deletion.");
  });

  test("does not mark MCP external skills as runtimeBacked", async () => {
    // MCP skills registered via registerExternal() have source: "mcp" and body: description === "".
    // In eager mode, injectSkills() filters them via content === "" — they never reach systemPrompt.
    // Progressive mode must match this behavior: MCP skills must NOT get runtimeBacked: true and
    // must NOT appear in the <available_skills> XML block.
    const base = createSkillsRuntime({ bundledRoot: null, userRoot });
    base.registerExternal([
      {
        name: "mcp-tool",
        description: "",
        source: "mcp" as const,
        dirPath: "mcp://test-server",
      },
    ]);
    const { provider } = createProgressiveSkillProvider(base);

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

  test("registerExternal preserves pinned entries — session-snapshot consistency", async () => {
    // Session-snapshot model: pinned entries must NOT be evicted on registerExternal.
    // Evicting would let load() return a different body than what was advertised in
    // <available_skills> at attach time, breaking the advertised-equals-loadable invariant.
    // Hosts that need live refresh should start a new session.
    await writeSkill(userRoot, "ext-skill", "Session-start body.");
    const base = createSkillsRuntime({ bundledRoot: null, userRoot });
    const runtime = createProgressivePinnedRuntime(base);

    // Pin the skill via loadAll (session start).
    await runtime.loadAll();

    // Simulate MCP bridge reconnect — should NOT evict the pin.
    runtime.registerExternal([
      {
        name: "ext-skill",
        description: "Updated external description.",
        source: "mcp",
        dirPath: "",
      },
    ]);

    // The pin must survive registerExternal — load() returns session-start body.
    const result = await runtime.load("ext-skill");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.body).toContain("Session-start body.");
  });

  test("clearPinnedBodies() empties pin map so loadAll() re-pins next call", async () => {
    // clearPinnedBodies is the session-reset primitive: clears session-local pins so the
    // next loadAll() (pinned.size === 0) re-populates fresh pins for the new session.
    await writeSkill(userRoot, "session-skill", "Session-start body.");
    const base = createSkillsRuntime({ bundledRoot: null, userRoot });
    const runtime = createProgressivePinnedRuntime(base);

    // Pin the skill via loadAll (session start).
    await runtime.loadAll();

    // Pins populated — load returns session-start body from pin map.
    const beforeClear = await runtime.load("session-skill");
    expect(beforeClear.ok && beforeClear.value.body).toContain("Session-start body.");

    // Clear pins (session reset path). Also calls base.invalidate(name) for each pin.
    runtime.clearPinnedBodies();

    // Pin map is now empty — next loadAll() re-pins fresh state.
    await writeSkill(userRoot, "session-skill", "Updated body.");
    await runtime.loadAll(); // re-pins with fresh disk state

    const afterRepopulate = await runtime.load("session-skill");
    expect(afterRepopulate.ok && afterRepopulate.value.body).toContain("Updated body.");
  });

  test("clearPinnedBodies() does a full base invalidation — discovery cache cleared", async () => {
    // clearPinnedBodies() calls base.invalidate() (full, no name) which clears the
    // discovery cache, body LRU, and external registrations (then replays externals).
    // After clear, the next loadAll() re-discovers filesystem skills, picking up
    // newly added or removed skills rather than serving the session-start snapshot.
    await writeSkill(userRoot, "existing-skill", "Existing body.");
    const base = createSkillsRuntime({ bundledRoot: null, userRoot });
    const runtime = createProgressivePinnedRuntime(base);

    // Pin via loadAll (session start).
    await runtime.loadAll();

    // Add a NEW skill after session start.
    await writeSkill(userRoot, "new-skill", "New skill body.");

    // Without clearing, the new skill is not discoverable (discovery cache preserved).
    const beforeClear = await runtime.discover();
    expect(beforeClear.ok).toBe(true);
    if (beforeClear.ok) expect(beforeClear.value.has("new-skill")).toBe(false);

    // After clearPinnedBodies(), discovery cache is cleared → re-discover picks up new skill.
    runtime.clearPinnedBodies();
    const afterClear = await runtime.discover();
    expect(afterClear.ok).toBe(true);
    if (afterClear.ok) expect(afterClear.value.has("new-skill")).toBe(true);
  });

  test("clearPinnedBodies() clears base LRU so pinned skills re-read from disk", async () => {
    // Full invalidation clears all body LRU entries, so even pinned skills return
    // fresh disk state after clearPinnedBodies() + loadAll().
    await writeSkill(userRoot, "pinned-skill", "Original body.");
    const base = createSkillsRuntime({ bundledRoot: null, userRoot });
    const runtime = createProgressivePinnedRuntime(base);

    // Pin via loadAll() (session start).
    await runtime.loadAll();

    // Edit the body on disk.
    await writeSkill(userRoot, "pinned-skill", "Updated body.");

    // Without clearing, the base LRU still has "Original body.".
    const cached = await base.load("pinned-skill");
    expect(cached.ok && cached.value.body).toContain("Original body.");

    // clearPinnedBodies() does base.invalidate() (full) → clears ALL base LRU entries.
    runtime.clearPinnedBodies();

    // Base LRU is now cleared — next load reads fresh from disk.
    const afterClear = await base.load("pinned-skill");
    expect(afterClear.ok && afterClear.value.body).toContain("Updated body.");
  });

  test("clearPinnedBodies() replays last registerExternal snapshot — honors replacement semantics", async () => {
    // SkillsRuntime.registerExternal() uses full-replacement semantics: each call replaces
    // the entire external set. The pinned wrapper preserves that contract: clearPinnedBodies()
    // replays only the most recent snapshot, not an accumulated union of all calls.
    // This prevents stale MCP skills from reappearing after a server disconnects.
    const base = createSkillsRuntime({ bundledRoot: null, userRoot });
    const runtime = createProgressivePinnedRuntime(base);

    // First batch registered (simulates server A connecting first).
    runtime.registerExternal([
      {
        name: "server-a-tool",
        description: "Tool from server A.",
        source: "mcp",
        dirPath: "mcp://a",
      },
    ]);
    // Second batch replaces the first (simulates server B's registration, or server A
    // disconnecting and B taking over with only its own skills).
    runtime.registerExternal([
      {
        name: "server-b-tool",
        description: "Tool from server B.",
        source: "mcp",
        dirPath: "mcp://b",
      },
    ]);

    // After clearPinnedBodies(), only the last snapshot is replayed — honoring replacement
    // semantics. Server A's tool is gone (matching what the base runtime would have had).
    runtime.clearPinnedBodies();
    const afterClear = await runtime.discover();
    expect(afterClear.ok).toBe(true);
    if (afterClear.ok) {
      expect(afterClear.value.has("server-b-tool")).toBe(true);
      expect(afterClear.value.has("server-a-tool")).toBe(false);
    }
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
    if (!isAttachResult(result)) throw new Error("Expected AttachResult");
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

  test("reload() clears pins and returns fresh component map with edited bodies", async () => {
    // reload() is the session-reset primitive: clears pinned bodies (+ base LRU
    // for pinned skills), re-runs loadAll(), and returns a typed SkillComponent map.
    await writeSkill(userRoot, "session-skill", "Original body.");
    const base = createSkillsRuntime({ bundledRoot: null, userRoot });
    const { provider, reload } = createProgressiveSkillProvider(base);

    // Session start: attach pins all skills via loadAll().
    await provider.attach({} as Agent);

    // Edit on disk.
    await writeSkill(userRoot, "session-skill", "Updated body.");

    // reload() picks up the update.
    const components = await reload();
    // component should be present and typed
    const token = `skill:session-skill` as never;
    const component = components.get(token);
    expect(component).toBeDefined();
    expect(component?.name).toBe("session-skill");
    expect(component?.runtimeBacked).toBe(true);
  });

  test("reload() returns empty map when all skills are skipped or none exist", async () => {
    const base = createSkillsRuntime({ bundledRoot: null, userRoot });
    const { provider, reload } = createProgressiveSkillProvider(base);

    await provider.attach({} as Agent);

    const components = await reload();
    expect(components.size).toBe(0);
  });

  test("reload() is transactional — restores previous pins and throws on discovery failure", async () => {
    // Simulate a failing base runtime so reload() encounters a discovery error.
    await writeSkill(userRoot, "stable-skill", "Session-start body.");
    const base = createSkillsRuntime({ bundledRoot: null, userRoot });

    let failNextLoadAll = false;
    const faultyBase = {
      ...base,
      loadAll: async () => {
        if (failNextLoadAll) {
          const err: import("@koi/core").KoiError = {
            code: "INTERNAL",
            message: "simulated discovery failure",
            retryable: false,
            context: {},
          };
          return { ok: false as const, error: err };
        }
        return base.loadAll();
      },
    };

    const { provider, pinnedRuntime, reload } = createProgressiveSkillProvider(faultyBase);

    // Session start — pins session-start body.
    await provider.attach({} as Agent);

    // Next reload will fail.
    failNextLoadAll = true;
    await expect(reload()).rejects.toThrow("simulated discovery failure");

    // After failed reload, pins are restored — Skill tool still serves session-start body.
    const loaded = await pinnedRuntime.load("stable-skill");
    expect(loaded.ok && loaded.value.body).toContain("Session-start body.");
  });

  test("MCP skill removed mid-session does not survive reload()", async () => {
    // Regression: removed MCP skills must not re-appear in the catalog after reload().
    // The base runtime re-applies only lastExternalSkills on clearPinnedBodies(), so
    // a skill removed via registerExternal() before reload() must be absent from fresh.
    const base = createSkillsRuntime({ bundledRoot: null, userRoot });
    const { provider, pinnedRuntime, reload } = createProgressiveSkillProvider(base);

    // Session start: server-A and server-B both connected.
    pinnedRuntime.registerExternal([
      { name: "mcp-skill-a", description: "Server A skill.", source: "mcp", dirPath: "" },
      { name: "mcp-skill-b", description: "Server B skill.", source: "mcp", dirPath: "" },
    ]);
    await provider.attach(STUB_AGENT);

    // Server A disconnects — bridge calls registerExternal without it.
    pinnedRuntime.registerExternal([
      { name: "mcp-skill-b", description: "Server B skill.", source: "mcp", dirPath: "" },
    ]);

    // reload() runs clearPinnedBodies() which re-applies lastExternalSkills (only server-B).
    const fresh = await reload();

    // Server-A skill must be absent from the refreshed catalog.
    const tokenA = skillToken("mcp-skill-a") as string;
    expect(fresh.has(tokenA as never)).toBe(false);

    // Server-B skill must still be present.
    const tokenB = skillToken("mcp-skill-b") as string;
    expect(fresh.has(tokenB as never)).toBe(true);
  });

  test("non-mcpBacked body-backed skill has mcpBacked: undefined after skillDefinitionToComponent", async () => {
    // Regression: body-backed root skills (browser, memory) must NOT get mcpBacked: true.
    // They use skillDefinitionToComponent without the mcpBacked flag, so the merge in
    // tui-command.ts preserves them across session resets while excluding removed MCP skills.
    await writeSkill(userRoot, "fs-skill", "Filesystem body.");
    const base = createSkillsRuntime({ bundledRoot: null, userRoot });
    const loaded = await base.load("fs-skill");
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;

    // Default (no mcpBacked flag) — browser/memory provider path.
    const comp = skillDefinitionToComponent(loaded.value);
    expect((comp as { mcpBacked?: boolean }).mcpBacked).toBeUndefined();

    // Explicit mcpBacked: true — skills-runtime MCP path.
    const mcpComp = skillDefinitionToComponent(loaded.value, true);
    expect((mcpComp as { mcpBacked?: boolean }).mcpBacked).toBe(true);
  });
});
